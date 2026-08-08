import { describe, expect, it } from 'vitest';
import { makeMoney } from '@agentic-platform/runtime-contracts';
import { ModelRouter, type ModelProvider } from '../src/model.js';

function provider(providerId: string, model: string): ModelProvider {
  return {
    providerId,
    model,
    metadata: {
      providerId,
      modelId: model,
      capabilities: ['streaming'],
      dataClasses: ['internal'],
      billingMode: 'local',
      state: 'ready',
      authenticationState: 'not_applicable',
      local: true,
    },
    async complete() {
      return {
        output: 'ok',
        usage: { inputTokens: 0, outputTokens: 1, totalTokens: 1, cost: makeMoney(0, 'USD') },
      };
    },
  };
}

describe('Phase 1 model selection hierarchy', () => {
  it('resolves explicit run, resource, project, workspace, and policy scopes in order', () => {
    const router = new ModelRouter();
    const models = [
      provider('run', 'run-model'),
      provider('resource', 'resource-model'),
      provider('project', 'project-model'),
      provider('workspace', 'workspace-model'),
      provider('policy', 'policy-model'),
      provider('fallback', 'fallback-model'),
    ];
    for (const model of models) router.registerProvider(model);
    router.registerRoute({
      taskShape: 'default',
      tier: 0,
      providers: models.map((model) => `${model.providerId}:${model.model}`),
      maxTokens: 32,
    });
    const resolved = router.resolveSelection({
      taskShape: 'default',
      tier: 0,
      allowedModels: models.map((model) => model.model),
      hierarchy: {
        resource: { providerId: 'resource', modelId: 'resource-model' },
        project: { providerId: 'project', modelId: 'project-model' },
        workspace: { providerId: 'workspace', modelId: 'workspace-model' },
        routingPolicy: { providerId: 'policy', modelId: 'policy-model' },
        fallback: [{ providerId: 'fallback', modelId: 'fallback-model' }],
      },
    }).resolved;
    expect(resolved.selected).toEqual({ providerId: 'resource', modelId: 'resource-model' });
    expect(resolved.reason).toBe('resource');

    const explicit = router.resolveSelection({
      taskShape: 'default',
      tier: 0,
      allowedModels: models.map((model) => model.model),
      hierarchy: { explicit: { providerId: 'run', modelId: 'run-model' } },
    }).resolved;
    expect(explicit.reason).toBe('explicit');
  });
});
