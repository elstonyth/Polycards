# Plan 128: Docs truth round 8 — stop teaching vocabulary, a nav contract and a runbook that no longer match the code

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If a
> STOP condition occurs, stop and report — do not improvise. Do NOT update
> `plans/README.md`; the reviewer maintains it.
>
> **Drift check (run first)**:
> `git diff --stat affaab51..HEAD -- CONTEXT.md DESIGN.md docs/ src/app/privacy/page.tsx src/components/app-shell/tabs.ts backend/packages/api/src/api/middlewares.ts backend/packages/api/src/modules/packs/tasks.ts`
> On any change, re-read the file and compare against the "Current state"
> excerpts below. On a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW — documentation, comments, one customer-facing copy block, and one small `tabs.ts` change
- **Depends on**: none
- **Category**: docs
- **Planned at**: commit `affaab51`, 2026-08-26

## Why this matters

Wrong documentation is worse than missing documentation, because it is trusted.
Seven prior "docs truth" rounds exist in this repo for that reason. PR #490 (the
weekly commission engine and `/task` hub), PR #493 (`/privacy`) and the Medusa
2.19 upgrade each left a document asserting something the code no longer does:

- `CONTEXT.md` is the repo's shared domain vocabulary, and ADR 0007 explicitly
  designates its §Rewards and VIP section as the canonical vocabulary for the
  new money engine. That section defines a **VIP Rebate** with ledger reason
  `vip_rebate` — a feature that was cut before #490 shipped. `grep -rn 'rebate'
over the backend source returns **zero hits**. It also says settlement lines
are "per customer × kind"; there is no `kind` column and the unique index is
  one line per customer.
- The same section says weekly tasks reset with the **Referral Week** (Tuesday).
  The code deliberately resets them **Monday**, and that two-anchor split is the
  single most confusable thing in #490 — which is why the design spec amendment
  calls it out explicitly.
- `DESIGN.md` calls itself the nav contract and labels the Task tab "weekly
  challenge". The Task tab is the tasks/achievements hub; the weekly challenge
  lives on `/leaderboard`. `/referral` — a top-level brand surface — appears
  nowhere in the contract, and no tab highlights while a user is on it.
- The go-live runbook's post-wipe checklist has no step for anything #490
  shipped. Following it end to end today ships an empty primary tab and a live
  commission rate the operator cannot see.
- `/privacy` went live this week and omits two real data flows: a mandatory
  phone number handed to an SMS processor, and the by-default publication of a
  customer's display name to a public Telegram channel.
- The design spec that is the intent document for the whole engine opens
  mid-sentence, with a duplicated fragment fused to its own title.
- `middlewares.ts` carries ~35 lines of load-bearing "here is why this looks
  weird, do not simplify it" rationale that Medusa 2.19 made false.

## Current state

### 1. `CONTEXT.md` — vocabulary that does not exist

```md
<!-- CONTEXT.md:214-217 -->

**VIP Rebate (回水)**:
A customer's own weekly pack turnover times their VIP level's `rebate_bp`
(admin-set on the Levels ladder; 0 by default). Same weekly cycle and ledger
treatment as commission, reason `vip_rebate`.
```

Verification that this is dead: `grep -rn 'rebate' backend/packages/api/src`
returns **0 matches**. `models/vip-level.ts` has no `rebate_bp` column, and the
`credit_transaction.reason` enum has `referral_commission` but no `vip_rebate`.

```md
<!-- CONTEXT.md:219-226 -->

**Task / Achievement**:
An admin-defined goal on the /task hub (Phase B of the same spec). Weekly
tasks (check-in days, rip counts — optionally per pack) reset with the
Referral Week; achievements (reach VIP level, vault N cards, vault N pixel
Pokémon) are once per account.
```

