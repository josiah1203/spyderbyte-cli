import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

type ApiManifest = {
  routes: Array<{ method: string; path: string; operationId: string }>;
};

type OpenApiDocument = {
  paths: Record<string, Record<string, { operationId?: string; 'x-tenant-scoped'?: boolean }>>;
  components: { schemas: Record<string, unknown> };
};

const manifest = JSON.parse(
  await readFile(new URL('../contracts/api.v1.json', import.meta.url), 'utf8'),
) as ApiManifest;
const document = JSON.parse(
  await readFile(new URL('../generated/openapi.v1.json', import.meta.url), 'utf8'),
) as OpenApiDocument;

describe('generated API contract', () => {
  it('documents every local API route with a unique operation and tenant boundary', () => {
    const operations = new Set<string>();
    for (const route of manifest.routes) {
      const operation = document.paths[route.path]?.[route.method];
      expect(operation, `${route.method.toUpperCase()} ${route.path}`).toBeDefined();
      expect(operation?.operationId).toBe(route.operationId);
      expect(operation?.['x-tenant-scoped']).toBe(true);
      expect(operations.has(route.operationId)).toBe(false);
      operations.add(route.operationId);
    }
    expect(operations.size).toBe(manifest.routes.length);
  });

  it('includes the shared runtime schemas and API-specific response schemas', () => {
    expect(document.components.schemas['RuntimeCommand']).toBeDefined();
    expect(document.components.schemas['RuntimeEvent']).toBeDefined();
    expect(document.components.schemas['DatasetWorkflowResult']).toBeDefined();
    expect(document.components.schemas['SubscriptionPage']).toBeDefined();
  });
});
