# Plan 107: Make the free-pack QA gate able to pass on a seeded database

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 16cc85d3..HEAD -- scripts/qa-free-pack.mjs backend/packages/api/src/scripts/seed-e2e-fixtures.ts backend/packages/api/src/api/admin/packs/`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `16cc85d3`, 2026-08-18

## Why this matters

The nightly E2E workflow runs `npm run qa:free-pack` as a gate. That gate has
**never passed a single time** since it was wired in on 2026-08-15 — it is not
a regression, it has produced no signal at all, and its failure is the whole
job's conclusion, so the nightly has reported RED on 08-15, 08-16 and 08-17
for a reason that has nothing to do with the code under test. A permanently red
nightly is worse than no nightly: the next real regression arrives into a
signal everyone has already learned to ignore.

The cause is a slot collision, not a flake. The E2E seed creates an **active**
pack in the reserved `free_welcome` category, the admin API allows exactly one
active pack in that category, and the QA script then tries to activate a second
one. It fails deterministically, every run, on a correctly seeded database.

After this plan: the gate runs green on a seeded CI database and on a bare dev
database, and a genuine free-pack regression is the only thing that turns it
red.

## Current state

### The three files that produce the collision

- `backend/packages/api/src/scripts/seed-e2e-fixtures.ts` — the `seed:e2e`
  fixture the nightly runs before the gates. It creates a free pack and marks
  it **active**:

```ts
// backend/packages/api/src/scripts/seed-e2e-fixtures.ts:62
const FREE_PACK_SLUG = 'free-welcome';

// :212-224
  const freePack = {
    slug: FREE_PACK_SLUG,
    title: 'Free Welcome Pack',
    price: 0,
    buyback_percent: 90,
    image: '/images/polycards/free-pack-badge.webp',
    display_image: null as string | null,
    rank: PROD_PACKS.length,
    category: 'free_welcome',
    cards: [...],
  };

// :240-249 — `fields()` is applied to every pack in `allPacks`, freePack included
  const fields = (p: (typeof allPacks)[number]) => ({
    ...
    status: 'active' as const,
    in_stock: true,
  });
```

The stray sweep further down **deliberately skips** this category, so nothing
in the seed ever deactivates a competing free pack either:

```ts
// backend/packages/api/src/scripts/seed-e2e-fixtures.ts:296-301
const strays = activePacks.filter(
  (p) =>
    !mirrored.has(p.slug) &&
    p.category !== 'reward_box' &&
    p.category !== 'free_welcome',
);
```

- `backend/packages/api/src/api/admin/packs/[slug]/route.ts` — the admin update
  route enforces one live free pack:

```ts
// backend/packages/api/src/api/admin/packs/[slug]/route.ts:65-73
// Only ONE free_welcome pack may be live. Re-saving the pack that IS the live
// one passes (same slug); activating a second one 400s.
const packs: PacksModuleService = req.scope.resolve(PACKS_MODULE);
assertSingleActiveFreePack(
  input.category === FREE_WELCOME_CATEGORY
    ? ((await packs.getActiveFreePack())?.slug ?? null)
    : null,
  input,
);
```

and the validator it calls (`backend/packages/api/src/api/admin/packs/validate.ts:274-290`)
raises a 400 whenever the live slug differs from the incoming one.

- `scripts/qa-free-pack.mjs` — the gate. It mints its **own** pack under a
  different slug and activates it:

```js
// scripts/qa-free-pack.mjs:25
const SLUG = 'qa-free-welcome';

// :80-91
const packBody = {
  slug: SLUG,
  title: 'QA Free Welcome Pack',
  category: 'free_welcome',
  price: 0,
  image: '/images/polycards/bronze-pack.webp',
  buyback_percent: 90,
  boost: false,
  rank: 0,
  status: 'draft', // activate only once the pool exists (activation guard)
};

