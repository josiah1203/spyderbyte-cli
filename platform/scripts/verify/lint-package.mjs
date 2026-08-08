import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { extname, join } from 'node:path';
import process from 'node:process';

const sourceExtensions = new Set(['.cjs', '.js', '.mjs', '.ts', '.tsx']);

async function sourceFiles(directory, prefix = '') {
  const entries = await readdir(join(directory, prefix), { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'coverage')
      continue;
    const relativePath = join(prefix, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await sourceFiles(directory, relativePath)));
    } else if (sourceExtensions.has(extname(entry.name))) {
      files.push(relativePath);
    }
  }

  return files;
}

const files = await sourceFiles(process.cwd());

if (files.length === 0) {
  console.log('No source files yet; package lint is ready for the first implementation.');
} else {
  const result = spawnSync('eslint', files, { stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
}
