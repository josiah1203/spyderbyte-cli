import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

const workspaceRoot = process.cwd();
const workspaceGroups = ['apps', 'packages'];
const packageRecords = [];

for (const group of workspaceGroups) {
  const groupPath = join(workspaceRoot, group);
  let entries;
  try {
    entries = await readdir(groupPath, { withFileTypes: true });
  } catch {
    continue;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const packagePath = join(groupPath, entry.name);
    const manifestPath = join(packagePath, 'package.json');
    let manifest;
    try {
      manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    } catch (error) {
      throw new Error(`Unable to read workspace manifest ${manifestPath}: ${String(error)}`);
    }
    packageRecords.push({ group, name: manifest.name, path: packagePath });
  }
}

const knownPackageNames = new Map(packageRecords.map((record) => [record.name, record]));
const violations = [];

for (const record of packageRecords) {
  const manifest = JSON.parse(await readFile(join(record.path, 'package.json'), 'utf8'));
  const dependencies = {
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.optionalDependencies,
  };
  const boundaryExceptions =
    manifest['x-boundary-exceptions'] !== null &&
    typeof manifest['x-boundary-exceptions'] === 'object' &&
    !Array.isArray(manifest['x-boundary-exceptions'])
      ? manifest['x-boundary-exceptions']
      : {};

  for (const dependencyName of Object.keys(dependencies)) {
    const dependency = knownPackageNames.get(dependencyName);
    if (!dependency) continue;

    if (
      record.group === 'apps' &&
      dependency.group === 'apps' &&
      (typeof boundaryExceptions[dependencyName] !== 'string' ||
        boundaryExceptions[dependencyName].trim().length === 0)
    ) {
      violations.push(`${record.name} cannot depend on sibling app ${dependencyName}`);
    }
    if (dependency.group === 'apps' && record.group === 'packages') {
      violations.push(`${record.name} cannot depend on application package ${dependencyName}`);
    }
  }
}

if (violations.length > 0) {
  console.error('Package boundary violations:');
  for (const violation of violations) console.error(`- ${violation}`);
  process.exitCode = 1;
} else {
  console.log(`Package boundary check passed for ${packageRecords.length} workspace packages.`);
}
