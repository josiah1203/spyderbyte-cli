import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const repositoryRoot = resolve(process.cwd());
const defaultCodexRoot = '/Users/josiah/Downloads/codexcli-main';
const defaultOutput = join(repositoryRoot, 'CODEX_MIGRATION_MATRIX.md');

const args = process.argv.slice(2);
const check = args.includes('--check');

function option(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
}

const codexRoot = resolve(option('--codex-root', defaultCodexRoot));
const outputPath = resolve(option('--output', defaultOutput));

const codexRoots = ['.', 'codex-rs', 'sdk', 'docs', 'scripts', 'tools', 'patches'];

const spyderbyteRoots = [
  'apps/tui',
  'apps/spyderbyte-shell',
  'packages/cline-adapter',
  'apps/local-daemon',
  'packages/client-sdk',
  'packages/runtime-contracts',
];

const excludedNames = new Set(['.git', 'node_modules', 'target', 'dist', '.turbo', '.agentic']);

function walk(root, relativeRoot) {
  const absolute = join(root, relativeRoot);
  try {
    if (!statSync(absolute).isDirectory()) return [];
  } catch {
    return [];
  }
  const files = [];
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    if (excludedNames.has(entry.name)) continue;
    const child = join(relativeRoot, entry.name);
    if (entry.isDirectory()) files.push(...walk(root, child));
    else if (entry.isFile()) files.push(child.replaceAll('\\', '/'));
  }
  return files;
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function fileDigest(absolutePath) {
  const contents = readFileSync(absolutePath);
  return {
    bytes: contents.byteLength,
    hash: createHash('sha256').update(contents).digest('hex'),
  };
}

function codexDecision(path) {
  if (path === 'LICENSE' || path === 'NOTICE') {
    return ['KEEP', 'Retain as provenance and attribution evidence; no source import'];
  }
  if (path === 'README.md' || path === 'SECURITY.md') {
    return ['REMOVE', 'Reference only; product documentation is Spyderbyte-owned'];
  }
  if (path.startsWith('codex-rs/tui/')) return ['KEEP/ADAPT', 'Terminal primitives only'];
  if (path.startsWith('codex-rs/cli/'))
    return ['ADAPT/REPLACE', 'Command mechanics without Codex domain'];
  if (path.startsWith('codex-rs/app-server-protocol/')) {
    return ['REPLACE', 'Protocol reference only; Spyderbyte owns ACP/domain contracts'];
  }
  if (path.startsWith('codex-rs/app-server-transport/')) {
    return ['ADAPT', 'Transport mechanics behind AgentTransport'];
  }
  if (
    /^(codex-rs\/(core|core-api|core-plugins|login|chatgpt|backend-client|codex-api|cloud-config|cloud-tasks|cloud-tasks-client|cloud-tasks-mock-client)\/)/.test(
      path,
    )
  ) {
    return ['REPLACE', 'Spyderbyte Agent, auth, and cloud domain are authoritative'];
  }
  if (
    /^codex-rs\/(thread-store|state|agent-graph-store|rollout|rollout-trace|message-history)\//.test(
      path,
    )
  ) {
    return ['REPLACE', 'Spyderbyte state, Runs, events, and sessions are authoritative'];
  }
  if (/^codex-rs\/(config|codex-home|utils\/home-dir)\//.test(path)) {
    return ['ADAPT', 'Spyderbyte config and ~/.spyderbyte paths'];
  }
  if (
    /^codex-rs\/(model-provider|model-provider-info|models-manager|ollama|lmstudio)\//.test(path)
  ) {
    return ['ADAPT', 'Provider-neutral inference contracts'];
  }
  if (/^codex-rs\/(tools|codex-mcp|mcp-server|rmcp-client|connectors)\//.test(path)) {
    return ['ADAPT/REPLACE', 'Spyderbyte capabilities and connector authority'];
  }
  if (
    /^codex-rs\/(exec|shell-command|execpolicy|shell-escalation|exec-server|exec-server-protocol)\//.test(
      path,
    )
  ) {
    return ['REPLACE', 'Spyderbyte process execution and policy are authoritative'];
  }
  if (
    /^codex-rs\/(sandboxing|linux-sandbox|windows-sandbox-rs|bwrap|process-hardening|network-proxy)\//.test(
      path,
    )
  ) {
    return ['REPLACE', 'Spyderbyte sandbox and workload isolation are authoritative'];
  }
  if (/^codex-rs\/(diagnostics|otel|analytics|feedback)\//.test(path)) {
    return ['REPLACE', 'Spyderbyte diagnostics and privacy-configurable telemetry'];
  }
  if (/^codex-rs\/(plugin|skills|hooks|external-agent-migration|ext)\//.test(path)) {
    return ['REPLACE', 'Spyderbyte capability and extension boundary'];
  }
  if (
    /^codex-rs\/(file-system|file-search|file-watcher|git-utils|terminal-detection|ansi-escape|utils)\//.test(
      path,
    )
  ) {
    return ['KEEP/ADAPT', 'Product-neutral utility subject to dependency/security review'];
  }
  if (path.startsWith('sdk/'))
    return ['REMOVE/REPLACE', 'Spyderbyte clients own public API surface'];
  if (
    path.startsWith('docs/') ||
    path.startsWith('scripts/') ||
    path.startsWith('tools/') ||
    path.startsWith('patches/')
  ) {
    return ['REMOVE', 'Build, documentation, fixture, or patch provenance only; not imported'];
  }
  return ['REMOVE', 'Outside the approved shell boundary; retain only as provenance evidence'];
}