// :127-137
let activated = false;
let browser = null;
try {
  const activate = await fetch(`${API}/admin/packs/${SLUG}`, {
    method: 'POST',
    headers: AH,
    body: JSON.stringify({ ...packBody, status: 'active' }),
  });
  if (!activate.ok) {
    throw new Error(`could not activate '${SLUG}' — ${activate.status}`);
  }
  activated = true;
```

and hands the slot back at the end:

```js
// scripts/qa-free-pack.mjs — the finally block (last ~14 lines of the file)
} finally {
  if (browser) await browser.close();
  // Hand back the single-active-`free_welcome` slot. Left active, this QA pack
  // blocks the next activation of ANY free pack (the admin validation allows
  // exactly one) — including the next run of this script and the local seed
  // fixture. Draft, not DELETE: the run's pulls still reference it.
  if (activated) {
    const teardown = await fetch(`${API}/admin/packs/${SLUG}`, {
      method: 'POST',
      headers: AH,
      body: JSON.stringify({ ...packBody, status: 'draft' }),
    });
    if (teardown.ok) ok(`'${SLUG}' set back to draft (slot released)`);
    else fail(`teardown: '${SLUG}' is still active — ${teardown.status}`);
  }
}
```

`free-welcome` (seeded, active) ≠ `qa-free-welcome` (the gate's) → the
activation is refused with 400 and the script throws before a single browser
assertion runs.

### The evidence this is what is happening in CI

Three consecutive nightly runs, all failing the same step, all with the same
log line:

```
✗ could not activate 'qa-free-welcome' — 400
##[error]Process completed with exit code 1.
```

- <https://github.com/elstonyth/Polycards/actions/runs/32055746233> (2026-08-17)
- <https://github.com/elstonyth/Polycards/actions/runs/31964612146> (2026-08-16)
- <https://github.com/elstonyth/Polycards/actions/runs/31901152061> (2026-08-15)

(The 08-13 and 08-14 nightlies failed a _different_ step, "Run E2E"; that was
addressed separately by PR #457. Do not conflate the two.)

### The workflow step that runs it

```yaml
# .github/workflows/e2e.yml — added 2026-08-15
- name: Run free-pack QA gate
  id: qafp
  if: always()
  env:
    PW_BASE: http://localhost:4000
    QA_ADMIN_EMAIL: admin@polycards.local
    QA_ADMIN_PASSWORD: ${{ secrets.PW_ADMIN_PASSWORD || '...' }}
  run: npm run qa:free-pack
