import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileClientPreferencesStore, MemoryClientPreferencesStore } from '../src/preferences.js';

describe('Spyderbyte client-only preferences', () => {
  it('persists workspace, model, pane, recent-command, and draft state without credentials', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spyderbyte-preferences-'));
    try {
      const path = join(root, 'preferences.json');
      const store = new FileClientPreferencesStore(path);
      const projectId = '018f0c4b-4e80-7abc-8def-0123456789ab' as never;
      store.update({
        activeWorkspacePath: '/tmp/workspace',
        activeProjectId: projectId,
        selectedModel: { providerId: 'deterministic', modelId: 'fixture-model' },
        selectedRuntime: 'local-host',
        paneLayout: 'narrow',
        activePane: 'logs',
        recentCommands: ['models list'],
        draftInput: 'continue',
      });
      const restarted = new FileClientPreferencesStore(path);
      expect(restarted.load()).toMatchObject({
        activeWorkspacePath: '/tmp/workspace',
        activeProjectId: projectId,
        selectedModel: { providerId: 'deterministic', modelId: 'fixture-model' },
        paneLayout: 'narrow',
        activePane: 'logs',
        draftInput: 'continue',
      });
      expect(await readFile(path, 'utf8')).not.toContain('apiKey');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps recent commands bounded in memory', () => {
    const store = new MemoryClientPreferencesStore();
    store.update({ recentCommands: Array.from({ length: 30 }, (_, index) => `command-${index}`) });
    expect(store.load().recentCommands).toHaveLength(20);
    expect(store.load().recentCommands[0]).toBe('command-10');
  });
});
