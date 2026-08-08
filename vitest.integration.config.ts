import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'tests/integration/**/*.test.{ts,tsx}',
      'packages/**/tests/integration/**/*.test.{ts,tsx}',
      'apps/**/tests/integration/**/*.test.{ts,tsx}',
    ],
    passWithNoTests: true,
    reporters: ['dot'],
  },
});
