# Plan 129: OPERATOR-APPLIED — the round-14 fixes whose files are gitignored

> **This plan is not worktree-dispatchable and must not be handed to an
> executor subagent.** Every file below is gitignored (`.gitignore:105-119`),
> so it does not exist in a git worktree, and anything written there would
> never be committed, never reach a PR, and never merge. Apply these by hand in
> the main checkout at `C:\Users\PC\Desktop\Projects\PixelSlot`.
>
> Precedent: plan 043 was handled the same way ("OPERATOR-APPLIED — untracked
> file, not worktree-dispatchable").

## Status

- **Priority**: P2 (the hook item is P1 for anyone editing `@acme/odds-math`)
- **Effort**: S–M
- **Risk**: LOW — none of it ships to production; it changes local tooling and
  the instructions agents read
- **Depends on**: PR #500 (plan 128) for the ADR 0004 holder list this mirrors
- **Category**: dx / docs
- **Planned at**: commit `affaab51`, 2026-08-26

## Why this matters

Round 14 found four defects that live entirely in gitignored files. They are
real, but no PR can carry them:

1. The **edit-time typecheck hook silently passes** for `@acme/odds-math`,
   `@acme/pokemon` and `apps/vendor`. Editing the odds/money package produces a
   green hook that checked nothing.
2. `CLAUDE.md` calls `/task` a **placeholder**. It is slot 1 of the primary tab
   bar and a live money-adjacent surface. `/referral` and `/privacy` are absent
   from the route list entirely.
3. `CLAUDE.md`'s **kept-orphan registry names a file #490 deleted**, which is
   how the deletion went unnoticed. The registry is what the "grep SUSPENDED
   before deleting" rule depends on.
4. `AGENTS.md` — the file that **regenerates four other agent instruction
   files** — still mandates pixel-perfect 1:1 emulation of a reference site that
   no longer exists, against `PRODUCT.md`'s own mobile-first redesign direction.
   It also contradicts `CLAUDE.md` on which MCP is primary, with no stated
   precedence.

---

## Item 1 — Close the typecheck-hook blind spots (the P1 here)

**Files**: `.claude/hooks/_tslib.js`, `.claude/hooks/post-edit-typecheck.js`,
`.claude/hooks/stop-verify.js`

### The defect

`_tslib.js` defines three projects: `storefront`, `backend`
(= `backend/packages/api`) and `admin`. `post-edit-typecheck.js:31-35` routes
any path containing `/backend/` that is not admin into the `backend` bucket —
whose tsconfig program does **not** contain `packages/odds-math`,
`packages/pokemon` or `apps/vendor`. tsc runs over a program with none of your
files in it and returns `pass`.

`stop-verify.js:62-66` has the same gap: three `runTsc` calls for six TS
projects.

This is the exact bug the `admin` entry's own comment says it was added to fix:

```js
// The admin dashboard (Vite SPA) is a SEPARATE TS project from the API — its
// files aren't in backend/packages/api's program, so without this entry every
// edit under backend/apps/admin/** was silently type-unchecked (both hooks
// routed "/backend/" -> the api bucket). tsc is the workspace-hoisted binary.
```

`@acme/odds-math` is not dormant — it is a declared workspace dependency of
`packages/api` and CI builds it ahead of every backend test job.

### What to do

In `.claude/hooks/_tslib.js`, add three entries to `PROJECTS`, each modelled on
the existing `admin` entry:

| key        | cwd                          | tsc binary                                | cache                                                     |
| ---------- | ---------------------------- | ----------------------------------------- | --------------------------------------------------------- |
| `oddsMath` | `backend/packages/odds-math` | `backend/node_modules/typescript/bin/tsc` | that package's `node_modules/.cache/tsc-hook.tsbuildinfo` |
| `pokemon`  | `backend/packages/pokemon`   | same                                      | same pattern                                              |
| `vendor`   | `backend/apps/vendor`        | same                                      | same pattern                                              |

**Pick each tsconfig by checking it, not by guessing.** Run from that package's
directory:

```bash
cd backend/packages/odds-math
../../node_modules/.bin/tsc -p tsconfig.json --listFiles | grep -c "src/"
```

A count of **0** means you picked a references stub (`files: []`), which runs
tsc, exits 0 and checks nothing — the same false green this repo already hit
with the admin `tsconfig.json`. `apps/vendor` will most likely need
`tsconfig.app.json`, as admin does. Record the count you got for each.

In `.claude/hooks/post-edit-typecheck.js`, extend the bucket chain
**most-specific-first**, so the new package paths are tested before the generic
`/backend/` fallback:

```js
const key = norm.includes('/backend/apps/admin/')
  ? 'admin'
  : norm.includes('/backend/apps/vendor/')
    ? 'vendor'
    : norm.includes('/backend/packages/odds-math/')
      ? 'oddsMath'
      : norm.includes('/backend/packages/pokemon/')
        ? 'pokemon'
        : norm.includes('/backend/')
          ? 'backend'
          : 'storefront';
```

In `.claude/hooks/stop-verify.js`, add the three new `runTsc` calls to the
`results` array with the same 120000 ms timeout the other package-scale checks
use.

### Verify

```bash
node --check .claude/hooks/_tslib.js
node --check .claude/hooks/post-edit-typecheck.js
node --check .claude/hooks/stop-verify.js
```

Then prove the routing actually works, rather than assuming: make a trivial
edit to a file under `backend/packages/odds-math/src/` in a session and confirm
the hook reports the `backend/packages/odds-math` label rather than
`backend/packages/api`. The cheapest real proof is to introduce a deliberate
type error there and confirm the hook **blocks** — then revert it.

---

## Item 2 — `CLAUDE.md` route list

**File**: `CLAUDE.md`, in the "Architecture" section.

### Current text (wrong)

> **Routes** (`src/app/`, App Router): `/` (home), `/slots`, `/how-it-works`,
> `/leaderboard` (Ranks — also hosts the Weekly Pulled Value Challenge),
> `/task` (placeholder), plus `/about`, `/contact`, `/fairness`, `/download`,
> `/bank-withdrawal`, `/reset-password`, `/auth/google/failed`, the account
> tree, and the dynamic `/slots/[slug]`, `/slots/[slug]/spin`,
> `/profile/[user]`, `/card/[handle]`.

Two errors: `/task` is **not** a placeholder — it is the tasks/achievements hub
and slot 1 of the primary tab bar — and `/referral` and `/privacy` are missing.

### The real inventory at `affaab51`

27 page routes:

```
/                        /(account)/addresses     /(account)/bank
/(account)/me            /(account)/notifications /(account)/orders
/(account)/settings      /(account)/transactions  /(account)/vault
/(account)/wallet        /about                   /auth/google/failed
/bank-withdrawal         /card/[handle]           /contact
/download                /fairness                /how-it-works
/leaderboard             /privacy                 /profile/[user]
/referral                /reset-password          /slots
/slots/[slug]            /slots/[slug]/spin       /task
```

8 route handlers:

```
/api/cards/[handle]  /api/free-pack  /api/me  /api/pack-detail/[slug]
/api/recent-pulls    /auth/google/callback     /healthz  /invite/[handle]
```

Reproduce with:

```bash
find src/app -name 'page.tsx' | sed 's|src/app||;s|/page.tsx||;s|^$|/|' | sort
find src/app -name 'route.ts' | sed 's|src/app||;s|/route.ts||' | sort
```

### Also in `CLAUDE.md`, same section

The deletion-history paragraph still says of `/referrals` and `/invite/[handle]`
that "those paths are free for the new system to claim". **The new system
claimed them on 2026-08-25** — `/referral` is a live page and
`/invite/[handle]/route.ts` is a live handler. Mark them claimed, with the date.

---

## Item 3 — `CLAUDE.md` kept-orphan registry

### Current text (wrong)

> Current holders: `src/lib/actions/daily.ts`, `format.ts voucherLabel`,
> `components/rewards/PrizeReveal.tsx`, `components/rewards/WithdrawForm.tsx`.

`src/components/rewards/PrizeReveal.tsx` **does not exist**. It was deleted by
`1ad7bdd5` (#490) — the same PR this round audited. Confirm with:

```bash
git log --oneline --diff-filter=D -1 -- src/components/rewards/PrizeReveal.tsx
ls src/components/rewards/
```

### What to do

**Mirror ADR 0004's corrected list, do not regenerate independently.** PR #500
(plan 128) rewrites `docs/adr/0004-reward-economy-suspension.md` with the
verified reward-economy holder set and documents why a naive grep is wrong.
Once #500 is merged, copy that list into `CLAUDE.md` so the two agree.

**Do not use `grep -rl SUSPENDED src/` as the source.** It is wrong in both
directions, which is exactly how this drifted:

- It **misses** `src/lib/format.ts:40`, whose note is lowercase ("UNUSED while
  the reward surfaces are suspended").
- It **sweeps in** `src/components/account/credit-dot.tsx` and
  `src/components/app-shell/TopUpProvider.tsx`, which belong to the **2026-08-11
  money-dot removal** — a different suspension from ADR 0004's reward economy.

A case-insensitive grep returns 16 files, most of them incidental mentions.
Neither grep is a substitute for the curated list.

### Worth doing at the same time

The registry has now drifted once, silently. Making it checkable is a small
change: add a comparison to the existing `scripts/qa-suspend-surfaces.mjs` gate
so the build fails when the registry and the tree disagree. That script is
tracked, so unlike everything else in this plan it _can_ go through a PR — it is
recorded here only so the idea is not lost.

---

## Item 4 — `AGENTS.md`, and the four files it regenerates

**File**: `AGENTS.md`. After editing, you **must** run:

```bash
bash scripts/sync-agent-rules.sh
```

That regenerates `.clinerules`, `.continue/rules/project.md`,
`.amazonq/rules/project.md` and `.github/copilot-instructions.md`. Some of those
are tracked and some are not — the tracked ones will show up as a normal diff
and can be committed in a follow-up PR.

### 4a — The emulation mandate is obsolete

Current text under "Design Principles":

> - **Pixel-perfect emulation** — match the target's spacing, colors,
>   typography exactly
> - **No personal aesthetic changes during emulation phase** — match 1:1 first,
>   customize later

There is no target left to match. `CLAUDE.md` says the reference site "is no
longer tracked here and the live-capture tooling has been removed";
`PRODUCT.md` mandates a from-scratch mobile-first redesign; `DESIGN.md`
explicitly rejects the reference's chrome.

Every agent building a new storefront surface currently inherits "match the
target 1:1, no aesthetic changes" — the exact opposite of the direction chosen.

Replace those two bullets with the current contract: `DESIGN.md` is the
authoritative visual system, `PRODUCT.md` carries the register and
anti-references, and new work is designed against those rather than copied from
a reference.

### 4b — Two contradictory "always do this first" MCP mandates

`AGENTS.md` says:

> **IMPORTANT: This project has a knowledge graph. ALWAYS use the
> code-review-graph MCP tools BEFORE using Grep/Glob/Read to explore the
> codebase.**

`CLAUDE.md` says:

> ## Code exploration: codebase-memory MCP is primary
>
> …**All code exploration** … use the codebase-memory MCP

`AGENTS.md` is imported at the top of `CLAUDE.md`, so both land in the same
context with **no stated precedence** — and `CLAUDE.md` claims `AGENTS.md`
holds nothing repo-specific, while it holds this.

`CLAUDE.md`'s note is the later, benchmarked, repo-specific decision
(2026-07-06). State that precedence explicitly in one place, and keep the
MCP guidance in exactly **one** source — right now the same text exists both in
`AGENTS.md` and in the `sync-agent-rules.sh` heredoc, with no equality gate
between them.

---

## Item 5 — `PRODUCT.md` factual corrections

**File**: `PRODUCT.md`. Three claims are now false:

1. "a **two-tier referral program** drive[s] retention" and "the VIP +
   **two-tier** referral economy". ADR 0007 removed that programme; the
   replacement is explicitly single-tier — `CONTEXT.md` says "Direct referrals
   only — no generations", and `modules/packs/referral.ts` has no generation
   concept.
2. **`series`** is listed as a product surface. That route was deleted
   2026-07-20 and does not exist in `src/app/`.
3. **`marketplace`** likewise.

`PRODUCT.md:46` also scopes the planned redesign over `series`, i.e. over a
route that is not there — worth fixing in the same pass so a future design task
is not scoped onto nothing.

These are factual corrections only. The strategic decisions in that file —
whether to retire or restore the suspended reward economy, and how the redesign
should proceed — are yours and are not touched here.

---

## Done criteria

- [ ] `node --check` passes on all three hook files
- [ ] For each of the three new hook projects you recorded a tsconfig and a
      `--listFiles | grep -c "src/"` count **greater than 0**
- [ ] A deliberate type error under `backend/packages/odds-math/src/` makes the
      post-edit hook **block**, and reverting it makes the hook pass
- [ ] `CLAUDE.md`'s route list matches the `find` output above, `/task` is no
      longer called a placeholder, and `/referral` + `/privacy` appear
- [ ] `CLAUDE.md`'s kept-orphan list matches ADR 0004's corrected list, and
      `PrizeReveal.tsx` appears only as a recorded deletion
- [ ] `AGENTS.md` no longer mandates pixel-perfect emulation, and states MCP
      precedence once
- [ ] `bash scripts/sync-agent-rules.sh` has been run, and any tracked copies it
      changed are committed
- [ ] `PRODUCT.md` no longer says "two-tier", "series" or "marketplace"

## Notes

- None of this ships to production. It changes local tooling and the
  instructions agents read — which is precisely why it has drifted unnoticed:
  no gate touches any of it.
- Item 1 is the one with teeth. Items 2–5 are documentation truth; item 1 is a
  quality gate that currently reports green on unchecked code, on the package
  that computes odds.
- Deliberately **not** included: rewriting `AGENTS.md`'s worktree guidance or
  the MCP tool table, which are both current and correct.
