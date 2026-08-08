import eslint from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/.turbo/**',
      '**/coverage/**',
      '**/dist/**',
      '**/node_modules/**',
      'AGENTIC_PLATFORM_IMPLEMENTATION_PLAYBOOK.md',
      'Agentic_Platform_Implementation_Playbook.docx',
      'IMPLEMENTATION_PLAN.md',
      'pnpm-lock.yaml',
    ],
  },
  eslint.configs.recommended,
  {
    files: ['**/*.{js,mjs,cjs,ts,tsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      globals: {
        ...globals.es2022,
        ...globals.node,
      },
    },
  },
  ...tseslint.configs.strict,
  prettier,
);
