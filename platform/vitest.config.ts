import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'tests/**/*.test.{ts,tsx}',
      'packages/**/tests/**/*.test.{ts,tsx}',
      'apps/**/tests/**/*.test.{ts,tsx}',
    ],
    passWithNoTests: true,
    reporters: ['dot'],
  },
});
