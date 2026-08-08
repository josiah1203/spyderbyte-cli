import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'tests/invariants/**/*.test.ts',
      'packages/**/tests/invariants/**/*.test.ts',
      'apps/**/tests/invariants/**/*.test.ts',
    ],
    passWithNoTests: true,
    reporters: ['dot'],
  },
});
