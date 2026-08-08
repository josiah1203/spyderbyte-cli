import { readFileSync } from 'node:fs';
import { verifyReleaseManifest } from './release-targets.mjs';

const [artifactPath, manifestPath] = process.argv.slice(2);
if (artifactPath === undefined || manifestPath === undefined) {
  throw new Error(
    'Usage: node scripts/release/verify-platform-release-manifest.mjs <artifact> <manifest>',
  );
}
const publicKeyValue = process.env['SPYDERBYTE_UPDATE_PUBLIC_KEY'];
const publicKey =
  publicKeyValue?.includes('BEGIN') === true
    ? publicKeyValue
    : publicKeyValue === undefined
      ? undefined
      : readFileSync(publicKeyValue, 'utf8');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
verifyReleaseManifest({ artifactPath, manifest, publicKey });
console.log(`Spyderbyte platform release manifest verified: ${manifestPath}`);
