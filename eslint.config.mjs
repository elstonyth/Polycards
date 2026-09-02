import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    '.next/**',
    // scripts/serve-standalone.ps1 copies the standalone bundle here
    // (gitignored) — without this, lint after a local serve reports thousands
    // of phantom problems in build output.
    '.next-serve/**',
    'out/**',
    'build/**',
    'next-env.d.ts',
    // The Medusa + Mercur backend is a separate project with its own toolchain.
    'backend/**',
    // Claude Code session worktrees are full repo copies nested under the
    // project root; without this their backend/ files leak past the ignore
    // above (different path prefix) and fail lint mid-session.
    '.claude/worktrees/**',
    // superpowers `using-git-worktrees` worktrees live here (gitignored). They
    // are full repo copies too — without this, `npm run lint` from the main
    // checkout traverses the nested copy and reports thousands of phantom
    // problems. CI is unaffected (fresh checkout has no .worktrees/).
    '.worktrees/**',
    // Scratch / orphaned tool worktree copies (gitignored) — same nested-repo
    // pollution as above. CI never sees these.
    '.clone/**',
    // Agent skill tooling (excluded via .git/info/exclude, so it is local-only
    // and CI never sees it either). These are standalone scripts on their own
    // conventions — validate-findings.cjs is CommonJS, where `require()` is the
    // only import form, so @typescript-eslint/no-require-imports flagged it as
    // two hard errors and made `npm run lint` exit 1 on a clean checkout.
    '.agents/**',
  ]),
  // The scripts/ dir is one-off Playwright capture/measure/QA tooling (see
  // CLAUDE.md "the clone workflow"), not product code. Linting it for unused
  // locals / bare expressions is pure noise — many of these scripts keep
  // scratch bindings and standalone awaited expressions by design. Relax those
  // two rules here so `npm run lint` over scripts/ stays signal, not warnings.
  {
    files: ['scripts/**/*.{mjs,cjs,js,ts}'],
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-unused-expressions': 'off',
    },
  },
  // The `const { a: _a, ...rest } = obj` omit idiom is how the data tests build
  // partial backend payloads. Without ignoreRestSiblings each omitted key is a
  // phantom unused-var warning, so the codebase would have to litter disables
  // for a deliberate pattern. `^_` also covers intentionally-unused bindings.
  // Scoped to test files on purpose: in product code an unused binding is a
  // signal worth keeping, and only the tests use the omit idiom.
  {
    files: ['src/**/__tests__/**/*.{ts,tsx}', 'src/**/*.test.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          ignoreRestSiblings: true,
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
  // Enforce the single-entry Zod contract: src/lib/data/schemas.ts sets
  // `z.config({ jitless: true })` so Zod 4's JIT parser never calls `new
  // Function` — which our CSP `script-src` forbids ('unsafe-eval' is absent, see
  // src/lib/security/csp.ts). A direct `zod` import anywhere else would bypass
  // that config and reintroduce CSP eval violations, so route all Zod use through
  // schemas.ts.
  {
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'zod',
              message:
                "Import Zod via '@/lib/data/schemas' — it sets z.config({ jitless: true }) so the JIT parser can't trigger a CSP 'unsafe-eval' violation.",
            },
          ],
          patterns: [
            {
              group: ['zod/*'],
              message:
                "Import Zod via '@/lib/data/schemas' (keeps the jitless CSP-safe config the single source of truth).",
            },
          ],
        },
      ],
    },
  },
  // schemas.ts IS the single Zod entry point — it must import zod directly.
  {
    files: ['src/lib/data/schemas.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
]);

export default eslintConfig;