```md
<!-- CONTEXT.md:233-237 -->

**Weekly Settlement**:
One `weekly_settlement` run per closed week: draft (Tuesday close) → approved
(human gate on the admin Referrals page) → paid (Wednesday cron or "Pay now").
Lines (`weekly_settlement_line`) are per customer × kind, voidable until paid;
the pay step is idempotent per line via the ledger `(type='RF', ref_id)` index.
```

The code's own comments state the correct rule:

```ts
// backend/packages/api/src/modules/packs/referral.ts:56-57 (and 84-85)
// the `/task` weekly board resets on Monday so the player's week matches the
// calendar week they think in
```

```ts
// backend/packages/api/src/modules/packs/models/task-definition.ts:2-4
// Mon 00:00 MYT — the player-facing week, deliberately NOT the Tuesday
// settlement week
```

`taskWeekFor` (Monday) is what `taskHubFor` and `claimTask` call. `weekly_settlement_line`
has no `kind` column; its unique index is `IDX_wsl_settlement_customer_unique`
on `(settlement_id, customer_id)`.

A stale comment agrees with the wrong doc and must move with it:

```ts
// backend/packages/api/src/modules/packs/models/task-claim.ts:4-6
// `period_key` is the referral week's Tuesday ISO for weekly tasks
```

```ts
// backend/packages/api/src/modules/packs/tasks.ts:132-134
// (documents weekly task facts as scoped to "the referral week")
```

### 2. ADR drift

```md
<!-- docs/adr/0007-referral-programme-removed.md:89-95 -->

The replacement shipped 2026-08-25 on `feat/referral-rebuild` (design spec:
`docs/superpowers/specs/2026-08-24-referral-tasks-rebuild-design.md`). It is a
weekly batch engine — turnover-tiered commissions plus a VIP personal rebate,
computed Tuesday into an admin-approved settlement run and paid Wednesday —
```

"plus a VIP personal rebate" is wrong; the spec's 2026-08-25 amendment records
that the rebate, the `vip_rebate` credit reason and the `weekly_settlement_line.kind`
column were all dropped before implementation.

```md
<!-- docs/adr/0004-reward-economy-suspension.md:51 -->

(cites "CONTEXT.md's 'Rewards, VIP, and referrals' glossary section")
```

That heading is now `## Rewards and VIP` (`CONTEXT.md:179`).

