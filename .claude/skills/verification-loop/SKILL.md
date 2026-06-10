---
name: verification-loop
description: "A comprehensive verification system for Claude Code sessions."
---

# Verification Loop Skill

A comprehensive verification system for Claude Code sessions.

> **This repo (Pokenic_Game) — Windows/PowerShell.** The canonical gate is
> **`npm run check`** (= lint + typecheck + build), which collapses Phases 1-3
> below into one command. Run it first; only drop into the individual phases when
> you need to isolate a failure. Bash-only constructs (`grep -rn`, `2>&1 | tail`,
> `2>/dev/null`) fail in PowerShell — the phases below use PowerShell-safe forms
> or the Grep tool.

## When to Use

Invoke this skill:
- After completing a feature or significant code change
- Before creating a PR
- When you want to ensure quality gates pass
- After refactoring

## Verification Phases

### Phases 1-3: Build + Types + Lint (one gate for this repo)
```bash
# Canonical gate — runs lint + typecheck + build together
npm run check
```

If `npm run check` fails, STOP and fix before continuing. Use the isolated
commands below only to narrow down which stage failed.

### Phase 1: Build Verification
```bash
# Check if project builds
npm run build
# OR
pnpm build
```

If build fails, STOP and fix before continuing.

### Phase 2: Type Check
```bash
# TypeScript projects
npx tsc --noEmit

# Python projects
pyright .
```

Report all type errors. Fix critical ones before continuing.

### Phase 3: Lint Check
```bash
# JavaScript/TypeScript
npm run lint

# Python
ruff check .
```

### Phase 4: Test Suite
```bash
# Run tests with coverage
npm run test -- --coverage
```

**This repo:** the primary test signal is **Playwright visual-regression
`scripts/*.mjs`** (capture/measure/QA), not a unit-test runner — verify those
against the production build (`npm run build` + `npx next start -p 4000`). The
80% coverage target applies to **genuine logic only** (`src/lib/*` utilities,
`src/hooks/*`, backend endpoints); presentational/visual components are covered
by visual regression instead, not by markup-assertion coverage.

Report:
- Total tests: X
- Passed: X
- Failed: X
- Coverage: X%

### Phase 5: Security Scan

Use the **Grep tool** for these scans (cross-platform, integrates with the
permission UI). The PowerShell equivalents below also work on Windows:

```powershell
# Check for secrets (recursive)
Get-ChildItem -Recurse -Include *.ts,*.js | Select-String -Pattern "sk-","api_key" -List

# Check for console.log (recursive)
Get-ChildItem src -Recurse -Include *.ts,*.tsx | Select-String -Pattern "console\.log" -List
```

> This scan overlaps the **security-review** skill — use that skill for a
> deeper secrets / input-validation / auth audit.

### Phase 6: Diff Review
```bash
# Show what changed
git diff --stat
git diff HEAD~1 --name-only
```

Review each changed file for:
- Unintended changes
- Missing error handling
- Potential edge cases

## Output Format

After running all phases, produce a verification report:

```
VERIFICATION REPORT
==================

Build:     [PASS/FAIL]
Types:     [PASS/FAIL] (X errors)
Lint:      [PASS/FAIL] (X warnings)
Tests:     [PASS/FAIL] (X/Y passed, Z% coverage)
Security:  [PASS/FAIL] (X issues)
Diff:      [X files changed]

Overall:   [READY/NOT READY] for PR

Issues to Fix:
1. ...
2. ...
```

## Continuous Mode

For long sessions, run verification every 15 minutes or after major changes:

```markdown
Set a mental checkpoint:
- After completing each function
- After finishing a component
- Before moving to next task

Run: /verify
```

## Integration with Hooks

This skill complements PostToolUse hooks but provides deeper verification.
Hooks catch issues immediately; this skill provides comprehensive review.