function spyderbyteDecision(path) {
  if (path.endsWith('/.DS_Store'))
    return ['REMOVE', 'Generated workstation metadata; not product source'];
  if (path.startsWith('apps/tui/src/'))
    return ['REPLACE/ADAPT', 'Preserve intent; migrate presentation to extracted shell'];
  if (path.startsWith('apps/tui/tests/'))
    return ['KEEP/EXTEND', 'CLI regression and command contract evidence'];
  if (path.startsWith('apps/spyderbyte-shell/'))
    return ['KEEP/EXTEND', 'Presentation-only Rust shell boundary'];
  if (path.startsWith('packages/cline-adapter/'))
    return ['ADAPT/DEPRECATE', 'Bounded compatibility runtime, not Agent authority'];
  if (path.startsWith('packages/client-sdk/'))
    return ['KEEP/EXTEND', 'Expose Spyderbyte client interfaces and typed events'];
  if (path.startsWith('packages/runtime-contracts/'))
    return ['KEEP/EXTEND', 'Add AgentSession, ACP, usage, and CLI contracts'];
  if (path.startsWith('apps/local-daemon/src/'))
    return ['KEEP/ADAPT', 'Local control/runtime composition and AgentSession integration'];
  if (path.startsWith('apps/local-daemon/tests/'))
    return ['KEEP/EXTEND', 'Local API, recovery, Run, and agent evidence'];
  return ['KEEP/EXTEND', 'Spyderbyte-owned CLI boundary and build metadata'];
}

function rowsFor(root, roots, prefix, classify) {
  const files = uniqueSorted(roots.flatMap((entry) => walk(root, entry)));
  return files.map((path) => {
    const { bytes, hash } = fileDigest(join(root, path));
    const [decision, boundary] = classify(path);
    return { path: `${prefix}/${path}`, bytes, hash, decision, boundary };
  });
}

