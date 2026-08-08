import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  InMemoryEnterpriseControlPlane,
  InMemoryEnterpriseSecretManager,
  type EnterpriseDataLifecyclePort,
  type EnterpriseInferenceAdapter,
  type EnterpriseKeyManagementAdapter,
  type EnterpriseStorageAdapter,
} from '../src/index.js';
import {
  newSortableId,
  sha256Hash,
  type Actor,
  type HashSha256,
  type TenantRef,
} from '@agentic-platform/runtime-contracts';

const now = '2026-08-07T00:00:00.000Z';

function tenant(): TenantRef {
  return { tenantId: newSortableId(), workspaceId: newSortableId() };
}

function hashBytes(content: Uint8Array): HashSha256 {
  return sha256Hash(createHash('sha256').update(content).digest('hex'));
}

describe('Phase 10 enterprise and government control plane', () => {
  it('keeps government data in-region and runs the unchanged product contract on customer adapters', async () => {
    const inputTenant = tenant();
    const owner: Actor = {
      actorId: newSortableId(),
      type: 'human',
      displayName: 'Government owner',
    };
    const operator: Actor = {
      actorId: newSortableId(),
      type: 'human',
      displayName: 'Private operator',
    };
    const approver: Actor = {
      actorId: newSortableId(),
      type: 'human',
      displayName: 'Security approver',
    };
    const secretManager = new InMemoryEnterpriseSecretManager(() => now);
    secretManager.putSecret({
      tenant: inputTenant,
      secretName: 'enterprise-inference',
      value: 'customer-vault-token',
      now,
    });
    const stored = new Map<string, Uint8Array>();
    const inferenceCalls: string[] = [];
    const computeCalls: string[] = [];
    const keyCalls: string[] = [];
    const inference: EnterpriseInferenceAdapter = {
      adapterId: 'customer-inference-gov',
      async complete(input) {
        inferenceCalls.push(input.credential);
        return { text: 'customer-government-result', inputTokens: 12, outputTokens: 4 };
      },
    };
    const compute = {
      adapterId: 'customer-compute-gov',
      async execute(input: { readonly runner: { readonly kind: string } }) {
        computeCalls.push(input.runner.kind);
        return {
          receiptId: newSortableId(),
          state: 'succeeded' as const,
          externalExecutionId: 'on-prem-job-1',
          region: 'us-gov-west-1',
        };
      },
    };
    const storage: EnterpriseStorageAdapter = {
      adapterId: 'customer-storage-gov',
      async put(input) {
        stored.set(input.objectKey, new Uint8Array(input.content));
        return {
          objectKey: input.objectKey,
          contentHash: hashBytes(input.content),
          sizeBytes: input.content.byteLength,
        };
      },
    };
    const keyManagement: EnterpriseKeyManagementAdapter = {
      adapterId: 'customer-government-hsm',
      async encrypt(input) {
        keyCalls.push(input.key.keyId);
        return {
          ciphertext: new Uint8Array(input.plaintext),
          keyId: input.key.keyId,
          region: input.region,
          encryptionContextDigest: sha256Hash('b'.repeat(64)),
        };
      },
    };
    const lifecycle: EnterpriseDataLifecyclePort = {
      async inventory(tenantRef) {
        const counts = {
          authoritative: 2,
          artifacts: 1,
          events: 2,
          outbox: 0,
          projections: 1,
          audit: 3,
          connector_handles: 0,
          backups: 1,
        } as const;
        return {
          schemaVersion: 1 as const,
          tenant: tenantRef,
          observedAt: now,
          retentionPolicyVersion: 'gov-retention.v1',
          counts,
          totalBytes: 128,
          digest: sha256Hash('a'.repeat(64)),
        };
      },
      async deleteBatch(input) {
        return {
          tenant: input.tenant,
          deletionId: input.deletionId,
          cursor: input.cursor,
          deleted: 10,
          remaining: 0,
        };
      },
    };
    const controlPlane = new InMemoryEnterpriseControlPlane({ clock: () => now, lifecycle });
    const profile = controlPlane.registerProfile({
      tenant: inputTenant,
      name: 'Government production boundary',
      deploymentMode: 'private_kubernetes',
      allowedDeploymentModes: ['private_kubernetes', 'on_premise', 'customer_cloud'],
      complianceProfile: 'government',
      residency: {
        homeRegion: 'us-gov-west-1',
        allowedRegions: ['us-gov-west-1'],
        blockedRegions: ['us-east-1'],
        noCrossRegionReplication: true,
        allowedDataClasses: ['public', 'internal', 'confidential', 'restricted'],
        requireCustomerManagedKey: true,
        retentionDays: 30,
        policyVersion: 'gov-retention.v1',
      },
      customerManagedKey: {
        keyId: 'gov-cmk-1',
        provider: 'government_hsm',
        keyUri: 'hsm://customer/gov-cmk-1',
        region: 'us-gov-west-1',
        rotationVersion: 'v3',
      },
      createdBy: owner,
      now,
    });
    expect(profile.customerManagedKey?.keyUri).toBe('hsm://customer/gov-cmk-1');

    const account = controlPlane.issueServiceAccount({
      tenant: inputTenant,
      name: 'private-runner-agent',
      scopes: ['run.*', 'runner.read'],
      roles: ['operator'],
      createdBy: owner,
      now,
    });
    expect(account.accessToken).toHaveLength(43);
    expect(JSON.stringify(account.serviceAccount)).not.toContain('customer-vault-token');
    expect(
      controlPlane.authenticateServiceAccount(account.accessToken, inputTenant, now).accountId,
    ).toBe(account.serviceAccount.accountId);

    controlPlane.bindRole({
      tenant: inputTenant,
      principalId: operator.actorId,
      principalType: 'human',
      role: 'operator',
      conditions: {
        groups: ['ml-team'],
        regions: ['us-gov-west-1'],
        environments: ['production'],
        dataClasses: ['restricted'],
      },
      createdBy: owner,
      now,
    });
    const deniedAbac = controlPlane.authorize(
      {
        tenant: inputTenant,
        principal: {
          principalId: operator.actorId,
          principalType: 'human',
          groups: ['analyst-team'],
        },
        action: 'run.execute',
        resourceKind: 'run',
        resourceId: newSortableId(),
        context: {
          region: 'us-gov-west-1',
          dataClassification: 'restricted',
          environment: 'production',
        },
      },
      now,
    );
    expect(deniedAbac).toMatchObject({
      outcome: 'denied',
      reasonCodes: ['attribute_mismatch', 'permission_missing'],
    });
    const allowedAbac = controlPlane.authorize(
      {
        tenant: inputTenant,
        principal: { principalId: operator.actorId, principalType: 'human', groups: ['ml-team'] },
        action: 'run.execute',
        resourceKind: 'run',
        resourceId: newSortableId(),
        context: {
          region: 'us-gov-west-1',
          dataClassification: 'restricted',
          environment: 'production',
        },
      },
      now,
    );
    expect(allowedAbac.outcome).toBe('allowed');
    expect(
      controlPlane.authorize(
        {
          tenant: inputTenant,
          principal: { principalId: operator.actorId, principalType: 'human', groups: ['ml-team'] },
          action: 'run.execute',
          resourceKind: 'run',
          resourceId: newSortableId(),
          context: {
            region: 'us-east-1',
            dataClassification: 'restricted',
            environment: 'production',
          },
        },
        now,
      ).outcome,
    ).toBe('denied');

    const adapterSet = controlPlane.registerAdapterSet({
      tenant: inputTenant,
      deploymentMode: 'private_kubernetes',
      ownership: 'customer_owned',
      regions: ['us-gov-west-1'],
      approved: true,
      approvalReference: 'ATO-2026-001',
      inference,
      compute,
      storage,
      keyManagement,
      vault: {
        adapterId: 'customer-vault-gov',
        issue: (input) => secretManager.issue(input),
        resolve: (input) => secretManager.resolve(input),
        revoke: (handleId) => secretManager.revoke(handleId),
      },
      registeredBy: owner,
      now,
    });
    const runner = controlPlane.registerRunner({
      tenant: inputTenant,
      kind: 'private_kubernetes',
      region: 'us-gov-west-1',
      adapterSetId: adapterSet.adapterSetId,
      capabilities: ['gpu', 'private-egress', 'fips'],
      customerOwned: true,
      privateNetwork: true,
      approvalReference: 'ATO-2026-001',
      registeredBy: owner,
      now,
    });
    const result = await controlPlane.run({
      schemaVersion: 1,
      runId: newSortableId(),
      tenant: inputTenant,
      actor: owner,
      requestedAction: 'generate-government-report',
      modelId: 'customer-model-v1',
      prompt: 'Produce the approved report.',
      maxOutputTokens: 64,
      outputMediaType: 'text/plain',
      dataClassification: 'restricted',
      environment: 'production',
      region: 'us-gov-west-1',
      adapterSetId: adapterSet.adapterSetId,
      runnerId: runner.runnerId,
      idempotencyKey: `phase10-${newSortableId()}`,
    });
    expect(result.state).toBe('succeeded');
    expect(result.artifact.contentHash).toBe(
      hashBytes(new TextEncoder().encode(result.output.text)),
    );
    expect(inferenceCalls).toEqual(['customer-vault-token']);
    expect(computeCalls).toEqual(['private_kubernetes']);
    expect(keyCalls).toEqual(['gov-cmk-1']);
    expect([...stored.values()]).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('customer-vault-token');

    for (const [kind, deploymentMode] of [
      ['on_premise', 'on_premise'],
      ['customer_cloud', 'customer_cloud'],
    ] as const) {
      const set = controlPlane.registerAdapterSet({
        tenant: inputTenant,
        deploymentMode,
        ownership: 'customer_owned',
        regions: ['us-gov-west-1'],
        approved: true,
        approvalReference: `ATO-${kind}`,
        inference,
        compute,
        storage,
        keyManagement,
        vault: {
          adapterId: 'customer-vault-gov',
          issue: (input) => secretManager.issue(input),
          resolve: (input) => secretManager.resolve(input),
          revoke: (handleId) => secretManager.revoke(handleId),
        },
        registeredBy: owner,
        now,
      });
      const registeredRunner = controlPlane.registerRunner({
        tenant: inputTenant,
        kind,
        region: 'us-gov-west-1',
        adapterSetId: set.adapterSetId,
        capabilities: ['private-egress'],
        customerOwned: true,
        privateNetwork: true,
        approvalReference: `ATO-${kind}`,
        registeredBy: owner,
        now,
      });
      expect(registeredRunner.kind).toBe(kind);
    }
    expect(controlPlane.listRunners(inputTenant).map((entry) => entry.kind)).toEqual([
      'private_kubernetes',
      'on_premise',
      'customer_cloud',
    ]);

    const hold = await controlPlane.createLegalHold({
      tenant: inputTenant,
      matterReference: 'CASE-10-001',
      reason: 'Preserve government audit material',
      createdBy: owner,
      now,
    });
    controlPlane.bindRole({
      tenant: inputTenant,
      principalId: approver.actorId,
      principalType: 'human',
      role: 'security_admin',
      createdBy: owner,
      now,
    });
    const heldPlan = await controlPlane.requestDeletion({
      tenant: inputTenant,
      reason: 'Tenant closure',
      batchSize: 100,
      requestedBy: owner,
      now,
    });
    expect(heldPlan.state).toBe('blocked_legal_hold');
    await controlPlane.releaseLegalHold({
      tenant: inputTenant,
      holdId: hold.holdId,
      releasedBy: owner,
      now,
    });
    const releasedPlan = controlPlane.getDeletionPlan(inputTenant, heldPlan.deletionId);
    expect(releasedPlan?.state).toBe('pending_approval');
    const approvedPlan = controlPlane.approveDeletion({
      tenant: inputTenant,
      deletionId: heldPlan.deletionId,
      approvedBy: approver,
      now,
    });
    expect(approvedPlan.state).toBe('approved');
    const completedPlan = await controlPlane.executeDeletion({
      tenant: inputTenant,
      deletionId: heldPlan.deletionId,
      now,
    });
    expect(completedPlan.state).toBe('completed');
    expect(completedPlan.tombstoneId).toBeDefined();

    const exported = await controlPlane.createExport({
      tenant: inputTenant,
      requestedBy: owner,
      records: {
        authoritative: { apiToken: 'Bearer secret-not-exported' },
        audit: [{ action: 'run.completed', runId: result.runId }],
      },
      now,
    });
    expect(exported.redacted).toBe(true);
    expect(JSON.stringify(exported)).not.toContain('secret-not-exported');
    const bundle = await controlPlane.createSupportBundle({
      tenant: inputTenant,
      requestedBy: owner,
      diagnostics: { authorization: 'Bearer support-secret', status: 'healthy' },
      now,
    });
    expect(bundle.redacted).toBe(true);
    expect(JSON.stringify(bundle)).not.toContain('support-secret');
    const commitments = controlPlane.setGovernmentCommitments({
      tenant: inputTenant,
      serviceHours: '24x7',
      supportResponseMinutes: 30,
      incidentNoticeHours: 1,
      recoveryPointObjectiveMinutes: 15,
      recoveryTimeObjectiveMinutes: 60,
      dataResidencyStatement: 'Customer data remains in the approved government region.',
      changedBy: owner,
      now,
    });
    expect(commitments.serviceHours).toBe('24x7');
    const evidence = controlPlane.generateProcurementEvidence({
      tenant: inputTenant,
      requestedBy: owner,
      now,
    });
    expect(evidence.controls.map((control) => control.controlId)).toContain(
      'adapter.customer_substitution',
    );
    expect(evidence.profileId).toBe(profile.profileId);

    const rotated = controlPlane.rotateServiceAccount({
      tenant: inputTenant,
      accountId: account.serviceAccount.accountId,
      rotatedBy: owner,
      now,
    });
    expect(() =>
      controlPlane.authenticateServiceAccount(account.accessToken, inputTenant, now),
    ).toThrow();
    expect(
      controlPlane.authenticateServiceAccount(rotated.accessToken, inputTenant, now).active,
    ).toBe(true);
    const revoked = controlPlane.revokeServiceAccount({
      tenant: inputTenant,
      accountId: account.serviceAccount.accountId,
      revokedBy: owner,
      now,
    });
    expect(revoked.active).toBe(false);
    expect(() =>
      controlPlane.authenticateServiceAccount(rotated.accessToken, inputTenant, now),
    ).toThrow();
  });

  it('does not permit a private profile to accept a hosted or cross-region adapter', () => {
    const inputTenant = tenant();
    const owner: Actor = { actorId: newSortableId(), type: 'human' };
    const controlPlane = new InMemoryEnterpriseControlPlane({ clock: () => now });
    controlPlane.registerProfile({
      tenant: inputTenant,
      name: 'Private commercial',
      deploymentMode: 'private_kubernetes',
      allowedDeploymentModes: ['private_kubernetes'],
      complianceProfile: 'commercial',
      residency: {
        homeRegion: 'eu-west-1',
        allowedRegions: ['eu-west-1'],
        blockedRegions: [],
        noCrossRegionReplication: true,
        allowedDataClasses: ['public', 'internal'],
        requireCustomerManagedKey: false,
        retentionDays: 7,
        policyVersion: 'private-retention.v1',
      },
      createdBy: owner,
      now,
    });
    const adapter = {
      adapterId: 'test',
      async complete() {
        return { text: 'ok', inputTokens: 1, outputTokens: 1 };
      },
    } satisfies EnterpriseInferenceAdapter;
    const storage = {
      adapterId: 'storage',
      async put(input: { readonly objectKey: string; readonly content: Uint8Array }) {
        return {
          objectKey: input.objectKey,
          contentHash: hashBytes(input.content),
          sizeBytes: input.content.byteLength,
        };
      },
    } satisfies EnterpriseStorageAdapter;
    const vault = new InMemoryEnterpriseSecretManager(() => now);
    vault.putSecret({
      tenant: inputTenant,
      secretName: 'enterprise-inference',
      value: 'value',
      now,
    });
    expect(() =>
      controlPlane.registerAdapterSet({
        tenant: inputTenant,
        deploymentMode: 'hosted',
        ownership: 'hosted',
        regions: ['eu-west-1'],
        approved: true,
        inference: adapter,
        compute: {
          adapterId: 'compute',
          async execute() {
            return {
              receiptId: newSortableId(),
              state: 'succeeded' as const,
              externalExecutionId: 'job',
              region: 'eu-west-1',
            };
          },
        },
        storage,
        vault: {
          adapterId: 'vault',
          issue: (input) => vault.issue(input),
          resolve: (input) => vault.resolve(input),
          revoke: (handleId) => vault.revoke(handleId),
        },
        registeredBy: owner,
        now,
      }),
    ).toThrow();
    expect(
      controlPlane.authorize(
        {
          tenant: inputTenant,
          principal: { principalId: owner.actorId, principalType: 'human' },
          action: 'run.execute',
          resourceKind: 'run',
          resourceId: newSortableId(),
          context: {
            region: 'us-east-1',
            dataClassification: 'internal',
            environment: 'production',
          },
        },
        now,
      ).outcome,
    ).toBe('denied');
  });
});
