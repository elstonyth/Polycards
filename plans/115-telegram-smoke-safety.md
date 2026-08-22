# Plan 115: Stop the Telegram smoke script from publicly attributing a fabricated pull to a real customer

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 30eded61..HEAD -- backend/packages/api/src/scripts/telegram-apex-smoke.ts`
> If the file changed since this plan was written, compare the "Current
> state" excerpts against the live code before proceeding; on a mismatch,
> treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (independent of plan 114; both touch the Telegram
  domain but different files — execute in either order)
- **Category**: security
- **Planned at**: commit `30eded61`, 2026-08-22

## Why this matters

`telegram-apex-smoke.ts` is the operator pre-flight for the public apex
board. Today it picks **an arbitrary real customer**
(`listCustomers({}, { take: 1 })`), fabricates a Pull row for them, and
posts "Congratulations <their real display name>!" with a card they never
pulled to the live customer-facing channel. Telegram pushes that to every
subscriber's notifications _before_ the script's delete lands, and pushed
notifications survive the deletion. A named real person is publicly
attributed a fabricated gambling win every time an operator runs a smoke
test. The header's claim "Safe to run against the live customer-facing
channel" reasons only about post lifetime, not identity.

Secondary defect: if `deleteApexPost` **throws** (its `fetch`/`res.json()`
can — network error, timeout, non-JSON body), the throw skips the loud
`COULD NOT DELETE message <id>` branch and the script's output never
contains the message id at all — a stranded fake post with nothing to
hand-delete by. (This is the known "smoke delete can strand a fake post"
hazard; this is its mechanism.)

Live incident color: on 2026-08-22 the operator saw a real apex post in
the channel and could not tell whether it was a smoke post or a real pull
— they had to be walked through feed forensics. Smoke posts being
indistinguishable _and_ attributed to real customers is exactly what this
plan removes.

## Current state

File: `backend/packages/api/src/scripts/telegram-apex-smoke.ts` (135
lines). Run via `medusa exec ./src/scripts/telegram-apex-smoke.ts` from
`backend/packages/api` — operator-run only, never wired to CI.

Excerpts as of `30eded61`:

Lines 15–18 (the header claim):

```ts
// Picks a REAL apex (pack, card) pair and a REAL customer from the catalog,
// inserts a temporary Pull row, posts it, then deletes BOTH the post and the
// row. Safe to run against the live customer-facing channel: subscribers see
// the post for a second or two at most. TELEGRAM_SMOKE_KEEP=1 leaves it up.
```

Lines 64–69 (the arbitrary-customer pick):

```ts
const customers = container.resolve(Modules.CUSTOMER);
const [customer] = await customers.listCustomers({}, { take: 1 });
if (!customer) {
  logger.error('No customer in this database — cannot test.');
  return;
}
```

Lines 109–131 (the delete; note a THROW from `deleteApexPost` skips the
`removed.ok` branching entirely, and the id was never logged before this
point — line 103 logs the caption only, line 85 logs ids for card/pack/
customer but the Telegram message id exists only after posting):

```ts
    if (posted.messageId === null) return;
    if (process.env.TELEGRAM_SMOKE_KEEP === '1') { … }
    const removed = await deleteApexPost(
      process.env.TELEGRAM_BOT_TOKEN!,
      process.env.TELEGRAM_CHAT_ID!,
      posted.messageId,
    );
    if (removed.ok) { … }
    else {
      logger.error(
        `[telegram-smoke] COULD NOT DELETE message ${posted.messageId} (…) — remove it manually.`,
      );
    }
```

Lines 132–134 (the row cleanup — this part is correct, keep it):

```ts
  } finally {
    await packs.deletePulls([pull.id]);
  }
```

Relevant facts:

- `postApexPull` resolves the customer's public display name via
  `publicProfileFields` and refuses disabled players
  (`modules/packs/telegram.ts:353-390`). The smoke must keep exercising
  that resolution path (it is part of what the pre-flight proves), so the
  fix is to control _which_ customer, not to bypass the lookup.
- The repo's convention for prod-reachable scripts is an explicit guard:
  `seed-held-withdrawal.ts:17` (NODE_ENV guard),
  `seed-e2e-fixtures.ts:86-108` (localhost-DB + NODE_ENV guard). This
  script is _intended_ to run against prod, so its guard must be an
  explicit operator opt-in, not an environment sniff.
- `deleteApexPost(token, chatId, messageId)` is exported from
  `modules/packs/telegram.ts:171-180` and can throw (its `callTelegram`
  does `fetch` + `res.json()` with no catch).

## Commands you will need

Run from `backend/`.

| Purpose            | Command                                                                                                                                                                                     | Expected on success |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| Typecheck          | `corepack yarn check-types`                                                                                                                                                                 | exit 0              |
| Telegram unit tier | `node node_modules/jest/bin/jest.js --config packages/api/jest.config.js --testPathPatterns telegram` (jest path may resolve under `packages/api/node_modules` in a fresh worktree — check) | all pass            |

**Never execute the smoke script itself during this plan** — with prod env
it posts to the live channel; with local env it needs a configured bot.
The changes are verifiable by typecheck + reading.

## Scope

**In scope** (the only files you should modify):

- `backend/packages/api/src/scripts/telegram-apex-smoke.ts`

**Out of scope** (do NOT touch):

- `backend/packages/api/src/modules/packs/telegram.ts` — plan 114 owns it;
  `deleteApexPost`'s throwing behavior is handled HERE by catching at the
  call site, not by changing the shared function.
- `subscribers/pack-opened-telegram.ts`, `.do/backend.app.yaml`.

## Git workflow

- Branch: `advisor/115-telegram-smoke-safety`
- Conventional commit, e.g. `fix(backend): smoke-test the apex board without impersonating a real customer`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Require an explicitly named smoke customer

Replace the arbitrary pick (lines 64–69) with an env-gated choice:

```ts
// NEVER an arbitrary customer: the post publicly attributes a fabricated
// pull to a real display name, and Telegram's push notifications outlive
// the delete below. The operator must consciously name a test account.
const smokeCustomerId = process.env.TELEGRAM_SMOKE_CUSTOMER_ID?.trim();
if (!smokeCustomerId) {
  logger.error(
    'TELEGRAM_SMOKE_CUSTOMER_ID unset — refusing to post as an arbitrary real customer. ' +
      "Set it to a test account's customer id (cus_…) and re-run.",
  );
  return;
}
const customers = container.resolve(Modules.CUSTOMER);
const customer = await customers
  .retrieveCustomer(smokeCustomerId)
  .catch(() => null);
