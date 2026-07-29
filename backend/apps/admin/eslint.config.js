import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';
import { defineConfig, globalIgnores } from 'eslint/config';

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Medusa admin routes must `export const config` (defineRouteConfig) from
      // page.tsx for nav — it's a required framework export, not a refactor smell.
      'react-refresh/only-export-components': [
        'error',
        { allowConstantExport: true, allowExportNames: ['config'] },
      ],
    },
  },
  // Type-aware linting, deliberately scoped to src/ and to ONE rule.
  //
  // `await-thenable` is the only gate in this app that catches an `await` on
  // a non-Promise. Not hypothetical: drop the expression body of
  // useInvalidateInventory (lib/queries.ts) and it silently returns void, the
  // bulk register tool's `await invalidateInventory()` resolves before the
  // table has refetched, and BOTH `tsc -b` and this config without the rule
  // stay green -- awaiting a non-Promise is legal TypeScript. Measured
  // 2026-07-29 across src/: 0 violations, so it costs no cleanup.
  //
  // `no-floating-promises`, the other obvious candidate, was measured at the
  // same time and is NOT enabled: 44 violations, every one a
  // `qc.invalidateQueries(...)` inside a react-query `onSuccess`. That is
  // idiomatic fire-and-forget, not a defect, so it would buy 44 `void`
  // prefixes and no behaviour. Re-measure before reconsidering.
  //
  // ponytail: scoped to `src/**` because vitest.config.ts belongs to no
  // tsconfig `include` here and the project service refuses a file it cannot
  // place ('was not found by the project service'). Widen only after that file
  // joins tsconfig.node.json. Type-aware parsing costs ~3s here (4.4s -> 7.7s).
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/await-thenable': 'error',
    },
  },
]);
