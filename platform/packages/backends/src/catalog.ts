import {
  newSortableId,
  runtimeError,
  type ArtifactReference,
  type Id,
  type TenantRef,
} from '@agentic-platform/runtime-contracts';

export type DatasetClassification = 'public' | 'internal' | 'confidential' | 'pii';

export interface SchemaField {
  readonly name: string;
  readonly type: string;
  readonly nullable: boolean;
}

export interface SchemaDescriptor {
  readonly version: number;
  readonly fields: readonly SchemaField[];
}

export interface DatasetLineageEdgeV1 {
  readonly relation: 'derived-from' | 'synced-from' | 'queried-from';
  readonly sourceReference: string;
  readonly sourceVersion?: number;
  readonly sourceArtifactId?: Id;
}

export interface DatasetDescriptor {
  readonly reference: string;
  readonly tenant: TenantRef;
  readonly name: string;
  readonly artifact: ArtifactReference;
  readonly schema: SchemaDescriptor;
  readonly classification: DatasetClassification;
  readonly publishedAt: string;
  readonly immutable?: true;
  readonly lineage?: readonly DatasetLineageEdgeV1[];
}

export interface CatalogReference {
  readonly catalogId: Id;
  readonly tenant: TenantRef;
  readonly reference: string;
  readonly artifact: ArtifactReference;
  readonly publishedAt: string;
}

export interface CatalogBackend {
  resolveDataset(reference: string): Promise<DatasetDescriptor>;
  readSchema(reference: string): Promise<SchemaDescriptor>;
  publishDatasetVersion(artifact: ArtifactReference): Promise<CatalogReference>;
}

export interface VersionedCatalogBackend extends CatalogBackend {
  resolveDatasetVersion(reference: string, version: number): Promise<DatasetDescriptor>;
  listDatasetVersions(reference: string): Promise<readonly DatasetDescriptor[]>;
}

export interface DatasetRegistration {
  readonly reference: string;
  readonly name: string;
  readonly artifact: ArtifactReference;
  readonly schema: SchemaDescriptor;
  readonly classification: DatasetClassification;
  readonly publishedAt?: string;
  readonly lineage?: readonly DatasetLineageEdgeV1[];
}

function sameTenant(left: TenantRef | undefined, right: TenantRef): boolean {
  return left?.tenantId === right.tenantId && left?.workspaceId === right.workspaceId;
}

function assertTenant(left: TenantRef, right: TenantRef): void {
  if (!sameTenant(left, right))
    throw runtimeError('POLICY_DENIED', 'Catalog reference crosses tenant scope');
}

function assertString(value: string, name: string): void {
  if (value.trim().length === 0)
    throw runtimeError('VALIDATION_INVALID_INPUT', `${name} is required`);
}

function assertSchema(schema: SchemaDescriptor): SchemaDescriptor {
  if (!Number.isSafeInteger(schema.version) || schema.version < 1) {
    throw runtimeError('VALIDATION_INVALID_INPUT', 'Catalog schema version must be positive');
  }
  const names = new Set<string>();
  for (const field of schema.fields) {
    assertString(field.name, 'Catalog schema field name');
    assertString(field.type, `Catalog schema type for ${field.name}`);
    if (names.has(field.name))
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Catalog schema fields must be unique');
    names.add(field.name);
  }
  return structuredClone(schema);
}

function assertClassification(value: DatasetClassification): void {
  if (!['public', 'internal', 'confidential', 'pii'].includes(value)) {
    throw runtimeError('VALIDATION_INVALID_INPUT', 'Unknown dataset classification');
  }
}

function assertRegistration(
  tenant: TenantRef,
  registration: DatasetRegistration,
): DatasetDescriptor {
  assertString(registration.reference, 'Catalog dataset reference');
  assertString(registration.name, 'Catalog dataset name');
  assertTenant(tenant, registration.artifact.tenant);
  assertClassification(registration.classification);
  return {
    reference: registration.reference,
    tenant: structuredClone(tenant),
    name: registration.name,
    artifact: structuredClone(registration.artifact),
    schema: assertSchema(registration.schema),
    classification: registration.classification,
    publishedAt: registration.publishedAt ?? new Date().toISOString(),
    immutable: true,
    ...(registration.lineage === undefined
      ? {}
      : { lineage: structuredClone(registration.lineage) }),
  };
}

function assertHostedDataset(
  dataset: DatasetDescriptor,
  tenant: TenantRef,
  reference: string,
): DatasetDescriptor {
  if (
    dataset.reference !== reference ||
    !sameTenant(dataset.tenant, tenant) ||
    !sameTenant(dataset.artifact?.tenant, tenant)
  ) {
    throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'Hosted catalog returned an invalid dataset');
  }
  return {
    ...structuredClone(dataset),
    schema: assertSchema(dataset.schema),
  };
}

function assertHostedSchema(schema: SchemaDescriptor): SchemaDescriptor {
  try {
    return assertSchema(schema);
  } catch (error) {
    throw runtimeError(
      'VALIDATION_SCHEMA_MISMATCH',
      error instanceof Error ? error.message : 'Hosted catalog returned an invalid schema',
    );
  }
}

export class InMemoryCatalogBackend implements VersionedCatalogBackend {
  private readonly datasets = new Map<string, DatasetDescriptor>();
  private readonly versions = new Map<string, DatasetDescriptor[]>();
  private readonly clock: () => string;

