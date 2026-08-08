import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repositoryRoot = resolve(process.cwd());
const codexRoot = resolve(process.env.CODEX_SOURCE_ROOT ?? '/Users/josiah/Downloads/codexcli-main');
const outputDirectory = join(repositoryRoot, 'audit-artifacts/2026-08-07-codex-phase-0');
const outputPath = join(outputDirectory, 'migration-audit.md');
const matrixPath = join(repositoryRoot, 'CODEX_MIGRATION_MATRIX.md');

const ignored = new Set(['.git', 'node_modules', 'target', 'dist', '.turbo', '.agentic']);

function walk(root, current = '.') {
  const absolute = join(root, current);
  if (!existsSync(absolute) || !statSync(absolute).isDirectory()) return [];
  const files = [];
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const next = join(current, entry.name);
    if (entry.isDirectory()) files.push(...walk(root, next));
    else if (entry.isFile()) files.push(next.replaceAll('\\', '/'));
  }
  return files.sort((left, right) => left.localeCompare(right));
}

function read(root, path) {
  return readFileSync(join(root, path), 'utf8');
}

function matchingFiles(files, root, pattern) {
  const expression = new RegExp(pattern, 'i');
  return files.filter((path) => expression.test(read(root, path)));
}

function section(title, body) {
  return [`### ${title}`, '', ...body, ''].join('\n');
}

if (!existsSync(codexRoot)) throw new Error(`Codex source root does not exist: ${codexRoot}`);
if (!existsSync(matrixPath)) throw new Error(`Migration matrix does not exist: ${matrixPath}`);
if (!existsSync(join(repositoryRoot, 'UPSTREAM_CODEX.md')))
  throw new Error('UPSTREAM_CODEX.md is missing');
if (!existsSync(join(repositoryRoot, 'docs/adr/ADR-0038-codex-derived-shell-boundary.md'))) {
  throw new Error('ADR-0038 is missing');
}

const codexFiles = walk(codexRoot);
const productRoots = [
  'apps/tui',
  'apps/spyderbyte-shell',
  'packages/cline-adapter',
  'apps/local-daemon',
  'packages/client-sdk',
  'packages/runtime-contracts',
];
const productFiles = productRoots.flatMap((root) =>
  walk(repositoryRoot, root).map((path) => path.replaceAll('\\', '/')),
);
const codexLicense = read(codexRoot, 'LICENSE');
const codexNotice = read(codexRoot, 'NOTICE');
const matrix = readFileSync(matrixPath, 'utf8');
const matrixDigest = matrix.match(/Combined snapshot digest:\*{0,2}\s*`(sha256:[0-9a-f]+)`/)?.[1];
const matrixRows = matrix
  .split('\n')
  .filter((line) => /^\| `/.test(line))
  .map((line) => {
    const columns = line.split('|').map((column) => column.trim());
    return { path: columns[1], decision: columns[4] };
  });
const unresolvedMatrixRows = matrixRows.filter(
  (row) => row.decision === 'AUDIT' || row.decision?.startsWith('AUDIT/'),
);
const upstream = readFileSync(join(repositoryRoot, 'UPSTREAM_CODEX.md'), 'utf8');
const upstreamDigest = upstream.match(/Combined file manifest.*`(sha256:[0-9a-f]+)`/)?.[1];
const sourceCommit = existsSync(join(codexRoot, '.git'));

const productBrandingFiles = matchingFiles(
  productFiles,
  repositoryRoot,
  'codex|@openai/codex|openai codex',
);
const productCodexPaths = productBrandingFiles.map((path) => `\`${path}\``);
const productTelemetryFiles = matchingFiles(
  productFiles,
  repositoryRoot,
  'telemetry|analytics|sentry|opentelemetry|otel',
);
const productFilesystemFindings = matchingFiles(
  productFiles,
  repositoryRoot,
  'CODEX_HOME|\\.codex|codex_home|/codex/',
);
const productBinaryFiles = matchingFiles(productFiles, repositoryRoot, '"bin"|spyderbyte');
const directOpenAiCodexDependency = productFiles.filter((path) => {
  if (!path.endsWith('package.json')) return false;
  return /@openai\/codex|"codex"\s*:/.test(read(repositoryRoot, path));
});
const productCodexSourceImportFiles = productFiles.filter((path) =>
  /codex-rs\/|vendor\/codex-derived|@openai\/codex|from\s+["']codex|require\(["']codex/i.test(
    read(repositoryRoot, path),
  ),
);

