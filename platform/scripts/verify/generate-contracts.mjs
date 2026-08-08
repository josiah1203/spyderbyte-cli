import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import * as prettier from 'prettier';

const root = process.cwd();
const sourcePath = join(root, 'packages/runtime-contracts/schemas/runtime-contracts.v1.json');
const outputDirectory = join(root, 'packages/runtime-contracts/generated');
const outputJsonPath = join(outputDirectory, 'runtime-contracts.v1.json');
const outputDocsPath = join(outputDirectory, 'runtime-contracts.v1.md');
const checkOnly = process.argv.includes('--check');

const schema = JSON.parse(await readFile(sourcePath, 'utf8'));
const generatedJson = await prettier.format(JSON.stringify(schema), {
  parser: 'json',
  filepath: outputJsonPath,
  printWidth: 100,
});
const contractNames = Object.keys(schema.$defs).filter(
  (name) => !['JsonValue', 'Id', 'SchemaVersion', 'UtcInstant'].includes(name),
);
const generatedDocs = await prettier.format(
  [
    '# Runtime contracts v1',
    '',
    '> Generated from `packages/runtime-contracts/schemas/runtime-contracts.v1.json`. Do not edit by hand.',
    '',
    '| Contract | Required fields |',
    '| --- | --- |',
    ...contractNames.map((name) => {
      const required = schema.$defs[name].required?.join(', ') ?? '—';
      return `| \`${name}\` | ${required} |`;
    }),
    '',
  ].join('\n'),
  { parser: 'markdown', filepath: outputDocsPath, printWidth: 100 },
);

if (checkOnly) {
  const mismatches = [];
  for (const [path, expected] of [
    [outputJsonPath, generatedJson],
    [outputDocsPath, generatedDocs],
  ]) {
    let actual;
    try {
      actual = await readFile(path, 'utf8');
    } catch {
      mismatches.push(`${path} is missing`);
      continue;
    }
    if (actual !== expected) mismatches.push(`${path} is out of date`);
  }

  if (mismatches.length > 0) {
    console.error('Generated contract drift detected:');
    for (const mismatch of mismatches) console.error(`- ${mismatch}`);
    console.error('Run `pnpm contracts:generate` and review the resulting changes.');
    process.exitCode = 1;
  } else {
    console.log('Generated contract outputs are up to date.');
  }
} else {
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(outputJsonPath, generatedJson);
  await writeFile(outputDocsPath, generatedDocs);
  console.log(`Generated ${outputJsonPath} and ${outputDocsPath}.`);
}
