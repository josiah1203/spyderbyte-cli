import { execFileSync } from 'node:child_process';

const trackedFiles = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);

const forbiddenPathPatterns = [
  /(^|\/)node_modules(\/|$)/i,
  /(^|\/)(target|dist|frontend-dist|coverage|\.turbo|\.cache|tmp)(\/|$)/i,
  /(^|\/)(\.agentic|\.agentic-workspace)(\/|$)/i,
  /(^|\/)\.DS_Store$/i,
];

const violations = trackedFiles.filter((file) =>
  forbiddenPathPatterns.some((pattern) => pattern.test(file)),
);

if (violations.length > 0) {
  console.error('Tracked generated or machine-local artifacts detected:');
  for (const violation of violations) console.error(`- ${violation}`);
  process.exitCode = 1;
} else {
  console.log(`Tracked-artifact check passed for ${trackedFiles.length} files.`);
}
