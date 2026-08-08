import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import * as prettier from 'prettier';

const root = process.cwd();
const frontendRoot = resolve(process.env.AGENTIC_FRONTEND_ROOT ?? resolve(root, 'apps/web'));
const outputPath = resolve(frontendRoot, 'src/runtime/contracts.snapshot.json');
const source = {
  api: JSON.parse(await readFile(resolve(root, 'apps/api/generated/openapi.v1.json'), 'utf8')),
  runtime: JSON.parse(
    await readFile(
      resolve(root, 'packages/runtime-contracts/generated/runtime-contracts.v1.json'),
      'utf8',
    ),
  ),
};
const generated = await prettier.format(JSON.stringify(source), {
  parser: 'json',
  filepath: outputPath,
  printWidth: 100,
});

if (process.argv.includes('--check')) {
  let actual;
  try {
    actual = await readFile(outputPath, 'utf8');
  } catch {
    console.error(`${outputPath} is missing; run pnpm frontend-contracts:generate.`);
    process.exitCode = 1;
  }
  if (actual !== undefined && actual !== generated) {
    console.error(`${outputPath} is stale; run pnpm frontend-contracts:generate.`);
    process.exitCode = 1;
  }
  if (process.exitCode !== 1) console.log('Frontend contract snapshot is up to date.');
} else {
  await writeFile(outputPath, generated);
  console.log(`Generated ${outputPath}.`);
}
