import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const scanRoots = ['src/components', 'src/screens'];
const foundationFiles = new Set([
  path.normalize('src/components/icons.tsx'),
  path.normalize('src/components/primitives.tsx'),
]);

function collectFiles(relativeDirectory) {
  const absoluteDirectory = path.join(root, relativeDirectory);
  const files = [];
  for (const entry of readdirSync(absoluteDirectory)) {
    const relativePath = path.join(relativeDirectory, entry);
    const absolutePath = path.join(root, relativePath);
    if (statSync(absolutePath).isDirectory()) {
      files.push(...collectFiles(relativePath));
    } else if (/\.(?:ts|tsx)$/.test(entry)) {
      files.push(relativePath);
    }
  }
  return files;
}

function lineNumber(source, index) {
  return source.slice(0, index).split('\n').length;
}

function lineText(source, index) {
  return source
    .slice(0, source.indexOf('\n', index) === -1 ? source.length : source.indexOf('\n', index))
    .trim();
}

const findings = [];
const checks = [
  {
    name: 'hard-coded color',
    pattern: /#[0-9a-f]{3,8}\b|\b(?:rgb|hsl)a?\s*\(/gi,
  },
  {
    name: 'legacy font or local font declaration',
    pattern: /\b(?:Geist|Inter|Arial|Helvetica|system-ui)\b|\bfontFamily\s*:/gi,
  },
  {
    name: 'hard-coded visual property',
    pattern: /\b(?:fontSize|borderRadius|boxShadow|letterSpacing)\s*:/g,
  },
  { name: 'inline SVG', pattern: /<svg\b/gi },
];

for (const relativePath of scanRoots.flatMap(collectFiles)) {
  const normalizedPath = path.normalize(relativePath);
  if (foundationFiles.has(normalizedPath)) continue;

  const source = readFileSync(path.join(root, relativePath), 'utf8');
  for (const check of checks) {
    for (const match of source.matchAll(check.pattern)) {
      const index = match.index ?? 0;
      findings.push(
        `${relativePath}:${lineNumber(source, index)} ${check.name}: ${lineText(source, index)}`,
      );
    }
  }

  for (const match of source.matchAll(/\bstyle\s*=/g)) {
    const index = match.index ?? 0;
    const context = source.slice(index, index + 260);
    if (!context.includes('--')) {
      findings.push(
        `${relativePath}:${lineNumber(source, index)} page-level inline style: ${lineText(source, index)}`,
      );
    }
  }

  for (const match of source.matchAll(/(?:bg|text|border|from|to)-\[(?:#|rgb|hsl)/gi)) {
    const index = match.index ?? 0;
    findings.push(
      `${relativePath}:${lineNumber(source, index)} non-token utility color: ${lineText(source, index)}`,
    );
  }
}

if (findings.length > 0) {
  console.error('Design-system audit failed:');
  for (const finding of findings) console.error(`- ${finding}`);
  process.exitCode = 1;
} else {
  console.log(
    'Design-system audit passed: active screens and shell use shared tokens, primitives, and registry icons.',
  );
}
