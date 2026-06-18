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
]);

export default eslintConfig;
