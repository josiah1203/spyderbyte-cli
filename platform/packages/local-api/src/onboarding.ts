import { readdir } from 'node:fs/promises';
import { arch, platform, release, version } from 'node:os';
import { basename, resolve } from 'node:path';

export type OnboardingChoice =
  | 'local-model'
  | 'provider-key'
  | 'spyderbyte-cloud'
  | 'configure-later';

export interface OnboardingProjectContext {
  readonly rootPath: string;
  readonly projectName: string;
  readonly markers: readonly string[];
  readonly likelyWorkloads: readonly ('python' | 'node' | 'sql' | 'notebook' | 'git')[];
}

export interface OnboardingEnvironmentContext {
  readonly platform: string;
  readonly architecture: string;
  readonly osRelease: string;
  readonly runtimeVersion: string;
  readonly project: OnboardingProjectContext;
  readonly detectedAt: string;
}

export interface OnboardingState {
  readonly schemaVersion: 1;
  readonly status: 'not_started' | 'configured';
  readonly choice?: OnboardingChoice;
  readonly modelId?: string;
  readonly providerConfigurationId?: string;
  readonly environment: OnboardingEnvironmentContext;
  readonly completedAt?: string;
}

const MARKERS = [
  '.git',
  'package.json',
  'pyproject.toml',
  'requirements.txt',
  'Cargo.toml',
  'go.mod',
  'notebooks',
] as const;

export async function detectOnboardingContext(
  rootPath: string | undefined,
  now = new Date().toISOString(),
): Promise<OnboardingEnvironmentContext> {
  const resolvedRoot = resolve(rootPath ?? process.cwd());
  let entries: readonly string[] = [];
  try {
    entries = (await readdir(resolvedRoot)).filter((entry) =>
      MARKERS.some((marker) => marker === entry),
    );
  } catch {
    entries = [];
  }
  const likelyWorkloads = new Set<OnboardingProjectContext['likelyWorkloads'][number]>();
  if (entries.includes('.git')) likelyWorkloads.add('git');
  if (entries.includes('package.json')) likelyWorkloads.add('node');
  if (entries.includes('pyproject.toml') || entries.includes('requirements.txt')) {
    likelyWorkloads.add('python');
  }
  if (entries.includes('notebooks')) likelyWorkloads.add('notebook');
  if (entries.some((entry) => entry === 'package.json' || entry === 'pyproject.toml')) {
    likelyWorkloads.add('sql');
  }
  return {
    platform: platform(),
    architecture: arch(),
    osRelease: release(),
    runtimeVersion: version(),
    project: {
      rootPath: resolvedRoot,
      projectName: basename(resolvedRoot),
      markers: [...entries].sort(),
      likelyWorkloads: [...likelyWorkloads].sort(),
    },
    detectedAt: now,
  };
}
