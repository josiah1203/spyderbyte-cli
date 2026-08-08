import { describe, expect, it } from 'vitest';
import {
  newSortableId,
  type ArtifactReference,
  type TenantRef,
} from '@agentic-platform/runtime-contracts';
import {
  HostedCatalogBackend,
  InMemoryCatalogBackend,
  type HostedCatalogClient,
} from '../src/index.js';

const tenant: TenantRef = { tenantId: newSortableId(), workspaceId: newSortableId() };
const otherTenant: TenantRef = { tenantId: newSortableId(), workspaceId: newSortableId() };
const reference = 'catalog://fixture/customers';

function artifact(version: number, owner: TenantRef = tenant): ArtifactReference {
  return {
    schemaVersion: 1,
    tenant: owner,
    artifactId: newSortableId(),
    version,
    contentHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    mediaType: 'text/csv',
    sizeBytes: 12,
    createdAt: '2026-08-03T00:00:00.000Z',
    uri: reference,
  };
}

const schema = {
  version: 1,
  fields: [
    { name: 'id', type: 'integer', nullable: false },
    { name: 'email', type: 'string', nullable: true },
  ],
} as const;

describe('catalog backends', () => {
  it('resolves tenant-scoped dataset metadata, schemas, and newer versions', async () => {
    const catalog = new InMemoryCatalogBackend(tenant, {
      clock: () => '2026-08-03T00:01:00.000Z',
    });
    catalog.registerDataset({
      reference,
      name: 'customers',
      artifact: artifact(1),
      schema,
      classification: 'confidential',
      publishedAt: '2026-08-03T00:00:00.000Z',
    });
    expect((await catalog.resolveDataset(reference)).name).toBe('customers');
    expect((await catalog.readSchema(reference)).fields).toHaveLength(2);
    const publication = await catalog.publishDatasetVersion(artifact(2));
    expect(publication.artifact.version).toBe(2);
    expect((await catalog.resolveDataset(reference)).artifact.version).toBe(2);
    await expect(catalog.publishDatasetVersion(artifact(2))).rejects.toThrow('newer');
    await expect(catalog.publishDatasetVersion(artifact(3, otherTenant))).rejects.toThrow(
      'tenant scope',
    );
  });

  it('keeps hosted catalog calls behind the same contract and rejects foreign responses', async () => {
    const local = new InMemoryCatalogBackend(tenant);
    local.registerDataset({
      reference,
      name: 'customers',
      artifact: artifact(1),
      schema,
      classification: 'confidential',
    });
    const client: HostedCatalogClient = {
      resolveDataset: ({ reference: value }) => local.resolveDataset(value),
      readSchema: ({ reference: value }) => local.readSchema(value),
      publishDatasetVersion: ({ artifact: value }) => local.publishDatasetVersion(value),
    };
    const hosted = new HostedCatalogBackend({ tenant, client });
    expect((await hosted.resolveDataset(reference)).reference).toBe(reference);
    expect((await hosted.readSchema(reference)).version).toBe(1);
    expect((await hosted.publishDatasetVersion(artifact(2))).artifact.version).toBe(2);

    const foreign = new HostedCatalogBackend({
      tenant,
      client: {
        ...client,
        resolveDataset: async () => ({
          ...(await local.resolveDataset(reference)),
          tenant: otherTenant,
        }),
      },
    });
    await expect(foreign.resolveDataset(reference)).rejects.toThrow('invalid dataset');
  });
});
