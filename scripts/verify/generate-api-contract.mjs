import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import * as prettier from 'prettier';

const root = process.cwd();
const sourcePath = join(root, 'apps/api/contracts/api.v1.json');
const runtimeSchemaPath = join(
  root,
  'packages/runtime-contracts/schemas/runtime-contracts.v1.json',
);
const outputDirectory = join(root, 'apps/api/generated');
const outputPath = join(outputDirectory, 'openapi.v1.json');
const checkOnly = process.argv.includes('--check');

const manifest = JSON.parse(await readFile(sourcePath, 'utf8'));
const runtimeSchema = JSON.parse(await readFile(runtimeSchemaPath, 'utf8'));
const runtimeDefinitions = Object.fromEntries(
  Object.entries(runtimeSchema.$defs).map(([name, definition]) => [name, rewriteRefs(definition)]),
);

const schemas = {
  ...runtimeDefinitions,
  ...manifest.schemas,
};

function rewriteRefs(value) {
  if (Array.isArray(value)) return value.map((entry) => rewriteRefs(entry));
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      key === '$ref' && typeof entry === 'string' && entry.startsWith('#/$defs/')
        ? `#/components/schemas/${entry.slice('#/$defs/'.length)}`
        : rewriteRefs(entry),
    ]),
  );
}

function schemaFor(value) {
  if (typeof value === 'string') return { $ref: `#/components/schemas/${value}` };
  return rewriteRefs(value);
}

function responseFor(response) {
  const responseSchema = response.schema === undefined ? undefined : schemaFor(response.schema);
  const content = {};
  if (responseSchema !== undefined) {
    content['application/json'] = {
      schema: responseSchema,
    };
  }
  if (response.sse === true) {
    content['text/event-stream'] = {
      schema: {
        type: 'string',
        description: 'SSE frames whose data field contains a SubscriptionPage.',
      },
    };
  }
  return {
    description: response.description,
    ...(Object.keys(content).length === 0 ? {} : { content }),
  };
}

function operationFor(route) {
  const responses = Object.fromEntries(
    Object.entries(route.responses).map(([status, response]) => [status, responseFor(response)]),
  );
  return {
    operationId: route.operationId,
    summary: route.summary,
    tags: ['runtime'],
    ...(route.parameters === undefined ? {} : { parameters: route.parameters }),
    ...(route.requestContract === undefined
      ? {}
      : {
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: schemaFor(route.requestContract),
              },
            },
          },
        }),
    responses,
    'x-tenant-scoped': true,
  };
}

const paths = {};
for (const route of manifest.routes) {
  const method = route.method.toLowerCase();
  if (paths[route.path]?.[method] !== undefined) {
    throw new Error(`Duplicate API route: ${route.method.toUpperCase()} ${route.path}`);
  }
  paths[route.path] = {
    ...(paths[route.path] ?? {}),
    [method]: operationFor(route),
  };
}

const document = {
  openapi: '3.1.0',
  info: manifest.info,
  servers: [{ url: '/' }],
  paths,
  components: {
    schemas,
  },
};

function assertLocalReferences(value, context = '$') {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertLocalReferences(entry, `${context}[${index}]`));
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if ('$ref' in value && typeof value.$ref === 'string') {
    const prefix = '#/components/schemas/';
    if (value.$ref.startsWith(prefix)) {
      const schemaName = value.$ref.slice(prefix.length);
      if (!(schemaName in schemas)) {
        throw new Error(`Unknown API schema reference ${value.$ref} at ${context}`);
      }
    }
  }
  Object.entries(value).forEach(([key, entry]) =>
    assertLocalReferences(entry, `${context}.${key}`),
  );
}

assertLocalReferences(document);
const generated = await prettier.format(JSON.stringify(document), {
  parser: 'json',
  filepath: outputPath,
  printWidth: 100,
});

if (checkOnly) {
  let actual;
  try {
    actual = await readFile(outputPath, 'utf8');
  } catch {
    console.error(`${outputPath} is missing`);
    process.exitCode = 1;
  }
  if (actual !== undefined && actual !== generated) {
    console.error(`${outputPath} is out of date; run pnpm api-contracts:generate.`);
    process.exitCode = 1;
  }
  if (process.exitCode !== 1) console.log('Generated API contract is up to date.');
} else {
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(outputPath, generated);
  console.log(`Generated ${outputPath}.`);
}