if (!customer) {
  logger.error(
    `TELEGRAM_SMOKE_CUSTOMER_ID=${smokeCustomerId} does not resolve to a customer — nothing posted.`,
  );
  return;
}
```

Keep the variable name `customer` so the rest of the script compiles
unchanged.

**Verify**: `corepack yarn check-types` → exit 0.

### Step 2: Log the message id the moment it exists, and catch the delete's throw

Immediately after the `posted` null-check (after line ~98), add:

```ts
if (posted.messageId !== null) {
  // Logged BEFORE any delete attempt: if the delete throws (network,
  // timeout, non-JSON body), this line is the only place the id exists
  // for a human to remove the post by hand.
  logger.info(`[telegram-smoke] posted as message ${posted.messageId}`);
}
```

Then wrap the delete call so a throw lands in the same loud path as an
`ok: false`:

```ts
const removed = await deleteApexPost(
  process.env.TELEGRAM_BOT_TOKEN!,
  process.env.TELEGRAM_CHAT_ID!,
  posted.messageId,
).catch((err) => ({
  ok: false as const,
  description: err instanceof Error ? err.message : String(err),
}));
```

The existing `removed.ok` / else branches then handle both shapes with no
further edits.

**Verify**: `corepack yarn check-types` → exit 0.

### Step 3: Correct the header's safety claim

Rewrite header lines 15–18 to state what is and is not safe:

```ts
// Uses a REAL apex (pack, card) pair from the catalog and the TEST customer
// named by TELEGRAM_SMOKE_CUSTOMER_ID (required — refuses to run without it,
// because the post publicly names its customer and Telegram push
// notifications outlive the delete). Inserts a temporary Pull row, posts,
// then deletes BOTH the post and the row. Subscribers may still see the
// post and its notification briefly. TELEGRAM_SMOKE_KEEP=1 leaves it up.
```

**Verify**: `grep -n "Safe to run against the live" backend/packages/api/src/scripts/telegram-apex-smoke.ts` → no match.

## Test plan

The script is an operator exec with no existing spec, and its collaborators
(`postApexPull`, `deleteApexPost`) are pinned by
`__tests__/telegram.unit.spec.ts`. Adding a jest harness for a
`medusa exec` script is not worth the fixture cost (repo precedent: none of
`src/scripts/*` have specs). Verification is typecheck plus the three greps
in Done criteria. The behavioral proof is the operator's next smoke run,
which now refuses without `TELEGRAM_SMOKE_CUSTOMER_ID` — note that in your
report as the expected first-run outcome.

## Done criteria

- [ ] `corepack yarn check-types` (backend) exits 0
- [ ] `grep -c "listCustomers({}" backend/packages/api/src/scripts/telegram-apex-smoke.ts` → 0
- [ ] `grep -c "TELEGRAM_SMOKE_CUSTOMER_ID" backend/packages/api/src/scripts/telegram-apex-smoke.ts` → ≥3 (read, error message, header)
- [ ] `grep -n "posted as message" backend/packages/api/src/scripts/telegram-apex-smoke.ts` → 1 match, positioned before the delete call
- [ ] jest `--testPathPatterns telegram` → all pass (no regression in the shared module's suite)
- [ ] Only `telegram-apex-smoke.ts` modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpts don't match the live code (drift — plan 114 may have merged
  first; that touches a different file, so real drift here means something
  else changed the script).
- `retrieveCustomer` doesn't exist on the resolved customer module service
  (check `Modules.CUSTOMER`'s service surface; `listCustomers({ id: … })`
  is the fallback shape — use it and say so).
- You are tempted to create a synthetic customer inside the script instead
  — that adds a write path + cleanup surface this plan deliberately avoids
  (an operator-named durable test account is simpler and auditable).

## Maintenance notes

- Operators: create one durable test customer (e.g. a `smoke@polycards.gg`
  account with a display name that is obviously non-real, like
  "Board Test"), and record its id wherever the runbook for the board
  lives. The smoke's caption will then be self-identifying in-channel —
  which also fixes "is this post real or a test?" at a glance.
- If plan 114's Step 6 (429 retry) lands, a smoke run during a rate-limit
  window may take up to ~5s longer — harmless, but don't mistake it for a
  hang.
- Reviewer: confirm Step 2's catch produces `{ ok: false, description }`
  and not a rethrow — the finally-block row cleanup must still run.
