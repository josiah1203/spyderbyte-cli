import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const composePath = resolve(
  new URL('../../deploy/local/docker-compose.yml', import.meta.url).pathname,
);
const compose = readFileSync(composePath, 'utf8');
const images = [...compose.matchAll(/^\s+image:\s*([^\s#]+)\s*$/gm)].map((match) => match[1]);
if (images.length === 0)
  throw new Error('No container images were found in the local compose file');
const unpinned = images.filter((image) => image.endsWith(':latest') || !image.includes(':'));
if (unpinned.length > 0) {
  throw new Error(
    `Container images must use immutable version tags or digests: ${unpinned.join(', ')}`,
  );
}
const uniqueImages = [...new Set(images)].sort();
console.log(
  JSON.stringify(
    {
      status: 'passed',
      composePath,
      images: uniqueImages,
      policy: 'version-tagged-or-digest-pinned; vulnerability scanning is CI-owned',
    },
    null,
    2,
  ),
);
