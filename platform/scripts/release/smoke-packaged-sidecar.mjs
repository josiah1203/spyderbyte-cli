import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';

const root = resolve(new URL('../..', import.meta.url).pathname);
const binary = resolve(
  process.argv[2] ??
    join(root, 'apps/desktop/src-tauri/binaries/agentic-local-daemon-x86_64-apple-darwin'),
);

function newSortableId(now = Date.now()) {
  const bytes = randomBytes(16);
  let remaining = BigInt(now);
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function loadSmokeLicense() {
  const entitlementSource =
    process.env.AGENTIC_SMOKE_LICENSE_FILE ??
    join(root, 'apps/desktop/dev/development-entitlement.json');
  const publicKeySource =
    process.env.AGENTIC_SMOKE_LICENSE_PUBLIC_KEY_FILE ??
    join(root, 'apps/desktop/dev/development-public-key.txt');
  const keyIdSource =
    process.env.AGENTIC_SMOKE_LICENSE_KEY_ID_FILE ??
    join(root, 'apps/desktop/dev/development-key-id.txt');
  const entitlement = JSON.parse(readFileSync(entitlementSource, 'utf8'));
  const publicKey =
    process.env.AGENTIC_SMOKE_LICENSE_PUBLIC_KEY ?? readFileSync(publicKeySource, 'utf8').trim();
  const keyId =
    process.env.AGENTIC_SMOKE_LICENSE_KEY_ID ?? readFileSync(keyIdSource, 'utf8').trim();
  if (!isRecord(entitlement) || typeof publicKey !== 'string' || publicKey.trim().length === 0) {
    throw new Error(`Packaged smoke license inputs are invalid: ${entitlementSource}`);
  }
  if (entitlement.keyId !== keyId) {
    throw new Error(
      `Packaged smoke license key mismatch: entitlement=${String(entitlement.keyId)} key=${keyId}`,
    );
  }
  return { entitlement, publicKey, keyId };
}

async function request(address, token, path, method = 'GET', body, expectedStatus = 200) {
  const response = await fetch(`${address}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const responseText = await response.text();
  let responseBody;
  try {
    responseBody = JSON.parse(responseText);
  } catch {
    responseBody = responseText;
  }
  if (response.status !== expectedStatus) {
    throw new Error(
      `${method} ${path} returned ${response.status}: ${JSON.stringify(responseBody)}`,
    );
  }
  return responseBody;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function waitForReady(child) {
  return new Promise((resolveReady, reject) => {
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      reject(new Error(`Packaged sidecar did not become ready. stderr=${stderr}`));
    }, 15_000);
    const onData = (chunk) => {
      stdout += chunk.toString();
      for (const line of stdout.split('\n')) {
        try {
          const record = JSON.parse(line);
          if (record.ready === true && typeof record.address === 'string') {
            clearTimeout(timeout);
            resolveReady(record);
            return;
          }
        } catch {
          // The daemon may write partial JSON chunks; wait for the next newline.
        }
      }
      stdout = stdout.slice(stdout.lastIndexOf('\n') + 1);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      reject(
        new Error(
          `Packaged sidecar exited before readiness (code=${code}, signal=${signal}, stderr=${stderr})`,
        ),
      );
    });
  });
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((resolveStop) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      resolveStop();
    }, 2_000);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolveStop();
    });
  });
}

if (!existsSync(binary) || !statSync(binary).isFile() || statSync(binary).size === 0) {
  throw new Error(`Packaged sidecar is missing or empty: ${binary}`);
}

const smokeRoot = mkdtempSync(join(tmpdir(), 'agentic-local-release-smoke-'));
const workspaceRoot = join(smokeRoot, 'workspace');
const licensePath = join(smokeRoot, 'entitlement.json');
mkdirSync(dirname(workspaceRoot), { recursive: true });
const now = new Date().toISOString();
const license = loadSmokeLicense();
writeFileSync(licensePath, JSON.stringify(license.entitlement), { mode: 0o600 });
chmodSync(licensePath, 0o600);

let child;
try {
  child = spawn(binary, [], {
    cwd: root,
    env: {
      ...process.env,
      AGENTIC_WORKSPACE: workspaceRoot,
      AGENTIC_WORKSPACE_NAME: 'Release smoke workspace',
      AGENTIC_LICENSE_FILE: licensePath,
      AGENTIC_LICENSE_PUBLIC_KEY: license.publicKey,
      AGENTIC_LICENSE_KEY_ID: license.keyId,
      AGENTIC_LOCAL_API_HOST: '127.0.0.1',
      AGENTIC_LOCAL_API_PORT: '0',
      AGENTIC_LOCAL_API_AUTH_REQUIRED: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const ready = await waitForReady(child);
  if (typeof ready.authToken !== 'string')
    throw new Error('Packaged sidecar did not expose authToken');
  const tenant = ready.tenant;
  const actor = {
    actorId: newSortableId(),
    type: 'human',
    displayName: 'Release smoke reviewer',
  };

  const licenseStatus = await request(ready.address, ready.authToken, '/v1/license/status');
  if (licenseStatus.status !== 'valid') {
    throw new Error(
      `Packaged sidecar license status was not valid: ${JSON.stringify(licenseStatus)}`,
    );
  }
  await request(ready.address, ready.authToken, '/v1/session');
  const workspaceSummary = await request(ready.address, ready.authToken, '/v1/workspace');
  if (
    !isRecord(workspaceSummary.manifest) ||
    typeof workspaceSummary.manifest.workspaceId !== 'string'
  ) {
    throw new Error(
      `Packaged sidecar workspace metadata was incomplete: ${JSON.stringify(workspaceSummary)}`,
    );
  }
  const upload = await request(
    ready.address,
    ready.authToken,
    '/v1/artifacts/uploads',
    'POST',
    { content: 'id,value\n1,10\n2,20\n', mediaType: 'text/csv', now },
    201,
  );
  const sourceArtifactId = newSortableId();
  await request(
    ready.address,
    ready.authToken,
    `/v1/artifacts/${sourceArtifactId}/versions`,
    'POST',
    { stagedUploadId: upload.stagedUploadId, mediaType: 'text/csv', createdBy: actor, now },
    201,
  );

  const workflowId = newSortableId();
  const plan = await request(
    ready.address,
    ready.authToken,
    '/v1/commands/plan',
    'POST',
    {
      schemaVersion: 1,
      commandId: newSortableId(),
      commandType: 'ValidateDataset',
      tenant,
      actor,
      issuedAt: now,
      idempotencyKey: `release-smoke-${workflowId}`,
      correlationId: workflowId,
      payload: {
        sourceArtifactId,
        sourceArtifactVersion: 1,
        intendedUse: 'packaged Spyderbyte release smoke',
        requestedAccessScopes: ['dataset.read'],
        retentionDays: 30,
        requiredColumns: ['id', 'value'],
        expectedTypes: { id: 'number' },
        leakageThreshold: 0,
      },
    },
    200,
  );
  const approvalId = plan.approval?.approvalId;
  if (plan.planVersion !== 1 || typeof approvalId !== 'string') {
    throw new Error(`Packaged sidecar plan was not approval-bound: ${JSON.stringify(plan)}`);
  }
  const pending = await request(
    ready.address,
    ready.authToken,
    `/v1/workflows/${workflowId}/run`,
    'POST',
    {},
    202,
  );
  if (pending.status !== 'awaiting_approval') {
    throw new Error(`Packaged sidecar did not wait for approval: ${JSON.stringify(pending)}`);
  }
  const approved = await request(
    ready.address,
    ready.authToken,
    `/v1/approvals/${approvalId}/approve`,
    'POST',
    { reason: 'Release smoke approval' },
    202,
  );
  if (approved.request?.state !== 'approved') {
    throw new Error(`Packaged sidecar approval did not commit: ${JSON.stringify(approved)}`);
  }
  const completed = await request(
    ready.address,
    ready.authToken,
    `/v1/workflows/${workflowId}/run`,
    'POST',
    {},
    202,
  );
  if (completed.status !== 'completed') {
    throw new Error(`Packaged sidecar workflow did not complete: ${JSON.stringify(completed)}`);
  }
  const workflow = await request(ready.address, ready.authToken, `/v1/workflows/${workflowId}`);
  const events = await request(
    ready.address,
    ready.authToken,
    `/v1/workflows/${workflowId}/events`,
  );
  if (!isRecord(workflow) || !Array.isArray(events) || events.length === 0) {
    throw new Error(
      `Packaged sidecar workflow evidence was incomplete: ${JSON.stringify({ workflow, events })}`,
    );
  }
  const workflowProjection = await request(
    ready.address,
    ready.authToken,
    '/v1/projections/workflow-summary',
  );
  const workflowProjectionState =
    isRecord(workflowProjection) && isRecord(workflowProjection.state)
      ? workflowProjection.state
      : undefined;
  const projectedWorkflow =
    workflowProjectionState !== undefined && isRecord(workflowProjectionState.workflows)
      ? workflowProjectionState.workflows[workflowId]
      : undefined;
  if (!isRecord(projectedWorkflow)) {
    throw new Error(
      `Packaged sidecar workflow projection did not include ${workflowId}: ${JSON.stringify(workflowProjection)}`,
    );
  }

  const validatedArtifact = completed.validatedDatasetArtifact;
  if (
    !isRecord(validatedArtifact) ||
    typeof validatedArtifact.artifactId !== 'string' ||
    typeof validatedArtifact.version !== 'number'
  ) {
    throw new Error(
      `Packaged sidecar did not return a validated artifact reference: ${JSON.stringify(completed)}`,
    );
  }
  const artifact = await request(
    ready.address,
    ready.authToken,
    `/v1/artifacts/${validatedArtifact.artifactId}`,
  );
  const lineage = await request(
    ready.address,
    ready.authToken,
    `/v1/artifacts/${validatedArtifact.artifactId}/lineage`,
  );
  if (!isRecord(artifact) || !Array.isArray(lineage) || lineage.length === 0) {
    throw new Error(
      `Packaged sidecar artifact lineage was incomplete: ${JSON.stringify({ artifact, lineage })}`,
    );
  }
  const artifactProjection = await request(
    ready.address,
    ready.authToken,
    '/v1/projections/artifact-catalog-lineage',
  );
  const artifactProjectionState =
    isRecord(artifactProjection) && isRecord(artifactProjection.state)
      ? artifactProjection.state
      : undefined;
  if (
    artifactProjectionState === undefined ||
    !isRecord(artifactProjectionState.artifacts) ||
    !isRecord(artifactProjectionState.artifacts[validatedArtifact.artifactId])
  ) {
    throw new Error(
      `Packaged sidecar artifact projection did not include ${validatedArtifact.artifactId}: ${JSON.stringify(artifactProjection)}`,
    );
  }

  const exportPath = join(smokeRoot, 'workspace-export.agentic');
  const backupPath = join(smokeRoot, 'workspace-backup.agentic');
  const restoreRoot = join(smokeRoot, 'restored-workspace');
  const exported = await request(
    ready.address,
    ready.authToken,
    '/v1/workspace/export',
    'POST',
    { destinationPath: exportPath },
    201,
  );
  const backup = await request(
    ready.address,
    ready.authToken,
    '/v1/workspace/backup',
    'POST',
    { destinationPath: backupPath },
    201,
  );
  if (
    !existsSync(exportPath) ||
    statSync(exportPath).size === 0 ||
    !existsSync(backupPath) ||
    statSync(backupPath).size === 0
  ) {
    throw new Error(
      'Packaged sidecar did not create non-empty workspace export and backup archives',
    );
  }
  const restorePreview = await request(
    ready.address,
    ready.authToken,
    '/v1/workspace/restore-preview',
    'POST',
    { archivePath: exportPath, destinationRoot: restoreRoot },
  );
  if (restorePreview.destinationExists !== false) {
    throw new Error(
      `Packaged sidecar restore preview was not a clean destination: ${JSON.stringify(restorePreview)}`,
    );
  }
  const imported = await request(
    ready.address,
    ready.authToken,
    '/v1/workspace/import',
    'POST',
    { archivePath: exportPath, destinationRoot: restoreRoot },
    201,
  );
  if (
    imported.workspaceRoot !== restoreRoot ||
    imported.manifest?.workspaceId !== workspaceSummary.manifest.workspaceId
  ) {
    throw new Error(
      `Packaged sidecar workspace restore did not preserve identity: ${JSON.stringify(imported)}`,
    );
  }
  process.stdout.write(
    `${JSON.stringify({
      binary,
      license: licenseStatus.status,
      planVersion: plan.planVersion,
      pending: pending.status,
      approved: approved.request.state,
      completed: completed.status,
      projection: projectedWorkflow.state,
      lineageCount: lineage.length,
      exported: exported.archiveHash,
      backup: backup.archiveHash,
      restored: imported.workspaceRoot,
    })}\n`,
  );
} finally {
  if (child !== undefined) await stop(child);
  rmSync(smokeRoot, { recursive: true, force: true });
}