const codexFiles = rowsFor(codexRoot, codexRoots, 'codexcli-main', codexDecision);
const spyderbyteFiles = rowsFor(repositoryRoot, spyderbyteRoots, 'spyderbyte', spyderbyteDecision);
const rows = [...codexFiles, ...spyderbyteFiles];
const manifest = rows.map((row) => `${row.path}\0${row.hash}\n`).join('');
const snapshotDigest = createHash('sha256').update(manifest).digest('hex');
const lines = [
  '# Codex-to-Spyderbyte Migration Matrix',
  '',
  '**Generated:** Deterministic output from the current audited source trees  ',
  `**Codex root:** \`${codexRoot}\`  `,
  `**Spyderbyte root:** \`${repositoryRoot}\`  `,
  `**Codex files inventoried:** ${codexFiles.length}  `,
  `**Spyderbyte CLI boundary files inventoried:** ${spyderbyteFiles.length}  `,
  `**Combined snapshot digest:** \`sha256:${snapshotDigest}\``,
  '',
  '> This file is generated by `scripts/verify/generate-codex-migration-matrix.mjs`. Do not hand-edit the inventory rows.',
  '> Decisions are migration classifications, not permission to import code. Phase 0 must finish provenance, license, dependency, security, and boundary review before source changes.',
  '',
  '## Decision vocabulary',
  '',
  '| Decision | Meaning |',
  '|---|---|',
  '| KEEP | Reuse only after product-neutrality, license, dependency, and security checks. |',
  '| ADAPT | Reuse behind a Spyderbyte-owned boundary with inherited assumptions removed. |',
  '| REPLACE | Implement Spyderbyte-owned behavior; Codex code cannot remain authoritative. |',
  '| REMOVE | Exclude from the product; retain only as provenance/reference evidence. |',
  '| AUDIT | No import or deletion decision until explicit review completes. |',
  '',
  '## File-level inventory',
  '',
  '| File | Bytes | SHA-256 | Decision | Boundary / required review |',
  '|---|---:|---|---|---|',
  ...rows.map(
    (row) =>
      `| \`${row.path}\` | ${row.bytes} | \`${row.hash}\` | ${row.decision} | ${row.boundary} |`,
  ),
  '',
  '## Regeneration and review rule',
  '',
  'Regenerate this file whenever the Codex checkout or audited Spyderbyte CLI boundary changes. A changed path, byte count, or hash requires a new review record before import. The combined snapshot digest is recorded in `UPSTREAM_CODEX.md` and the declarative implementation plan.',
  '',
  '## Classification completeness',
  '',
  `Every one of the ${rows.length} inventoried files has an explicit deterministic migration decision. Codex files outside the approved terminal-mechanics boundary are deliberately marked \`REMOVE\` or \`REPLACE\`; no row remains in an unresolved \`AUDIT\` state.`,
  '',
  '## Import prohibitions',
  '',
  '- Do not import Codex agent orchestration, authentication, ChatGPT/OpenAI account behavior, cloud tasks, telemetry endpoints, thread/rollout persistence, billing, or product-domain semantics.',
  '- Do not add upstream source to Spyderbyte domain packages. Approved source belongs under `vendor/codex-derived/` or the explicitly approved shell crate boundary.',
  '- Do not treat a `KEEP` or `ADAPT` classification as permission to import; the Phase 1 file review and dependency/security checks remain mandatory.',
  '',
  '## Required follow-up artifacts',
  '',
  '- `UPSTREAM_CODEX.md` — source identity, notices, import exclusions, and sync policy.',
  '- `docs/adr/ADR-0038-codex-derived-shell-boundary.md` — accepted shell ownership and packaging boundary.',
  '- `audit-artifacts/2026-08-07-codex-phase-0/migration-audit.md` — license, dependency, security, branding, telemetry, filesystem, and binary audit evidence.',
];

const generated = `${lines.join('\n')}\n`;
if (check) {
  const current = readFileSync(outputPath, 'utf8');
  if (current !== generated) {
    console.error(`Migration matrix is stale: ${outputPath}`);
    process.exitCode = 1;
  }
} else {
  writeFileSync(outputPath, generated, 'utf8');
  console.log(`Generated ${outputPath}`);
  console.log(
    `Codex files: ${codexFiles.length}; Spyderbyte CLI boundary files: ${spyderbyteFiles.length}`,
  );
  console.log(`Combined snapshot digest: sha256:${snapshotDigest}`);
}
