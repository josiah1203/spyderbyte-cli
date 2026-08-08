import {
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { runtimeError } from '@agentic-platform/runtime-contracts';

export const LICENSE_SCHEMA_VERSION = 1 as const;
export const LICENSE_PRODUCT = 'agentic-ml-data-platform' as const;
export const LICENSE_EDITION = 'local' as const;
export const DEFAULT_LOCAL_WORKFLOW_FEATURE = 'local.workflow' as const;

export type LicenseStatusKind = 'valid' | 'missing' | 'invalid' | 'expired' | 'not_yet_valid';

export type LicenseStatusReason =
  | 'valid'
  | 'missing'
  | 'unreadable'
  | 'malformed'
  | 'unknown_key'
  | 'invalid_signature'
  | 'not_yet_valid'
  | 'expired'
  | 'invalid_clock';

export interface LicenseEntitlementV1 {
  readonly schemaVersion: typeof LICENSE_SCHEMA_VERSION;
  readonly licenseId: string;
  readonly product: typeof LICENSE_PRODUCT;
  readonly edition: typeof LICENSE_EDITION;
  readonly features: readonly string[];
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly subject?: string;
  readonly maxWorkspaces?: number;
}

export interface SignedEntitlementV1 {
  readonly schemaVersion: typeof LICENSE_SCHEMA_VERSION;
  readonly algorithm: 'Ed25519';
  readonly keyId: string;
  readonly payload: LicenseEntitlementV1;
  readonly signature: string;
}

export type LicenseKeyMaterial = KeyObject | string;
export type LicensePublicKeys = Readonly<Record<string, LicenseKeyMaterial>>;

export interface LicenseStatus {
  readonly status: LicenseStatusKind;
  readonly reason: LicenseStatusReason;
  readonly checkedAt: string;
  readonly keyId?: string;
  readonly licenseId?: string;
  readonly product?: string;
  readonly edition?: string;
  readonly features?: readonly string[];
  readonly issuedAt?: string;
  readonly expiresAt?: string;
  readonly subject?: string;
  readonly maxWorkspaces?: number;
  readonly entitlement?: LicenseEntitlementV1;
}

export interface LicenseGate {
  status(): LicenseStatus;
  assertFeature(feature?: string): LicenseEntitlementV1;
}

interface LicenseGateOptions {
  readonly entitlement?: unknown;
  readonly publicKeys?: LicensePublicKeys;
  readonly clock?: () => string;
  readonly loadReason?: 'missing' | 'unreadable';
}

interface ParsedPayload {
  readonly payload?: LicenseEntitlementV1;
  readonly reason?: Exclude<LicenseStatusReason, 'valid' | 'not_yet_valid' | 'expired'>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(record).every((key) => allowed.has(key));
}

/**
 * Produces the stable JSON representation signed by Spyderbyte licenses.
 * Object keys are sorted recursively; array order is preserved intentionally.
 */
export function canonicalizeJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new TypeError('Canonical JSON cannot contain non-finite numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalizeJson(entry)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalizeJson(record[key])}`)
      .join(',')}}`;
  }
  throw new TypeError('Canonical JSON cannot contain undefined or unsupported values');
}

function parsePayload(value: unknown): ParsedPayload {
  if (!isRecord(value)) return { reason: 'malformed' };
  if (
    !hasOnlyKeys(value, [
      'schemaVersion',
      'licenseId',
      'product',
      'edition',
      'features',
      'issuedAt',
      'expiresAt',
      'subject',
      'maxWorkspaces',
    ])
  ) {
    return { reason: 'malformed' };
  }
  if (value['schemaVersion'] !== LICENSE_SCHEMA_VERSION) return { reason: 'malformed' };
  if (
    typeof value['licenseId'] !== 'string' ||
    value['licenseId'].trim().length === 0 ||
    value['product'] !== LICENSE_PRODUCT ||
    value['edition'] !== LICENSE_EDITION ||
    typeof value['issuedAt'] !== 'string' ||
    typeof value['expiresAt'] !== 'string'
  ) {
    return { reason: 'malformed' };
  }
  if (
    !Array.isArray(value['features']) ||
    value['features'].some((feature) => typeof feature !== 'string' || feature.trim().length === 0)
  ) {
    return { reason: 'malformed' };
  }
  const features = value['features'] as string[];
  if (new Set(features).size !== features.length) return { reason: 'malformed' };
  const subject = value['subject'];
  const maxWorkspaces = value['maxWorkspaces'];
  const normalizedMaxWorkspaces =
    typeof maxWorkspaces === 'number' && Number.isSafeInteger(maxWorkspaces) && maxWorkspaces >= 1
      ? maxWorkspaces
      : undefined;
  if (subject !== undefined && typeof subject !== 'string') {
    return { reason: 'malformed' };
  }
  if (maxWorkspaces !== undefined && normalizedMaxWorkspaces === undefined) {
    return { reason: 'malformed' };
  }
  const issuedAt = Date.parse(value['issuedAt']);
  const expiresAt = Date.parse(value['expiresAt']);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= issuedAt) {
    return { reason: 'malformed' };
  }
  const payload: LicenseEntitlementV1 = {
    schemaVersion: LICENSE_SCHEMA_VERSION,
    licenseId: value['licenseId'],
    product: LICENSE_PRODUCT,
    edition: LICENSE_EDITION,
    features: [...features],
    issuedAt: value['issuedAt'],
    expiresAt: value['expiresAt'],
    ...(subject === undefined ? {} : { subject }),
    ...(normalizedMaxWorkspaces === undefined ? {} : { maxWorkspaces: normalizedMaxWorkspaces }),
  };
  return { payload };
}

function asPublicKey(value: LicenseKeyMaterial): KeyObject {
  return typeof value === 'string' ? createPublicKey(value) : value;
}

function asPrivateKey(value: LicenseKeyMaterial): KeyObject {
  return typeof value === 'string' ? createPrivateKey(value) : value;
}

function safeStatus(
  status: LicenseStatusKind,
  reason: LicenseStatusReason,
  checkedAt: string,
  extra: {
    readonly keyId?: string;
    readonly payload?: LicenseEntitlementV1;
  } = {},
): LicenseStatus {
  const payload = extra.payload;
  return {
    status,
    reason,
    checkedAt,
    ...(extra.keyId === undefined ? {} : { keyId: extra.keyId }),
    ...(payload === undefined
      ? {}
      : {
          licenseId: payload.licenseId,
          product: payload.product,
          edition: payload.edition,
          features: [...payload.features],
          issuedAt: payload.issuedAt,
          expiresAt: payload.expiresAt,
          ...(payload.subject === undefined ? {} : { subject: payload.subject }),
          ...(payload.maxWorkspaces === undefined ? {} : { maxWorkspaces: payload.maxWorkspaces }),
          entitlement: payload,
        }),
  };
}

function inspectEntitlement(
  candidate: unknown,
  publicKeys: LicensePublicKeys,
  nowIso: string,
  loadReason?: 'missing' | 'unreadable',
): LicenseStatus {
  if (candidate === undefined || candidate === null) {
    return safeStatus('missing', loadReason ?? 'missing', nowIso);
  }
  if (
    !isRecord(candidate) ||
    !hasOnlyKeys(candidate, ['schemaVersion', 'algorithm', 'keyId', 'payload', 'signature'])
  ) {
    return safeStatus('invalid', 'malformed', nowIso);
  }
  if (
    candidate['schemaVersion'] !== LICENSE_SCHEMA_VERSION ||
    candidate['algorithm'] !== 'Ed25519' ||
    typeof candidate['keyId'] !== 'string' ||
    candidate['keyId'].trim().length === 0 ||
    typeof candidate['signature'] !== 'string' ||
    !/^[A-Za-z0-9_-]+$/.test(candidate['signature'])
  ) {
    return safeStatus('invalid', 'malformed', nowIso);
  }
  const parsed = parsePayload(candidate['payload']);
  if (parsed.payload === undefined)
    return safeStatus('invalid', parsed.reason ?? 'malformed', nowIso);
  const keyId = candidate['keyId'];
  const keyMaterial = publicKeys[keyId];
  if (keyMaterial === undefined)
    return safeStatus('invalid', 'unknown_key', nowIso, { keyId, payload: parsed.payload });
  let validSignature = false;
  try {
    const signature = Buffer.from(candidate['signature'], 'base64url');
    validSignature =
      signature.length === 64 &&
      verify(
        null,
        Buffer.from(canonicalizeJson(parsed.payload)),
        asPublicKey(keyMaterial),
        signature,
      );
  } catch {
    validSignature = false;
  }
  if (!validSignature)
    return safeStatus('invalid', 'invalid_signature', nowIso, { keyId, payload: parsed.payload });
  const now = Date.parse(nowIso);
  const issuedAt = Date.parse(parsed.payload.issuedAt);
  const expiresAt = Date.parse(parsed.payload.expiresAt);
  if (!Number.isFinite(now))
    return safeStatus('invalid', 'invalid_clock', nowIso, { keyId, payload: parsed.payload });
  if (now < issuedAt)
    return safeStatus('not_yet_valid', 'not_yet_valid', nowIso, { keyId, payload: parsed.payload });
  if (now >= expiresAt)
    return safeStatus('expired', 'expired', nowIso, { keyId, payload: parsed.payload });
  return safeStatus('valid', 'valid', nowIso, { keyId, payload: parsed.payload });
}

export class SignedLicenseGate implements LicenseGate {
  private readonly candidate: unknown;
  private readonly publicKeys: LicensePublicKeys;
  private readonly clock: () => string;
  private readonly loadReason: 'missing' | 'unreadable' | undefined;

  constructor(options: LicenseGateOptions = {}) {
    this.candidate =
      options.entitlement === undefined ? undefined : structuredClone(options.entitlement);
    this.publicKeys = options.publicKeys ?? {};
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.loadReason = options.loadReason;
  }

  status(): LicenseStatus {
    const now = this.clock();
    return inspectEntitlement(this.candidate, this.publicKeys, now, this.loadReason);
  }

  assertFeature(feature = DEFAULT_LOCAL_WORKFLOW_FEATURE): LicenseEntitlementV1 {
    if (feature.trim().length === 0)
      throw runtimeError('VALIDATION_INVALID_INPUT', 'License feature is required');
    const status = this.status();
    if (status.status !== 'valid' || status.entitlement === undefined) {
      throw runtimeError(
        'POLICY_DENIED',
        `A valid Spyderbyte license is required (${status.reason})`,
      );
    }
    if (!status.entitlement.features.includes(feature)) {
      throw runtimeError('POLICY_DENIED', `The license does not include feature ${feature}`);
    }
    return status.entitlement;
  }
}

/**
 * Reads the signed entitlement on every status or effect check. Spyderbyte uses this adapter
 * so an explicitly imported license becomes active without restarting the daemon.
 */
export class ReloadingLicenseGate implements LicenseGate {
  private readonly filePath: string;
  private readonly publicKeys: LicensePublicKeys;
  private readonly clock: () => string;

  constructor(
    filePath: string,
    options: { readonly publicKeys?: LicensePublicKeys; readonly clock?: () => string } = {},
  ) {
    this.filePath = filePath;
    this.publicKeys = options.publicKeys ?? {};
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  status(): LicenseStatus {
    return createLicenseGateFromFileSync(this.filePath, {
      publicKeys: this.publicKeys,
      clock: this.clock,
    }).status();
  }

  assertFeature(feature = DEFAULT_LOCAL_WORKFLOW_FEATURE): LicenseEntitlementV1 {
    return createLicenseGateFromFileSync(this.filePath, {
      publicKeys: this.publicKeys,
      clock: this.clock,
    }).assertFeature(feature);
  }
}

export function createMissingLicenseGate(
  options: { readonly clock?: () => string } = {},
): LicenseGate {
  return new SignedLicenseGate({
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
}

export function createLicenseGate(options: LicenseGateOptions): LicenseGate {
  return new SignedLicenseGate(options);
}

export function createReloadingLicenseGateFromFileSync(
  filePath: string,
  options: { readonly publicKeys?: LicensePublicKeys; readonly clock?: () => string } = {},
): LicenseGate {
  return new ReloadingLicenseGate(filePath, options);
}

export function createSignedEntitlement(
  payload: LicenseEntitlementV1,
  options: { readonly keyId: string; readonly privateKey: LicenseKeyMaterial },
): SignedEntitlementV1 {
  const parsed = parsePayload(payload);
  if (parsed.payload === undefined)
    throw new TypeError(`Invalid license payload: ${parsed.reason ?? 'malformed'}`);
  if (options.keyId.trim().length === 0) throw new TypeError('License keyId is required');
  const signature = sign(
    null,
    Buffer.from(canonicalizeJson(parsed.payload)),
    asPrivateKey(options.privateKey),
  );
  return {
    schemaVersion: LICENSE_SCHEMA_VERSION,
    algorithm: 'Ed25519',
    keyId: options.keyId,
    payload: parsed.payload,
    signature: signature.toString('base64url'),
  };
}

export function readSignedEntitlementFileSync(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
}

export async function readSignedEntitlementFile(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, 'utf8')) as unknown;
}

export function createLicenseGateFromFileSync(
  filePath: string,
  options: { readonly publicKeys?: LicensePublicKeys; readonly clock?: () => string } = {},
): LicenseGate {
  try {
    return new SignedLicenseGate({
      entitlement: readSignedEntitlementFileSync(filePath),
      ...(options.publicKeys === undefined ? {} : { publicKeys: options.publicKeys }),
      ...(options.clock === undefined ? {} : { clock: options.clock }),
    });
  } catch (error) {
    const missing =
      typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
    return new SignedLicenseGate({
      ...(options.publicKeys === undefined ? {} : { publicKeys: options.publicKeys }),
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      loadReason: missing ? 'missing' : 'unreadable',
    });
  }
}

export async function createLicenseGateFromFile(
  filePath: string,
  options: { readonly publicKeys?: LicensePublicKeys; readonly clock?: () => string } = {},
): Promise<LicenseGate> {
  try {
    return new SignedLicenseGate({
      entitlement: await readSignedEntitlementFile(filePath),
      ...(options.publicKeys === undefined ? {} : { publicKeys: options.publicKeys }),
      ...(options.clock === undefined ? {} : { clock: options.clock }),
    });
  } catch (error) {
    const missing =
      typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
    return new SignedLicenseGate({
      ...(options.publicKeys === undefined ? {} : { publicKeys: options.publicKeys }),
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      loadReason: missing ? 'missing' : 'unreadable',
    });
  }
}

/**
 * Atomically persists an imported signed entitlement. The file is not a source of trust by
 * itself; callers must continue to validate it through a LicenseGate before enabling effects.
 */
export function writeSignedEntitlementFileSync(filePath: string, entitlement: unknown): void {
  const encoded = JSON.stringify(entitlement);
  if (encoded === undefined) throw new TypeError('License entitlement must be JSON serializable');
  const parent = dirname(filePath);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    writeFileSync(temporaryPath, `${encoded}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, filePath);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // Preserve the original write/rename failure.
    }
    throw error;
  }
}
