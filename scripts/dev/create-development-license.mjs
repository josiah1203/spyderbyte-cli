import { generateKeyPairSync, sign } from 'node:crypto';
import { chmodSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';

const options = parseArguments(process.argv.slice(2));
const outputDirectory = resolve(
  options.outputDirectory ??
    join(homedir(), 'Library/Application Support/Spyderbyte/development-license'),
);
const keyId = options.keyId ?? 'local-dev-2026';
const licenseId = options.licenseId ?? `local-dev-${new Date().toISOString().slice(0, 10)}`;
const issuedAt = options.issuedAt ?? new Date(Date.now() - 5 * 60_000).toISOString();
const expiresAt = options.expiresAt ?? new Date(Date.now() + 365 * 24 * 60 * 60_000).toISOString();

mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
const privateKeyPath = join(outputDirectory, 'development-private-key.pkcs8.pem');
const publicKeyPath = join(outputDirectory, 'development-public-key.txt');
const entitlementPath = join(outputDirectory, 'development-entitlement.json');
const keyIdPath = join(outputDirectory, 'development-key-id.txt');
if (!options.force && [privateKeyPath, publicKeyPath, entitlementPath, keyIdPath].some(exists)) {
  throw new Error(
    `Development license output already exists; use --force to replace ${outputDirectory}`,
  );
}

const keyPair = generateKeyPairSync('ed25519');
const payload = {
  schemaVersion: 1,
  licenseId,
  product: 'agentic-ml-data-platform',
  edition: 'local',
  features: ['local.workflow', 'local.workspace.export', 'local.workspace.backup'],
  issuedAt,
  expiresAt,
  subject: 'local-development',
  maxWorkspaces: 25,
};
const entitlement = {
  schemaVersion: 1,
  algorithm: 'Ed25519',
  keyId,
  payload,
  signature: sign(null, Buffer.from(canonicalizeJson(payload)), keyPair.privateKey).toString(
    'base64url',
  ),
};
writeSecure(privateKeyPath, keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
writePublic(publicKeyPath, keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString());
writeSecure(entitlementPath, `${JSON.stringify(entitlement, null, 2)}\n`);
writeSecure(keyIdPath, `${keyId}\n`);

console.log(
  JSON.stringify({
    outputDirectory,
    publicKeyPath,
    entitlementPath,
    keyId,
    licenseId,
    issuedAt,
    expiresAt,
  }),
);

function parseArguments(argumentsList) {
  const parsed = {};
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === '--force') {
      parsed.force = true;
      continue;
    }
    const [name, inlineValue] = argument.split('=', 2);
    const value = inlineValue ?? argumentsList[++index];
    if (value === undefined || !name.startsWith('--'))
      throw new Error(`Invalid argument: ${argument}`);
    if (name === '--output-dir') parsed.outputDirectory = value;
    else if (name === '--key-id') parsed.keyId = value;
    else if (name === '--license-id') parsed.licenseId = value;
    else if (name === '--issued-at') parsed.issuedAt = value;
    else if (name === '--expires-at') parsed.expiresAt = value;
    else throw new Error(`Unknown argument: ${name}`);
  }
  return parsed;
}

function exists(path) {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function writeSecure(path, value) {
  writeFileSync(path, value, { encoding: 'utf8', mode: 0o600 });
  chmodSync(path, 0o600);
}

function writePublic(path, value) {
  writeFileSync(path, value, { encoding: 'utf8', mode: 0o644 });
  chmodSync(path, 0o644);
}

function canonicalizeJson(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new TypeError('License JSON cannot contain non-finite numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalizeJson).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalizeJson(value[key])}`)
      .join(',')}}`;
  }
  throw new TypeError('License JSON cannot contain unsupported values');
}