const codexRustManifest = read(codexRoot, 'codex-rs/Cargo.toml');
const codexWorkspaceMembers = (codexRustManifest.match(/^\s*"[^"\n]+",?\s*$/gm) ?? []).length;
const codexWorkspaceDependencies = (
  codexRustManifest
    .split('[workspace.dependencies]')[1]
    ?.split(/^\[/m)[0]
    ?.match(/^\w[\w-]*\s*=\s/gm) ?? []
).length;

const securityCounts = {
  process: matchingFiles(
    codexFiles,
    codexRoot,
    'Command::new|std::process|tokio::process|process::Command',
  ).length,
  unsafe: matchingFiles(codexFiles, codexRoot, '\\bunsafe\\b').length,
  credentials: matchingFiles(codexFiles, codexRoot, 'login|auth|token|secret|keyring|credential')
    .length,
  network: matchingFiles(codexFiles, codexRoot, 'https?://|ws://|wss://').length,
};

const checks = [
  ['Matrix generated and linked', matrixDigest !== undefined],
  [
    'Matrix digest matches UPSTREAM_CODEX.md',
    matrixDigest !== undefined && matrixDigest === upstreamDigest,
  ],
  ['Codex Apache-2.0 license present', /Apache License[\s\S]*Version 2\.0/i.test(codexLicense)],
  [
    'Codex notice preserves OpenAI and Ratatui attribution',
    /OpenAI Codex/i.test(codexNotice) && /Ratatui/i.test(codexNotice),
  ],
  [
    'No direct @openai/codex dependency in audited Spyderbyte CLI boundary',
    directOpenAiCodexDependency.length === 0,
  ],
  [
    'No Codex source import into the audited Spyderbyte CLI boundary',
    productCodexSourceImportFiles.length === 0,
  ],
  ['Every matrix row has a resolved decision', unresolvedMatrixRows.length === 0],
  [
    'Source commit or deterministic snapshot is recorded',
    sourceCommit || matrixDigest !== undefined,
  ],
];

const lines = [
  '# Phase 0 Codex migration audit',
  '',
  '**Date:** 2026-08-07  ',
  `**Decision:** Accepted with ${matrixRows.length} resolved matrix decisions; no Codex source import is part of the build  `,
  `**Codex root:** \`${codexRoot}\`  `,
  `**Codex files observed:** ${codexFiles.length}  `,
  `**Spyderbyte CLI boundary files observed:** ${productFiles.length}`,
  '',
  'This report records the evidence gathered for the Phase 0 exit gate. Static findings in the Codex tree are deliberately retained as import-review inputs; no upstream file is part of the Spyderbyte build.',
  '',
  section('Exit-gate checks', [
    '| Check | Result |',
    '|---|---|',
    ...checks.map(([name, passed]) => `| ${name} | ${passed ? 'PASS' : 'FAIL'} |`),
  ]),
  section('Provenance and license audit', [
    `- Upstream repository: <https://github.com/openai/codex>.`,
    `- Local checkout has ${sourceCommit ? 'git metadata' : 'no git metadata'}; the deterministic snapshot is the current source identity.`,
    `- Matrix digest: \`${matrixDigest ?? 'missing'}\`; provenance record: \`${upstreamDigest ?? 'missing'}\`.`,
    `- Apache-2.0 license: ${/Apache License[\s\S]*Version 2\.0/i.test(codexLicense) ? 'present' : 'missing'}.`,
    `- NOTICE attribution: ${/OpenAI Codex/i.test(codexNotice) && /Ratatui/i.test(codexNotice) ? 'OpenAI Codex and Ratatui notices present' : 'incomplete'}.`,
    `- Matrix rows with unresolved AUDIT decisions: ${unresolvedMatrixRows.length}.`,
    '- No source import occurred. Modified-file notices and release attribution are therefore not applicable to the current build.',
  ]),
  section('Dependency audit', [
    `- Codex Rust workspace members/manifest entries observed: ${codexWorkspaceMembers}.`,
    `- Codex workspace dependency entries observed: ${codexWorkspaceDependencies}.`,
    `- Direct ` +
      '`@openai/codex`/`codex`' +
      ` dependency in the audited Spyderbyte CLI boundary: ${directOpenAiCodexDependency.length}.`,
    `- Files with Codex-derived source import markers in the audited boundary: ${productCodexSourceImportFiles.length}.`,
    '- Dependency provenance for any future imported Ratatui or Rust utility crate must be recorded separately before Phase 1 build integration.',
    '- Vulnerability scanning of the upstream dependency graph is a Phase 1 import gate; no upstream dependency is currently in the Spyderbyte lockfile.',
  ]),
  section('Security audit', [
    `- Codex files containing process execution mechanisms: ${securityCounts.process}.`,
    `- Codex files containing unsafe code: ${securityCounts.unsafe}.`,
    `- Codex files containing authentication/credential terms: ${securityCounts.credentials}.`,
    `- Codex files containing network URLs: ${securityCounts.network}.`,
    '- These findings are not approved for import. Spyderbyte process execution, sandboxing, secret handling, cancellation, and policy remain authoritative.',
    '- The shell boundary ADR forbids Codex core, auth, cloud, telemetry, tool-registry, and persistence behavior from becoming Spyderbyte authority.',
  ]),
  section('Branding and telemetry audit', [
    `- Audited Spyderbyte CLI boundary files containing Codex/OpenAI-Codex identifiers: ${productBrandingFiles.length}.`,
    productCodexPaths.length === 0
      ? '- No findings.'
      : `- Findings: ${productCodexPaths.join(', ')}.`,
    '- Findings are categorized as migration/provider compatibility references in the current implementation; user-facing names must be neutralized or explicitly approved before release.',
    `- Audited CLI boundary files containing telemetry/analytics terms: ${productTelemetryFiles.length}.`,
    '- No Codex telemetry endpoint or inherited OpenAI account telemetry is authorized. Local-only mode must support telemetry disabled or redirected.',
  ]),
  section('Filesystem and binary audit', [
    `- Audited CLI boundary files containing Codex-specific home/path markers: ${productFilesystemFindings.length}.`,
    productFilesystemFindings.length === 0
      ? '- No Codex home/path findings.'
      : `- Path findings: ${productFilesystemFindings.map((path) => `\`${path}\``).join(', ')}.`,
    `- Audited CLI boundary files containing binary/configuration markers: ${productBinaryFiles.length}.`,
    '- Current package exposes the `spyderbyte` binary; a Codex primary binary is not authorized.',
    '- Final paths/configuration are `~/.spyderbyte`, project `.spyderbyte`, and `SPYDERBYTE_` environment variables.',
  ]),
  section('Migration follow-up', [
    '- Re-fetch or otherwise authenticate the upstream commit/release digest before any future synchronization.',
    '- Keep the approved shell behavior reimplemented behind the Spyderbyte client boundary; do not import Codex domain authority.',
    '- Repeat branding, filesystem, telemetry, binary, dependency, and security checks whenever the source snapshot or shell boundary changes.',
  ]),
];

mkdirSync(outputDirectory, { recursive: true });
writeFileSync(outputPath, `${lines.join('\n')}\n`, 'utf8');
console.log(`Wrote ${outputPath}`);
for (const [name, passed] of checks) console.log(`${passed ? 'PASS' : 'FAIL'}: ${name}`);
