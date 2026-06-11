# Agent Orchestration

## Available review tooling

The ECC plugin was uninstalled (2026-06-11) — `ecc:*` agents and `/ecc:*` slash
commands no longer resolve. Use these instead:

| Tool | Purpose | When to use |
|---|---|---|
| `/code-review` (built-in skill) | Code review of the current diff | After writing substantive code |
| `/security-review` (built-in skill) | Security review of pending changes | Auth/input/secrets/endpoints/payments |
| `coderabbit:code-review` skill / `coderabbit:code-reviewer` agent | AI-powered review via CodeRabbit | Explicit review requests, PR reviews |
| Built-in `Plan` agent | Implementation planning | Complex features, refactoring |
| Built-in `Explore` agent | Read-only codebase exploration | Broad fan-out searches |

> **Worktrees in this repo:** follow the superpowers `using-git-worktrees` skill
> for isolated feature work (user preference, 2026-06-11 — consent pre-granted,
> don't re-ask). Prefer the native `EnterWorktree` tool; fallback
> `git worktree add .worktrees/<branch> -b <branch>` (`.worktrees/` is
> gitignored). Run `npm install` in a fresh worktree before building. Only
> *background-agent* worktree isolation stays off (`worktree.bgIsolation: none`
> in `.claude/settings.local.json`).

## What is actually enforced vs. advisory

Be honest about the gates — the config must not imply automation that isn't there:

- **Enforced in code** (`.claude/settings.json` hooks): a **PostToolUse typecheck**
  after every `.ts`/`.tsx` edit, and a **Stop hook** that type-checks the
  storefront + backend and blocks finishing on real type errors. `medusa develop`
  / `next dev` are transpile-only (no type-check), so this hook is the real
  "builds green" gate — it is the *only* automatic quality gate.
- **Advisory / operator-invoked** (NOT auto-enforced): everything else. No hook
  forces a review, TDD, or security pass to run — you must invoke them. They are
  strong recommendations, not guarantees, so don't assume they ran.

## Recommended usage (advisory)

Invoke when the task warrants it — recommendations, not automatic triggers:

1. Complex feature / refactor → plan first (Plan agent or plan mode).
2. After writing substantive code → `/code-review` or `coderabbit:code-review`.
3. New behavioral logic (utilities, hooks, backend) → write tests first.
   Presentational/visual work is covered by the Playwright capture/compare loop
   instead — see web/testing.md.
4. Security-sensitive change (auth, user input, secrets, endpoints, payments) →
   `/security-review`.

## Parallel Task execution

Use parallel Task execution for genuinely independent operations:

```markdown
# GOOD: independent work fanned out in one message
1. Security analysis of auth module
2. Performance review of cache system
3. Type checking of utilities

# BAD: sequential when there is no dependency
First agent 1, then agent 2, then agent 3
```

Don't force parallelism onto a dependency chain (e.g. migrate → probe → verify is
sequential); fan out only the steps that are actually independent.

## Multi-perspective analysis

For complex problems, use split-role sub-agents:
- Factual reviewer
- Senior engineer
- Security expert
- Consistency reviewer
- Redundancy checker