```

The workflow does **not** need to change. Only the script does.

### The admin list endpoint you will use

`GET /admin/packs` returns every pack, each carrying `slug`, `category` and
`status` (see `backend/packages/api/src/api/admin/packs/route.ts:195-201`).
It is cached 30 s in-process, but the pack-update route calls `bustPackCaches()`
on every write, so a draft you write is reflected on the next read. You do not
re-read the list after writing in this plan anyway.

### Repo conventions this script follows

- Plain ESM `.mjs` under `scripts/`, run with bare `node`, Playwright driven,
  `ok()` / `fail()` helpers, `process.exitCode = 1` on failure (never
  `process.exit` mid-run, so all assertions report).
- Admin credentials from env only, never hardcoded — `QA_ADMIN_EMAIL` /
  `QA_ADMIN_PASSWORD` (`scripts/qa-free-pack.mjs:36-41`).
- Every mutation the script makes is reversed in the single `finally` block,
  gated on a boolean recording that the mutation actually happened
  (`activated`, `browser`). Follow that exact shape for the new mutation.
- Comments in this repo explain **why**, at length, in full sentences. Match
  that density — an unexplained `if` in a teardown path is how the next reader
  deletes it.

## Commands you will need

| Purpose                 | Command                                 | Expected on success                                        |
| ----------------------- | --------------------------------------- | ---------------------------------------------------------- |
| Storefront lint         | `npm run lint`                          | exit 0                                                     |
| Format check            | `npm run format:check`                  | exit 0 (**separate from `npm run check`, which omits it**) |
| Typecheck               | `npm run typecheck`                     | exit 0, no errors                                          |
| Storefront unit tests   | `npm test`                              | 622+ passing, 0 failing                                    |
| Syntax check the script | `node --check scripts/qa-free-pack.mjs` | exit 0, no output                                          |

`scripts/qa-free-pack.mjs` is JavaScript, not TypeScript — `npm run typecheck`
does not cover it. `node --check` is the syntax gate; `npm run format:check`
covers its formatting (prettier is configured over `src` **and** `scripts`, see
`package.json` `"format:check": "prettier --check src scripts"`).

### Running the gate locally (optional, see STOP conditions before trying)

A full local run needs the backend on `:9000`, a production storefront build
served on a port, and an admin login. Per `CLAUDE.md`, never verify on
`next dev`:

```
npm run build
pwsh scripts/serve-standalone.ps1 -Port 4000
```

then, from `backend/packages/api`, `corepack yarn dev`, and finally:

```
QA_ADMIN_EMAIL=... QA_ADMIN_PASSWORD=... PW_BASE=http://localhost:4000 node scripts/qa-free-pack.mjs
```

This is **not required** to complete the plan — the static verifications below
are the gate. If you cannot bring the stack up, say so in your report and rely
on the static checks.

## Scope

**In scope** (the only files you should modify):

- `scripts/qa-free-pack.mjs`
- `plans/README.md` (status row only)

**Out of scope** (do NOT touch, even though they look related):

- `backend/packages/api/src/scripts/seed-e2e-fixtures.ts` — the seed creating
  an active free pack is correct and load-bearing: the storefront's free-pack
  badge and the `slot-vault-room` / catalog specs need a real free pack in the
  E2E catalog. Do not stop seeding it, do not change its slug, and do not add
  `free_welcome` to the stray sweep.
- `backend/packages/api/src/api/admin/packs/[slug]/route.ts` and
  `backend/packages/api/src/api/admin/packs/validate.ts` — the
  one-active-free-pack rule is a deliberate product invariant. Relaxing it to
  make a QA script pass would trade a real guard for a test convenience.
- `.github/workflows/e2e.yml` — the step is wired correctly; the script is what
  is broken.
- Any assertion inside `qa-free-pack.mjs`. This plan changes **setup and
  teardown only**. The body of the run must keep testing exactly what it tests
  today.

## Git workflow

- Branch: `advisor/107-free-pack-qa-gate`
- Conventional commits, matching `git log` style, e.g.
  `fix(qa): let the free-pack gate borrow the single active free_welcome slot`
- Do NOT push or open a PR unless the operator instructed it.

## Approach (decided — do not substitute another)

Two designs were considered:

- **(a) Adopt the seeded pack** — discover the live `free_welcome` pack and run
  the assertions against it instead of minting one. Rejected: it needs a
  mint-anyway fallback for a bare dev database, so both code paths exist
  regardless, and every `SLUG`-keyed assertion (the badge `href`, the catalog
  exclusion check, the detail-page URLs) becomes dependent on whatever the seed
  happens to ship.
- **(b) Borrow the slot** — before activating, deactivate whatever free pack is
  currently live; restore it in the existing `finally`, after the QA pack is
  drafted. **This is the design to implement.** It keeps every existing
  assertion byte-identical, works the same on a seeded CI database and a bare
  dev database with one code path, and is the smallest diff.

The one accepted cost of (b): a hard kill (SIGKILL, runner cancellation) between
deactivate and restore leaves the seeded pack in `draft`. In CI the database is
an ephemeral service container, so it cannot outlive the run. Locally the fix is
re-running `seed:e2e`. Record this in a comment — do not build a
crash-recovery mechanism for it.

## Steps

### Step 1: Discover and release the incumbent free pack before activating

In `scripts/qa-free-pack.mjs`, immediately **before** the `let activated = false;`
line (currently ~:127), add a lookup that finds the live free pack, and inside
the `try` block, **before** the activation `fetch`, deactivate it.

Target shape — read `GET /admin/packs`, filter for the reserved category, and
ignore the script's own slug (so a leftover `qa-free-welcome` from a crashed
previous run is handled by the existing teardown, not double-handled here):

```js
// The admin API allows exactly ONE active `free_welcome` pack
// (assertSingleActiveFreePack, api/admin/packs/validate.ts). The E2E seed ships
// one — slug `free-welcome`, seeded ACTIVE and deliberately skipped by the
// seed's stray sweep — so on any correctly seeded database the slot is already
// taken and activating this script's own pack 400s. That is not a hypothetical:
// it is why this gate failed on every nightly from 2026-08-15 to 2026-08-17
// without ever once running an assertion.
//
// So borrow the slot rather than compete for it: draft the incumbent here,
// restore it in the `finally` AFTER this script's pack is drafted (the slot
// must be free at the moment of restore, or the restore itself 400s).
//
// Not DELETE and not a seed change: the incumbent is a real fixture other specs
// need, and its own pulls reference it.
const allPacks = await fetch(`${API}/admin/packs`, { headers: AH }).then(json);
const incumbent =
  (allPacks.packs ?? []).find(
    (p) =>
      p.category === 'free_welcome' && p.status === 'active' && p.slug !== SLUG,
  ) ?? null;
