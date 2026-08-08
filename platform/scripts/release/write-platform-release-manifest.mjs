import { readFileSync, writeFileSync } from 'node:fs';
import {
  createReleaseManifest,
  normalizeReleaseArchitecture,
  normalizeReleasePlatform,
} from './release-targets.mjs';

const [artifactPath, outputPath] = process.argv.slice(2);
if (artifactPath === undefined || outputPath === undefined) {
  throw new Error(
    'Usage: node scripts/release/write-platform-release-manifest.mjs <artifact> <manifest>',
  );
}

const signingKeyValue = process.env['SPYDERBYTE_UPDATE_SIGNING_KEY'];
const signingKey =
  signingKeyValue?.includes('BEGIN') === true
    ? signingKeyValue
    : signingKeyValue === undefined
      ? undefined
      : readFileSync(signingKeyValue, 'utf8');
const manifest = createReleaseManifest({
  artifactPath,
  version: process.env['SPYDERBYTE_VERSION'],
  channel: process.env['SPYDERBYTE_RELEASE_CHANNEL'] ?? 'stable',
  platform: normalizeReleasePlatform(
    process.env['SPYDERBYTE_RELEASE_PLATFORM'] ?? process.platform,
  ),
  architecture: normalizeReleaseArchitecture(
    process.env['SPYDERBYTE_RELEASE_ARCHITECTURE'] ?? process.arch,
  ),
  artifactBaseUrl: process.env['SPYDERBYTE_UPDATE_ARTIFACT_BASE_URL'],
  signingKey,
});
writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
console.log(`Spyderbyte platform release manifest written: ${outputPath}`);
