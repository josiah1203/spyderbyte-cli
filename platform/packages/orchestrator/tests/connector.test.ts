import { describe, expect, it } from 'vitest';
import {
  newSortableId,
  type ArtifactReference,
  type TenantRef,
} from '@agentic-platform/runtime-contracts';
import { LocalConnectorPublicationOrchestrator } from '../src/index.js';

const tenant: TenantRef = { tenantId: newSortableId(), workspaceId: newSortableId() };
const sourceArtifact: ArtifactReference = {
  schemaVersion: 1,
  tenant,
  artifactId: newSortableId(),
  version: 1,
  contentHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  mediaType: 'text/plain',
  sizeBytes: 1,
  createdAt: '2026-08-03T00:00:00.000Z',
};

const input = {
  tenant,
  sourceArtifact,
  connectorName: 'fixture-read-only',
  specification: { tools: ['list'] },
  requestedScopes: ['sandbox.read'],
  source: 'export async function list() { return []; }',
  authorAgentId: newSortableId(),
  publisherAgentId: newSortableId(),
  governanceApproved: true,
  humanApproved: true,
};

describe('LocalConnectorPublicationOrchestrator', () => {
  it('rebuilds deterministic connector material and publishes only after independent verification', async () => {
    const orchestrator = new LocalConnectorPublicationOrchestrator();
    const first = await orchestrator.prepare(input);
    const second = await orchestrator.prepare(input);

    expect(first.build.toolSchemas).toMatchObject([
      { name: 'list', inputSchema: { type: 'object', additionalProperties: false } },
    ]);
    expect(first.contractTests.passed).toBe(true);
    expect(first.build.sourceHash).toBe(second.build.sourceHash);
    expect(first.publicationDigest).toBe(second.publicationDigest);

    const published = await orchestrator.publish({
      ...input,
      approvalDigest: first.publicationDigest,
      commitApprovalDigest: first.publicationDigest,
    });
    expect(published.connector).toMatchObject({
      state: 'published',
      name: 'fixture-read-only',
      authorAgentId: input.authorAgentId,
    });
    expect(published.connector.approvalDigest).toBe(first.publicationDigest);
  });

  it('invalidates approval when source or dependency material changes', async () => {
    const orchestrator = new LocalConnectorPublicationOrchestrator();
    const prepared = await orchestrator.prepare(input);

    await expect(
      orchestrator.publish({
        ...input,
        source: `${input.source}\nexport const changed = true;`,
        approvalDigest: prepared.publicationDigest,
        commitApprovalDigest: prepared.publicationDigest,
      }),
    ).rejects.toThrow('no longer matches');

    await expect(
      orchestrator.publish({
        ...input,
        publisherAgentId: newSortableId(),
        approvalDigest: prepared.publicationDigest,
        commitApprovalDigest: prepared.publicationDigest,
      }),
    ).rejects.toThrow('no longer matches');

    await expect(
      orchestrator.prepare({
        ...input,
        specification: {
          tools: ['list'],
          dependencies: { fixture: 'https://example.invalid/fixture.tgz' },
        },
      }),
    ).rejects.toThrow('UNSAFE_DEPENDENCY');
  });

  it('keeps author and publisher separate and blocks secret-bearing source', async () => {
    const orchestrator = new LocalConnectorPublicationOrchestrator();
    const sameActorInput = { ...input, publisherAgentId: input.authorAgentId };
    const sameActor = await orchestrator.prepare(sameActorInput);
    await expect(
      orchestrator.publish({
        ...sameActorInput,
        approvalDigest: sameActor.publicationDigest,
        commitApprovalDigest: sameActor.publicationDigest,
      }),
    ).rejects.toThrow('cannot publish its own package');

    await expect(
      orchestrator.prepare({
        ...input,
        source: 'const apiKey = "not-a-safe-secret-value";',
      }),
    ).rejects.toThrow('SECRET_PATTERN');

    await expect(
      orchestrator.prepare({
        ...input,
        source:
          'import client from "unapproved-client"; export async function list() { return client.list(); }',
      }),
    ).rejects.toThrow('UNSAFE_SOURCE_DEPENDENCY');
  });
});