```

Then, as the first statement inside the `try`, before the activation:

```js
// Draft the incumbent so the single-active slot is free. `borrowed` gates the
// restore in `finally` the same way `activated` gates this script's own
// teardown — a mutation that did not happen must not be reversed.
if (incumbent) {
  const release = await fetch(`${API}/admin/packs/${incumbent.slug}`, {
    method: 'POST',
    headers: AH,
    body: JSON.stringify({ ...incumbent, status: 'draft' }),
  });
  if (!release.ok) {
    throw new Error(
      `could not release the live free pack '${incumbent.slug}' — ${release.status}`,
    );
  }
  borrowed = true;
  ok(`borrowed the free_welcome slot from '${incumbent.slug}'`);
}
```

Declare `let borrowed = false;` next to `let activated = false;`.

> **Note on the update payload**: the admin update route re-validates the whole
> pack body (`coercePackBody`). Spreading the incumbent row as returned by
> `GET /admin/packs` is what keeps the round-trip lossless. If the round-trip
> is rejected for a field the list endpoint does not return, that is a
> STOP condition — see below — do **not** hand-assemble a partial body and hope.

**Verify**: `node --check scripts/qa-free-pack.mjs` → exit 0, no output.

### Step 2: Restore the incumbent in the existing `finally`

Extend the existing `finally` block. Order matters and is the whole point:
this script's pack must be drafted **first**, then the incumbent restored —
restoring while `qa-free-welcome` is still active would hit the exact same
400 this plan exists to remove.

```js
} finally {
  if (browser) await browser.close();
  // ... existing `if (activated) { ... draft qa-free-welcome ... }` block,
  //     unchanged, stays HERE ...

  // Give the slot back, AFTER the block above freed it. A restore attempted
  // while this script's pack is still active would 400 for the same reason the
  // activation did. A hard kill (SIGKILL / runner cancellation) between the
  // borrow and here leaves the incumbent drafted: in CI the database is an
  // ephemeral service container so it cannot outlive the run, and locally the
  // fix is re-running `seed:e2e`. Not worth a crash-recovery mechanism.
  if (borrowed) {
    const restore = await fetch(`${API}/admin/packs/${incumbent.slug}`, {
      method: 'POST',
      headers: AH,
      body: JSON.stringify({ ...incumbent, status: 'active' }),
    });
    if (restore.ok) ok(`restored '${incumbent.slug}' to active`);
    else
      fail(
        `teardown: '${incumbent.slug}' left in draft — ${restore.status}; re-run seed:e2e`,
      );
  }
}
```

**Verify**: `node --check scripts/qa-free-pack.mjs` → exit 0.

### Step 3: Record the invariant in the script's header comment

The header block at the top of `scripts/qa-free-pack.mjs` currently says setup
"is idempotent: it (re)creates an ACTIVE free_welcome pack over existing cards
through the admin API, so a fresh DB needs no hand-seeding." That is now only
half the story. Extend it to state that the script borrows and returns the
single active `free_welcome` slot, and that a killed run leaves the incumbent
drafted (re-run `seed:e2e`).

**Verify**: `grep -n "borrow" scripts/qa-free-pack.mjs` → at least 2 matches
(header comment + the borrow site).

### Step 4: Full static gate

**Verify** (all four, each must pass):

```
npm run lint
npm run format:check
npm run typecheck
npm test
```

→ lint exit 0; format check exit 0; typecheck exit 0; tests all passing
(622 or more, 0 failing).

If `npm run format:check` fails **only** on `scripts/qa-free-pack.mjs`, run
`npx prettier --write scripts/qa-free-pack.mjs` and re-run the check. Do not run
the repo-wide `npm run format` — it can churn unrelated files.

## Test plan

There is no unit test for a Playwright QA script, and adding a test harness for
one is out of proportion. The verification is:

1. `node --check scripts/qa-free-pack.mjs` — syntax.
2. The four static gates in Step 4.
3. **The real proof is the next nightly.** Record in your report that the plan's
   success criterion is the `Run free-pack QA gate` step reaching the browser
   assertions instead of dying at activation, and that this is observable at
   `gh run list --workflow=e2e.yml --limit 1` plus
   `gh run view <id> --json jobs`.

If you _can_ bring the local stack up (see "Commands you will need"), a local
run against a database that has an active `free-welcome` pack is the direct
proof: the script must print `borrowed the free_welcome slot from 'free-welcome'`
and, at the end, `restored 'free-welcome' to active`. Report whether you ran it.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `node --check scripts/qa-free-pack.mjs` exits 0
- [ ] `npm run lint` exits 0
- [ ] `npm run format:check` exits 0
- [ ] `npm run typecheck` exits 0
- [ ] `npm test` exits 0
- [ ] `grep -c "borrowed" scripts/qa-free-pack.mjs` ≥ 3 (declaration, set, restore gate)
- [ ] `grep -n "status: 'draft'" scripts/qa-free-pack.mjs` shows the incumbent
      release **and** the existing `qa-free-welcome` teardown — both present
- [ ] The existing `if (activated)` teardown block is still present and still
      runs **before** the restore (read the `finally` block and confirm order)
- [ ] `git status --short` lists only `scripts/qa-free-pack.mjs` and
      `plans/README.md`
- [ ] `plans/README.md` status row for 107 updated

## STOP conditions

Stop and report back (do not improvise) if:

- The drift check shows `scripts/qa-free-pack.mjs`, `seed-e2e-fixtures.ts` or
  the admin packs routes changed since `16cc85d3` and the excerpts above no
  longer match.
- `GET /admin/packs` does not return `slug`, `category` and `status` on each
  pack, or the round-trip `POST /admin/packs/:slug` with the spread list row is
  rejected for a missing/invalid field. Report which field — the fix is to read
  the single pack via `GET /admin/packs/:slug` instead, but **do not** make that
  substitution unilaterally.
- You find yourself wanting to change the seed, the workflow, or the
  one-active-free-pack validation. All three are out of scope by design; if the
  fix genuinely requires one of them, the plan's premise is wrong — say so.
- You discover the assumption **"the E2E seed's free pack is the only thing
  holding the slot in CI"** is false — e.g. `deploy:init` or the base `seed.ts`
  also creates an active `free_welcome` pack. The fix still works (the lookup
  finds whichever one is live), but say so, because it changes what the seed
  fixtures mean.

## Maintenance notes

- **The invariant to protect**: exactly one active `free_welcome` pack. Anything
  that creates or activates a free pack — a new seed, a new fixture, a second QA
  script — is now competing for the same slot. The borrow/restore pattern here
  is the template; a second borrower running concurrently with this one would
  interleave badly, so keep free-pack QA to a single serialized gate.
- **A reviewer should scrutinize**: the order inside `finally` (draft-ours then
  restore-theirs), and that `borrowed` can never be true when `incumbent` is
  null.
- **Recorded for a future round — DO NOT attempt in this plan**: the script
  still mints its own pack over the first two cards in the catalog. Running the
  assertions against the _seeded_ free pack instead — proving the loop on the
  pack customers actually get — is a better test, and it is approach (a) from
  the "Approach" section above, which this plan explicitly rejects for the work
  at hand. It is noted here only so the idea is not lost; implementing it here
  puts the change out of scope and fails the plan.
