import { createHash } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';
import type { AgentRecommendation } from '@agentic-platform/runtime-contracts';

export type WorkspaceIntakeSource = 'inbox' | 'watch';
export type WorkspaceIntakeClassification =
  | 'data'
  | 'code'
  | 'notebook'
  | 'document'
  | 'image'
  | 'archive'
  | 'unknown';

export interface WorkspaceIntakeItem {
  readonly schemaVersion: 1;
  readonly itemId: string;
  readonly source: WorkspaceIntakeSource;
  readonly path: string;
  readonly classification: WorkspaceIntakeClassification;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly modifiedAt: string;
  readonly recommendedAction: 'publish-artifact' | 'open-notebook' | 'inspect' | 'ignore';
}

export interface WorkspaceIntakeSnapshot {
  readonly schemaVersion: 1;
  readonly inbox: readonly WorkspaceIntakeItem[];
  readonly watch: readonly WorkspaceIntakeItem[];
  readonly recommendations: readonly (AgentRecommendation & {
    readonly source: 'workspace-intake';
    readonly itemIds: readonly string[];
  })[];
  readonly scannedAt: string;
}

const MAX_ITEMS = 2_000;
const IGNORED = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__']);

function mediaTypeFor(extension: string): string {
  const types: Record<string, string> = {
    '.csv': 'text/csv',
    '.tsv': 'text/tab-separated-values',
    '.json': 'application/json',
    '.jsonl': 'application/jsonl',
    '.parquet': 'application/vnd.apache.parquet',
    '.py': 'text/x-python',
    '.sql': 'application/sql',
    '.js': 'text/javascript',
    '.ts': 'text/typescript',
    '.tsx': 'text/typescript',
    '.ipynb': 'application/x-ipynb+json',
    '.md': 'text/markdown',
    '.txt': 'text/plain',
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.zip': 'application/zip',
    '.tar': 'application/x-tar',
    '.gz': 'application/gzip',
  };
  return types[extension] ?? 'application/octet-stream';
}

function classificationFor(extension: string): WorkspaceIntakeClassification {
  if (['.csv', '.tsv', '.json', '.jsonl', '.parquet', '.arrow'].includes(extension)) return 'data';
  if (['.py', '.sql', '.js', '.ts', '.tsx', '.jsx', '.rs', '.go', '.java'].includes(extension))
    return 'code';
  if (extension === '.ipynb') return 'notebook';
  if (['.md', '.txt', '.pdf', '.docx', '.html'].includes(extension)) return 'document';
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'].includes(extension)) return 'image';
  if (['.zip', '.tar', '.gz', '.tgz'].includes(extension)) return 'archive';
  return 'unknown';
}

function recommendedAction(
  classification: WorkspaceIntakeClassification,
): WorkspaceIntakeItem['recommendedAction'] {
  if (classification === 'data') return 'publish-artifact';
  if (classification === 'notebook') return 'open-notebook';
  if (classification === 'unknown' || classification === 'archive') return 'ignore';
  return 'inspect';
}

async function scanDirectory(
  rootPath: string,
  directory: string,
  source: WorkspaceIntakeSource,
): Promise<WorkspaceIntakeItem[]> {
  const items: WorkspaceIntakeItem[] = [];
  const walk = async (current: string, depth: number): Promise<void> => {
    if (items.length >= MAX_ITEMS || depth > 4) return;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error instanceof Error && 'code' in error && String(error.code) === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (items.length >= MAX_ITEMS || entry.name.startsWith('.') || IGNORED.has(entry.name))
        continue;
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const details = await stat(absolute);
      const path = relative(rootPath, absolute);
      const extension = extname(entry.name).toLowerCase();
      const classification = classificationFor(extension);
      const modifiedAt = details.mtime.toISOString();
      const itemId = `intake-${createHash('sha256').update(`${source}:${path}:${modifiedAt}:${details.size}`).digest('hex').slice(0, 24)}`;
      items.push({
        schemaVersion: 1,
        itemId,
        source,
        path,
        classification,
        mediaType: mediaTypeFor(extension),
        sizeBytes: details.size,
        modifiedAt,
        recommendedAction: recommendedAction(classification),
      });
    }
  };
  await walk(directory, 0);
  return items;
}

export class LocalWorkspaceIntakeRuntime {
  private readonly rootPath: string;
  private readonly clock: () => string;
  private readonly inboxPath: string;
  private readonly watchPath: string;

  constructor(options: { readonly rootPath: string; readonly clock?: () => string }) {
    this.rootPath = resolve(options.rootPath);
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.inboxPath = join(this.rootPath, '.spyderbyte', 'inbox');
    this.watchPath = join(this.rootPath, '.spyderbyte', 'watch');
  }

  async listInbox(): Promise<readonly WorkspaceIntakeItem[]> {
    return scanDirectory(this.rootPath, this.inboxPath, 'inbox');
  }

  async listWatch(): Promise<readonly WorkspaceIntakeItem[]> {
    return scanDirectory(this.rootPath, this.watchPath, 'watch');
  }

  async recommendations(): Promise<WorkspaceIntakeSnapshot['recommendations']> {
    const [inbox, watch] = await Promise.all([this.listInbox(), this.listWatch()]);
    const items = [...inbox, ...watch];
    const byAction = new Map<WorkspaceIntakeItem['recommendedAction'], WorkspaceIntakeItem[]>();
    for (const item of items) {
      const group = byAction.get(item.recommendedAction) ?? [];
      group.push(item);
      byAction.set(item.recommendedAction, group);
    }
    return [...byAction.entries()]
      .filter(([action]) => action !== 'ignore')
      .map(([action, group]) => ({
        source: 'workspace-intake' as const,
        itemIds: group.map((item) => item.itemId),
        summary: `${group.length} workspace item${group.length === 1 ? '' : 's'} ready to ${action.replace('-', ' ')}`,
        actions: [action.replace('-', ' ')],
        rationale: group
          .slice(0, 3)
          .map((item) => `${item.path} classified as ${item.classification}`),
        confidence: group.every((item) => item.classification !== 'unknown') ? 0.95 : 0.6,
      }));
  }

  async snapshot(): Promise<WorkspaceIntakeSnapshot> {
    const [inbox, watch] = await Promise.all([this.listInbox(), this.listWatch()]);
    const recommendations = await this.recommendations();
    return { schemaVersion: 1, inbox, watch, recommendations, scannedAt: this.clock() };
  }
}