  constructor(
    private readonly tenant: TenantRef,
    options: { readonly clock?: () => string } = {},
  ) {
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  registerDataset(registration: DatasetRegistration): DatasetDescriptor {
    const dataset = assertRegistration(this.tenant, registration);
    if (this.datasets.has(dataset.reference)) {
      throw runtimeError(
        'CONCURRENCY_STALE_VERSION',
        `Catalog dataset ${dataset.reference} is already registered`,
      );
    }
    this.datasets.set(dataset.reference, dataset);
    this.versions.set(dataset.reference, [dataset]);
    return structuredClone(dataset);
  }

  async resolveDataset(reference: string): Promise<DatasetDescriptor> {
    assertString(reference, 'Catalog dataset reference');
    const dataset = this.datasets.get(reference);
    if (dataset === undefined)
      throw runtimeError('ARTIFACT_NOT_FOUND', `Catalog dataset ${reference} was not found`);
    return structuredClone(dataset);
  }

  async readSchema(reference: string): Promise<SchemaDescriptor> {
    return (await this.resolveDataset(reference)).schema;
  }

  async publishDatasetVersion(artifact: ArtifactReference): Promise<CatalogReference> {
    assertTenant(this.tenant, artifact.tenant);
    const reference = artifact.uri;
    if (reference === undefined)
      throw runtimeError(
        'VALIDATION_INVALID_INPUT',
        'Catalog publication requires an artifact URI',
      );
    const current = this.datasets.get(reference);
    if (current === undefined)
      throw runtimeError('ARTIFACT_NOT_FOUND', `Catalog dataset ${reference} was not found`);
    if (artifact.version <= current.artifact.version) {
      throw runtimeError(
        'CONCURRENCY_STALE_VERSION',
        `Catalog dataset ${reference} requires a newer artifact version`,
      );
    }
    const publishedAt = this.clock();
    const next: DatasetDescriptor = {
      ...current,
      artifact: structuredClone(artifact),
      publishedAt,
      immutable: true,
      lineage: [
        ...(current.lineage ?? []),
        {
          relation: 'derived-from',
          sourceReference: reference,
          sourceVersion: current.artifact.version,
          sourceArtifactId: current.artifact.artifactId,
        },
      ],
    };
    this.datasets.set(reference, next);
    const history = this.versions.get(reference) ?? [];
    history.push(next);
    this.versions.set(reference, history);
    return {
      catalogId: newSortableId(),
      tenant: structuredClone(this.tenant),
      reference,
      artifact: structuredClone(artifact),
      publishedAt,
    };
  }

  async resolveDatasetVersion(reference: string, version: number): Promise<DatasetDescriptor> {
    assertString(reference, 'Catalog dataset reference');
    if (!Number.isSafeInteger(version) || version < 1) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Catalog dataset version must be positive');
    }
    const dataset = (this.versions.get(reference) ?? []).find(
      (candidate) => candidate.artifact.version === version,
    );
    if (dataset === undefined) {
      throw runtimeError(
        'ARTIFACT_NOT_FOUND',
        `Catalog dataset ${reference} version ${version} was not found`,
      );
    }
    return structuredClone(dataset);
  }

  async listDatasetVersions(reference: string): Promise<readonly DatasetDescriptor[]> {
    assertString(reference, 'Catalog dataset reference');
    if (!this.datasets.has(reference)) {
      throw runtimeError('ARTIFACT_NOT_FOUND', `Catalog dataset ${reference} was not found`);
    }
    return structuredClone(this.versions.get(reference) ?? []);
  }
}

export interface HostedCatalogClient {
  resolveDataset(request: {
    readonly tenant: TenantRef;
    readonly reference: string;
  }): Promise<DatasetDescriptor>;
  readSchema(request: {
    readonly tenant: TenantRef;
    readonly reference: string;
  }): Promise<SchemaDescriptor>;
  publishDatasetVersion(request: {
    readonly tenant: TenantRef;
    readonly artifact: ArtifactReference;
  }): Promise<CatalogReference>;
}

export class HostedCatalogBackend implements CatalogBackend {
  private readonly tenant: TenantRef;

  constructor(options: { readonly tenant: TenantRef; readonly client: HostedCatalogClient }) {
    this.tenant = options.tenant;
    this.client = options.client;
  }

  private readonly client: HostedCatalogClient;

  async resolveDataset(reference: string): Promise<DatasetDescriptor> {
    assertString(reference, 'Catalog dataset reference');
    return assertHostedDataset(
      await this.client.resolveDataset({ tenant: this.tenant, reference }),
      this.tenant,
      reference,
    );
  }

  async readSchema(reference: string): Promise<SchemaDescriptor> {
    assertString(reference, 'Catalog dataset reference');
    return assertHostedSchema(await this.client.readSchema({ tenant: this.tenant, reference }));
  }

  async publishDatasetVersion(artifact: ArtifactReference): Promise<CatalogReference> {
    assertTenant(this.tenant, artifact.tenant);
    const published = await this.client.publishDatasetVersion({
      tenant: this.tenant,
      artifact: structuredClone(artifact),
    });
    if (
      !sameTenant(published.tenant, this.tenant) ||
      !sameTenant(published.artifact?.tenant, this.tenant) ||
      published.artifact.artifactId !== artifact.artifactId ||
      published.artifact.version !== artifact.version ||
      published.artifact.contentHash !== artifact.contentHash
    ) {
      throw runtimeError(
        'VALIDATION_SCHEMA_MISMATCH',
        'Hosted catalog returned an invalid publication reference',
      );
    }
    return structuredClone(published);
  }
}
