import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createLicenseGate,
  createReloadingLicenseGateFromFileSync,
  createSignedEntitlement,
  type LicenseEntitlementV1,
  writeSignedEntitlementFileSync,
} from '../src/index.js';

const now = '2026-08-03T00:00:00.000Z';
const payload: LicenseEntitlementV1 = {
  schemaVersion: 1,
  licenseId: 'lic-local-test-001',
  product: 'agentic-ml-data-platform',
  edition: 'local',
  features: ['local.workflow', 'local.workspace.export'],
  issuedAt: '2026-08-01T00:00:00.000Z',
  expiresAt: '2026-09-01T00:00:00.000Z',
  subject: 'test-customer',
  maxWorkspaces: 3,
};

function gate(overrides: Partial<LicenseEntitlementV1> = {}, clock = () => now) {
  const keys = generateKeyPairSync('ed25519');
  const entitlement = createSignedEntitlement(
    { ...payload, ...overrides },
    { keyId: 'test-key', privateKey: keys.privateKey },
  );
  return createLicenseGate({ entitlement, publicKeys: { 'test-key': keys.publicKey }, clock });
}

describe('SignedLicenseGate', () => {
  it('validates a signed entitlement and exposes only safe metadata', () => {
    const license = gate();
    expect(license.status()).toMatchObject({
      status: 'valid',
      licenseId: payload.licenseId,
      edition: 'local',
      features: payload.features,
    });
    expect(license.status()).not.toHaveProperty('signature');
    expect(license.assertFeature('local.workflow').licenseId).toBe(payload.licenseId);
  });

  it('fails closed for tampering, unknown keys, expiry, and missing features', () => {
    const keys = generateKeyPairSync('ed25519');
    const signed = createSignedEntitlement(payload, {
      keyId: 'test-key',
      privateKey: keys.privateKey,
    });
    const tampered = {
      ...signed,
      payload: { ...signed.payload, edition: 'local' as const, licenseId: 'changed' },
    };
    expect(
      createLicenseGate({
        entitlement: tampered,
        publicKeys: { 'test-key': keys.publicKey },
        clock: () => now,
      }).status(),
    ).toMatchObject({ status: 'invalid', reason: 'invalid_signature' });
    expect(
      createLicenseGate({ entitlement: signed, publicKeys: {}, clock: () => now }).status(),
    ).toMatchObject({ status: 'invalid', reason: 'unknown_key' });
    expect(gate({ expiresAt: '2026-08-03T00:00:00.000Z' }).status()).toMatchObject({
      status: 'expired',
    });
    expect(() => gate({ features: [] }).assertFeature()).toThrow('does not include feature');
  });

  it('reports missing and not-yet-valid entitlements', () => {
    const missing = createLicenseGate({ clock: () => now });
    expect(missing.status()).toMatchObject({ status: 'missing', reason: 'missing' });
    expect(gate({ issuedAt: '2026-08-04T00:00:00.000Z' }).status()).toMatchObject({
      status: 'not_yet_valid',
    });
  });

  it('reloads an atomically imported entitlement without restarting the gate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentic-license-'));
    const filePath = join(root, 'entitlement.json');
    const keys = generateKeyPairSync('ed25519');
    const signed = createSignedEntitlement(payload, {
      keyId: 'test-key',
      privateKey: keys.privateKey,
    });
    try {
      writeSignedEntitlementFileSync(filePath, signed);
      const license = createReloadingLicenseGateFromFileSync(filePath, {
        publicKeys: { 'test-key': keys.publicKey },
        clock: () => now,
      });
      expect(license.status().status).toBe('valid');
      writeSignedEntitlementFileSync(filePath, {
        ...signed,
        payload: { ...signed.payload, expiresAt: '2026-08-03T00:00:00.000Z' },
      });
      expect(license.status()).toMatchObject({ status: 'invalid', reason: 'invalid_signature' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