ADR 0004 lists kept SUSPENDED holders at `:33` and `:77`, including
`components/rewards/PrizeReveal.tsx`. That file no longer exists —
`git log --diff-filter=D -- src/components/rewards/PrizeReveal.tsx` shows it was
deleted by `1ad7bdd5` (#490). `:34` lists `src/components/account/ui.tsx` as
carrying an inline suspension note; `grep -i suspend` on that file returns
nothing.

The live holder set is:

```
src/app/(account)/vip/vip-benefits.ts
src/components/account/credit-dot.tsx
src/components/app-shell/TopUpProvider.tsx
src/components/app-shell/__tests__/topup-deposit-watch.test.ts
src/components/rewards/WithdrawForm.tsx
src/lib/actions/daily.ts
```

(reproduce with `grep -rl SUSPENDED src/`)

### 3. The design spec's corrupted head

```md
<!-- docs/superpowers/specs/2026-08-24-referral-tasks-rebuild-design.md:1-9 -->

claim is an explicit store endpoint,
idempotent via the task_claim unique index, and grants through existing
mechanics: credit via mutateCreditAtomic (idempotency reference per
task+period), card via a source='reward' pull (vault entry, stock counter
decremented, never gated). **Pack reward (decided at implementation): a free
rip** — the claim rolls the pack's live odds server-side (rollOne, the same
draw a paid open uses, customer's own odds set) and vaults the result as a
source='reward' pull. No charge-seam change; reward pulls never move the
boards.# Referral Rebuild + Task Page — Design
```

A duplicated fragment was pasted above the H1 and fused to it. The same text
appears correctly inside the Phase-B section further down.

### 4. `DESIGN.md`'s nav contract

```md
<!-- DESIGN.md:213-215 -->

5 slots with the shipped labels Task · Ranks · Home · Vault · Me
(Task = weekly challenge, Ranks = leaderboard)
... the nav contract — `src/components/app-shell/tabs.ts` implements it
```

`src/app/task/page.tsx` is the tasks/achievements hub. `tabs.ts:22` maps Task →
`/task` with a `ListChecks` icon. The weekly challenge lives on `/leaderboard`.
`/referral` is absent from the contract and from the Me tab's `match` array
(`tabs.ts:31-38`), so no tab highlights on it.

```ts
// backend/packages/api/src/scripts/seed-challenge.ts:4
// (carries the same stale "the storefront /task page" belief)
```

### 5. The go-live runbook

```md
<!-- docs/ops/production-reset-and-golive-runbook.md:112-125 -->

(an 11-step table presented as the full wipe → launch sequence,
ending at "11 | Configure real challenge stages")
```

Step 2 is a `DROP SCHEMA public CASCADE`. There is no seeder for
`task_definition` or `referral_settings` in
`backend/packages/api/src/scripts/` (only `qa-task-labels.ts`, a QA helper), so
after the documented wipe `/task` renders an empty board and `referral_settings`
has no row — commissions fall back to the hardcoded `DEFAULT_TIERS` in
`referral.ts:13-18` with nothing on the admin settings screen showing the
operator what rate is live.

### 6. `/privacy`

```tsx
// src/app/privacy/page.tsx:15-19
const SECTIONS: { title: string; body: string }[] = [
  {
    title: 'What we collect',
    body: 'Your account details (email, display handle), your pack, vault, and transaction history, and the technical basics every web service receives — IP address and browser information. If you sign in with Google, we receive your name and email from Google.',
  },
```

No mention of the phone number, which is required at registration since
2026-08-01 (`workflows/steps/request-delivery.ts:157-158`) and verified through
an SMS processor (`TWILIO_VERIFY_*` keys in `.do/backend.app.yaml`).

No mention of the public Telegram broadcast. On any above-threshold pull,
`modules/packs/telegram.ts:591-610` posts the customer's display name plus a
link to `/profile/<handle>` to a public channel. The only gate is
`disabledCustomerIds` (`:579`) — an **administrative** disable, not a customer
opt-out.

The page's own header comment already says: "Operator should review wording
before any formal legal reliance; keep this page in sync when data practices
change."

The Cookies section's referral-invite claim is **correct** — `src/lib/referral-cookie.ts`
was rebuilt in #490. Do not "fix" it.

### 7. `middlewares.ts`'s obsolete rationale

```ts
// backend/packages/api/src/api/middlewares.ts:214-227 (paraphrased)
// states that Medusa's RoutesSorter silently DROPS a zero-segment '/' matcher,
// and that '/*' is the smallest surviving matcher
```

Medusa 2.19 fixed this. From the installed framework:

```js
// backend/packages/api/node_modules/@medusajs/framework/dist/http/routes-sorter.js:94-102
const segments = route.matcher.split('/').filter((s) => s.length);
/**
 * A matcher without any segments (e.g. "/") targets the root. Placing it
 * directly on the root branch ensures it is not dropped from the tree.
 */
if (!segments.length) {
  const bucket = !route.methods && !route.method ? 'global' : 'static';
  parent[bucket].routes.push(route);
  return;
}
```

`middlewares.ts:315` also claims the matcher shape was "verified empirically
against the INSTALLED packages (express 4.22.2 + path-to-regexp 0.1.13)". Express
is still 4.22.2, but 2.19 additionally compiles matchers through
`path-to-regexp@8.4.2` in `dist/http/routes-finder.js:56` (with a `/*` →
`{*splat}` shim at `:50`). The comment describes a one-engine world that is now
two.

**The `'/*'` matcher itself is still correct and must not change.** Only the
explanation is wrong.

### Conventions to match

- Markdown in this repo is **hand-wrapped** at roughly 78–80 columns. Match the
  surrounding wrapping; do not reflow paragraphs you are not editing, and do not
  run a formatter over any `.md` file.
- ADRs are append-mostly: correct a factual error in place, but record a
  substantive change as a dated amendment rather than silently rewriting a
  decision. Follow the amendment style already present in ADR 0004.
- `CONTEXT.md` glossary entries are `**Term**:` followed by an indented prose
  block. Match it.
- Code comments: match the surrounding density and voice. These files favour
  comments that say _why_, with a dated review reference where one exists.

## Commands you will need

Run from the repo root unless stated.

| Purpose                | Command                                                  | Expected on success        |
| ---------------------- | -------------------------------------------------------- | -------------------------- |
| Typecheck              | `npm run typecheck`                                      | exit 0                     |
| Lint                   | `npm run lint`                                           | exit 0                     |
| Unit tests             | `npm test`                                               | all pass                   |
| Build                  | `npm run build`                                          | exit 0                     |
| Backend typecheck      | `corepack yarn check-types` (from `backend/`)            | exit 0                     |
| Backend unit tests     | `corepack yarn test:unit` (from `backend/packages/api/`) | all pass                   |
| Live SUSPENDED holders | `grep -rl SUSPENDED src/`                                | the six paths listed above |

Never pipe a test command through `tail`. Do not run `next dev`.

## Scope

**In scope** (the only files you may modify):

- `CONTEXT.md`
- `DESIGN.md`
- `docs/adr/0004-reward-economy-suspension.md`
- `docs/adr/0007-referral-programme-removed.md`
- `docs/superpowers/specs/2026-08-24-referral-tasks-rebuild-design.md`
- `docs/ops/production-reset-and-golive-runbook.md`
- `src/app/privacy/page.tsx`
- `src/components/app-shell/tabs.ts`
- `backend/packages/api/src/api/middlewares.ts` (**comments only**)
- `backend/packages/api/src/modules/packs/models/task-claim.ts` (**comments only**)
- `backend/packages/api/src/modules/packs/tasks.ts` (**comments only**)
- `backend/packages/api/src/scripts/seed-challenge.ts` (**comments only**)

**Out of scope** (do NOT touch, even though they look related):

- `CLAUDE.md`, `AGENTS.md`, `PRODUCT.md`, `.clinerules`, `GEMINI.md`,
  `.windsurfrules`, and anything under `.claude/`. **These are gitignored** —
  `.gitignore:105-119`. They do not exist in your worktree and anything you
  write there would never be committed. Their corrections are handled
  separately by the operator. If you find yourself wanting to edit one, that is
  the signal to stop and report, not to create it.
- `backend/packages/api/src/modules/packs/service.ts` — another executor is
  editing it concurrently. Its two stale "referral week" comments (around
  `:1751-1753`) are deliberately deferred; do not touch the file.
- The `'/*'` matcher in `middlewares.ts` and every other line of executable code
  in that file. Comments only — `git diff -w` on it must show only comment
  lines.
- Any behavioural change anywhere. This plan changes documentation, comments,
  one copy block and one `match` array. If a fix seems to require changing
  logic, stop and report.
- The Cookies section's referral-invite sentence in `privacy/page.tsx` — it is
  correct.
- Writing a `seed-tasks.ts` or `seed-referral-settings.ts` script. The runbook
  gets **steps**, not a new seeder; the seeder is a separate decision.

## Git workflow

- Branch: `advisor/128-docs-truth-round8`, cut from `origin/master`.
- Conventional commits, e.g.
  `docs(context): retire the VIP rebate vocabulary and name the Task Week`
- Group commits by document so the reviewer can read them independently.
- Do NOT push or open a PR — the reviewer does that.

## Steps

### Step 1: Repair the design spec's head

Delete lines 1–8 of
`docs/superpowers/specs/2026-08-24-referral-tasks-rebuild-design.md` and restore
line 9 to a bare `# Referral Rebuild + Task Page — Design`.

Before deleting, confirm the fragment is genuinely duplicated: search the file
for `claim is an explicit store endpoint` and verify it appears a second time in
the Phase-B section with the same following text. If it appears only once, the
head is not a duplicate — **STOP and report**, because you would be deleting
content.

**Verify**:

- `head -1 docs/superpowers/specs/2026-08-24-referral-tasks-rebuild-design.md` → `# Referral Rebuild + Task Page — Design`
- `grep -c 'claim is an explicit store endpoint' docs/superpowers/specs/2026-08-24-referral-tasks-rebuild-design.md` → `1`

### Step 2: Correct the `CONTEXT.md` vocabulary

Three edits:

1. **VIP Rebate** (`:214-217`): do not simply delete it. Rewrite it as a
   _retired-term_ note — the rebate was designed, then cut at implementation
   (spec amendment 2026-08-25) — so a future reader does not re-derive it from
   ADR 0007's prose. One or two sentences, clearly marked as not shipped.
2. **Weekly Settlement** (`:235`): "per customer × kind" → per customer, one
   line each. Name the unique index (`(settlement_id, customer_id)`) so the
   claim is checkable.
3. **Task / Achievement** (`:219-222`): weekly tasks reset with the **Task
   Week**, not the Referral Week. Add a new **Task Week** glossary entry beside
   the existing Referral Week entry (around `:191-194`): Monday 00:00 MYT, the
   player-facing week, deliberately not the Tuesday settlement week. State the
   split explicitly — that is the whole point of the entry.

**Verify**:

- `grep -c 'vip_rebate' CONTEXT.md` → the term appears only inside the
  retired-term note; read the diff and confirm it is not presented as live
- `grep -n 'Task Week' CONTEXT.md` → at least 1 match
- `grep -c '× kind' CONTEXT.md` → `0`

### Step 3: Move the stale code comments with it

Comment-only edits, no logic:

- `models/task-claim.ts:4-6` — `period_key` for a weekly task is the **task
  week's Monday** ISO, not the referral week's Tuesday.
- `tasks.ts:132-134` — weekly task facts are scoped to the task week (Monday).
- `seed-challenge.ts:4` — the weekly challenge is on `/leaderboard`, not
  `/task`.

**Verify**:

- `corepack yarn check-types` from `backend/` → exit 0
- `git diff -w -- backend/packages/api/src/modules/packs/models/task-claim.ts backend/packages/api/src/modules/packs/tasks.ts backend/packages/api/src/scripts/seed-challenge.ts` shows only comment lines changed

### Step 4: Amend the two ADRs

**ADR 0007**: correct the Successor paragraph — the replacement is
turnover-tiered commissions, **without** the VIP personal rebate, which was cut
at implementation. Point at the spec's 2026-08-25 amendment block. Add it as a
dated amendment line rather than silently editing the decision prose.

**ADR 0004**: three corrections.

1. `:51` — the cited `CONTEXT.md` heading is now `## Rewards and VIP`.
2. Record, as a dated amendment, that `components/rewards/PrizeReveal.tsx` was
   **deleted by #490 (`1ad7bdd5`)** while listed as a kept holder — so the
   revert this ADR promises is already partially impossible, and the next reader
   knows it.
3. Regenerate the kept-holder list at `:33`/`:77` from
   `grep -rl SUSPENDED src/` (the six paths in "Current state"). Remove
   `src/components/account/ui.tsx`, which carries no suspension note.

**Verify**:

- `grep -c 'PrizeReveal' docs/adr/0004-reward-economy-suspension.md` → matches
  appear only in the amendment recording its deletion, not in the live holder
  list. Read the diff and confirm.
- Every path in the regenerated list exists: run
  `for f in $(grep -rl SUSPENDED src/); do test -e "$f" || echo "MISSING $f"; done`
  → no output.

### Step 5: Fix the nav contract

**`DESIGN.md:213`**: correct the parenthetical — Task is the tasks/achievements
hub; the weekly challenge is on `/leaderboard` under Ranks. Add `/referral` to
the contract as a Me-tab surface.

**`src/components/app-shell/tabs.ts:31-38`**: add `/referral` (and `/addresses`,
which has the same gap) to the Me tab's `match` array so a tab highlights on
those routes. Read the array's existing shape first and match it exactly —
prefix semantics matter here, and a too-broad prefix would steal highlighting
from another tab.

**Verify**:

- `npm run typecheck` → exit 0
- `npm test` → all pass (a `tabs.ts` change can break a nav test; if one fails,
  read whether the test encodes the old contract or a real constraint, and
  report which)
- `grep -c "'/referral'" src/components/app-shell/tabs.ts` → at least 1

### Step 6: Add the missing go-live steps

Append steps to the checklist in
`docs/ops/production-reset-and-golive-runbook.md:112-125` covering what #490
shipped:

1. Seed or verify `referral_settings` — the tier table and partner bounds — with
   a note that an absent row silently falls back to `DEFAULT_TIERS` in
   `modules/packs/referral.ts:13-18`, so "no row" is a **live rate the operator
   cannot see**, not an inert state. Match the §Note callout style the runbook
   already uses for steps 8 and 10.
2. Create the launch task set, with a note that `/task` is slot 1 of the primary
   tab bar and renders an empty board until definitions exist.

Add a post-launch proof query for each, in the style of the existing step-3
proof.

**Verify**: `grep -c 'referral_settings' docs/ops/production-reset-and-golive-runbook.md`
→ at least 1.

### Step 7: Bring `/privacy` up to what the product does

Edit the `SECTIONS` array in `src/app/privacy/page.tsx`:

1. **What we collect** — add the phone number, and say it is required to hold an
   account.
2. **Email** section (or a sibling) — name SMS verification alongside the email
   provider, and say a third-party processor handles it.
3. Add a new **Public activity** section: display name, handle and notable pulls
   appear on public surfaces, including a public Telegram channel.

Write it in the page's existing plain, second-person voice. `SECTIONS` is a
static array rendered as text (`page.tsx:75-79`) — no HTML, no sinks, no links.

Do **not** add a customer opt-out mechanism. That is a product decision touching
the Telegram gate and is out of scope; the copy states what is true today.

**Verify**:

- `npm run typecheck` → exit 0
- `npm run build` → exit 0
- `grep -ci 'phone' src/app/privacy/page.tsx` → at least 1
- `grep -ci 'telegram' src/app/privacy/page.tsx` → at least 1

### Step 8: Retire the obsolete matcher rationale

Rewrite `middlewares.ts:214-227` to say: the zero-segment `'/'` drop was a
pre-2.19 framework bug, fixed in `routes-sorter.js` (quote the installed
comment); `'/*'` plus the `req.path === '/'` check is **retained deliberately**
as the safer form and must not be simplified away. Update `:315` to name both
regex engines now in play — express 4.22.2's bundled path-to-regexp 0.1.13 for
route registration, and `path-to-regexp@8.4.2` in
`dist/http/routes-finder.js:56` for the framework's own matcher lookups.

Comments only. Change no matcher, no handler, no import.

**Verify**:

- `corepack yarn check-types` from `backend/` → exit 0
- `git diff -w -- backend/packages/api/src/api/middlewares.ts` shows only
  comment lines
- `grep -c "'/\*'" backend/packages/api/src/api/middlewares.ts` returns the same
  count as before your change (record it first)

### Step 9: Full green

**Verify**, in order:

1. `npm run typecheck` → exit 0
2. `npm run lint` → exit 0
3. `npm run format:check` → exit 0
4. `npm test` → all pass
5. `npm run build` → exit 0
6. `corepack yarn check-types` from `backend/` → exit 0
7. `corepack yarn test:unit` from `backend/packages/api/` → all pass
8. `git status --porcelain` → only the in-scope files
9. `git diff --stat -- '*.md'` → only the six markdown files in scope

## Test plan

No new tests. This plan changes documentation, comments, one static copy array
and one `match` array; per `.claude/rules/common/testing.md`, presentational and
copy changes are covered by the Playwright capture/compare loop, not by unit
assertions. Do not write brittle markup assertions for the privacy copy.

The existing suites are the regression gate: `npm test` must stay green through
the `tabs.ts` change, and the backend suites through the comment edits.

If `npm test` surfaces a nav test that encodes the _old_ Me-tab match array,
report it with the assertion text before changing it — a test that pins the bug
is a STOP condition, not a nuisance.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm test`, `npm run build` all exit 0
- [ ] `corepack yarn check-types` (from `backend/`) exits 0
- [ ] `corepack yarn test:unit` (from `backend/packages/api/`) exits 0
- [ ] `head -1` of the design spec is `# Referral Rebuild + Task Page — Design`, and `grep -c 'claim is an explicit store endpoint'` on it returns `1`
- [ ] `grep -c '× kind' CONTEXT.md` returns `0`
- [ ] `grep -n 'Task Week' CONTEXT.md` returns at least 1 match
- [ ] Every path in ADR 0004's regenerated holder list exists on disk (the `for` loop in Step 4 prints nothing)
- [ ] `grep -ci 'phone' src/app/privacy/page.tsx` and `grep -ci 'telegram' src/app/privacy/page.tsx` each return at least 1
- [ ] `git diff -w` on `middlewares.ts`, `task-claim.ts`, `tasks.ts` and `seed-challenge.ts` shows **only comment lines**
- [ ] `git status --porcelain` lists only files from the In-scope list, and **nothing** under `.claude/`, and not `CLAUDE.md`, `AGENTS.md` or `PRODUCT.md`

## STOP conditions

Stop and report back — do not improvise — if:

- Any "Current state" excerpt does not match the live code.
- The design spec's head fragment is **not** duplicated further down the file —
  you would be deleting unique content.
- `grep -rn 'rebate' backend/packages/api/src` returns a non-zero count. That
  would mean the rebate exists after all and the whole VIP Rebate edit is wrong.
- A test fails that encodes the old Me-tab match array or the old nav contract.
  Report the assertion; do not edit a test to make your change pass without
  saying so.
- You need to edit any gitignored file to complete a step.
- A comment-only edit forces a code change to keep the typecheck green (e.g. an
  eslint rule about comment placement). Report it rather than changing logic.

## Maintenance notes

- **For the reviewer**: the checks that matter are (a) `git diff -w` on the four
  comment-only files — anything but comment lines means scope creep into
  behaviour; (b) that the VIP Rebate entry reads clearly as _retired_, not
  merely deleted, or the next reader re-derives it from ADR 0007; (c) that the
  `tabs.ts` prefix additions do not steal highlighting from another tab.
- The kept-orphan holder list is hand-maintained and has now drifted once, which
  is how #490 could delete a listed holder unnoticed. Worth making generated and
  checked — a one-line `grep -rl SUSPENDED src/` comparison inside the existing
  `scripts/qa-suspend-surfaces.mjs` gate would fail when the registry and the
  tree disagree. Deliberately **not** done here; recorded as the follow-up.
- The same registry lives in `CLAUDE.md`, which is gitignored and therefore
  corrected by the operator, not by this plan. The two lists must be updated
  together or they drift again immediately.
- `/privacy` says the operator should review wording before formal legal
  reliance. This plan makes the page _accurate_; it does not make it _reviewed_.
  Flag that in the PR description.
