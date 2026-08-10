# Plan 085: Derive the payer IP the same way on both money routes

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat db2767f5..HEAD -- backend/packages/api/src/api/store/credits/deposit backend/packages/api/src/api/store/credits/withdraw`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `db2767f5`, 2026-08-07

## Why this matters

Both money routes report the paying customer's IP address to GlobePay365. The
**deposit** route reads `req.ip` first — Medusa's express-loader sets
`trust proxy` 1 unconditionally, so `req.ip` is derived from the proxy chain
and a client cannot set it — and falls back to the raw `X-Forwarded-For` first
hop only if `req.ip` is somehow empty. It says so in a comment and has a
regression test pinning the order.

The **withdrawal** route does the opposite: raw `X-Forwarded-For` first,
`req.ip` as fallback. The leftmost XFF entry is whatever the client typed. So
any authenticated customer can choose the IP address the gateway records for a
**payout** — the higher-risk direction — by setting one header. Whatever geo,
velocity or AML checks the PSP runs on payouts are then evaluated against an
attacker-supplied value.

Both routes landed in the same commit (`d174fa11`) with divergent orderings.
There is no `__tests__` directory under `store/credits/withdraw/` at all.

After this plan: one helper derives the IP, both routes import it, and the pair
cannot drift again.

## Current state

### The withdrawal route today (`store/credits/withdraw/route.ts:41-46`, verbatim)

```ts
const forwarded = req.headers['x-forwarded-for'];
const ipAddress =
  (typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : '') ||
  req.ip ||
  req.socket?.remoteAddress ||
  '0.0.0.0';
```

### The deposit route today (`store/credits/deposit/route.ts:45-56`, verbatim)

```ts
// THEIR requirement is the paying customer's IP, not ours. req.ip FIRST:
// Medusa's express-loader sets `trust proxy` 1 unconditionally, so req.ip is
// derived from the proxy chain and a client cannot set it. The raw
// X-Forwarded-For first hop is client-controlled — reading it first let a
// caller choose the IP we report to GlobePay365, so it is only a fallback for
// a deployment where req.ip is somehow empty.
const forwarded = req.headers['x-forwarded-for'];
const ipAddress =
  req.ip ||
  (typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : '') ||
  req.socket?.remoteAddress ||
  '0.0.0.0';
```

### The existing regression test to mirror

`backend/packages/api/src/api/store/credits/deposit/__tests__/route.unit.spec.ts`
— read it in full before writing the new one. Its header comment states the
rule, it mocks the module under `jest.mock`, builds requests with a `mkReq`
helper, reads the submitted IP through
`const sentIp = () => startMock.mock.calls[0][1].ipAddress;`, and restores
`process.env` in `afterEach` with an explicit comment about process-wide
leakage between suites. Match all of that.

### Where the value goes

`backend/packages/api/src/modules/packs/globepay-withdrawal.ts` passes
`ipAddress` into the `SubmitWithdrawal` request (around :278 — confirm).

### Repo conventions to match

- Shared route helpers live under `backend/packages/api/src/api/utils/`. Read
  one (e.g. `cache-headers.ts`) for the file shape: a long "why" comment block
  above a small exported function.
- Backend source is Prettier-formatted with single quotes; keep diffs narrow.

## Commands you will need

| Purpose             | Command                                                                                                                     | Expected on success |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| Backend typecheck   | `cd backend/packages/api && corepack yarn check-types`                                                                      | exit 0              |
| The two route specs | `cd backend/packages/api && TEST_TYPE=unit NODE_OPTIONS=--experimental-vm-modules npx jest credits --runInBand --forceExit` | all pass            |
| Backend unit tier   | `cd backend/packages/api && corepack yarn test:unit`                                                                        | all pass            |
| Backend lint | NONE. `backend/packages/api` has no eslint config and no `lint` script, so `turbo run lint` skips it and CI never lints this package. Do NOT author one — out of scope. | n/a |

## Scope

**In scope**:

- `backend/packages/api/src/api/utils/payer-ip.ts` (create)
- `backend/packages/api/src/api/store/credits/withdraw/route.ts`
- `backend/packages/api/src/api/store/credits/deposit/route.ts`
- `backend/packages/api/src/api/store/credits/withdraw/__tests__/route.unit.spec.ts` (create)
- `backend/packages/api/src/api/store/credits/deposit/__tests__/route.unit.spec.ts` (adjust imports only if the helper move requires it)
- `plans/README.md` (status row)

**Out of scope**:

- Any other reader of `x-forwarded-for`. Grep for it, list what you find in
  your completion note, but change nothing else — the rate limiters
  deliberately use `req.ip`, and plan 081's notes explain why forwarding
  client headers into a limiter key would be worse than the bug it fixes.
- The `trust proxy` setting itself.
- `globepay-withdrawal.ts` beyond confirming where `ipAddress` lands.

## Git workflow

- Branch: `advisor/085-payer-ip-helper`
- Conventional commits, e.g.
  `fix(payments): derive the payout payer IP from the proxy chain, not the header`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Extract the helper

Create `backend/packages/api/src/api/utils/payer-ip.ts` exporting a single
function (e.g. `payerIpOf(req)`) implementing the **deposit** ordering
verbatim: `req.ip` → forwarded first hop → `req.socket?.remoteAddress` →
`'0.0.0.0'`.

Move the deposit route's existing comment into the helper's doc block, extend
it with one sentence recording why the helper exists (the two routes had
divergent orderings and the money-out one was the unhardened half), and type
the parameter minimally — the helper needs only `ip`, `headers` and `socket`,
so a narrow structural type is better than importing the full request type.

**Verify**: `corepack yarn check-types` → exit 0.

### Step 2: Point both routes at it

Replace the inline chain in **both** routes with a call to the helper. The
deposit route's behaviour must not change at all; the withdrawal route's
ordering flips.

Leave a one-line comment at each call site pointing at the helper, so a reader
skimming the route still sees that the IP is deliberately derived.

**Verify**: `corepack yarn check-types` → exit 0, and
`grep -rn "x-forwarded-for" backend/packages/api/src/api/store/credits/`
returns **no** matches (both inline chains are gone).

### Step 3: Give the withdrawal route the regression test it never had

Create
`backend/packages/api/src/api/store/credits/withdraw/__tests__/route.unit.spec.ts`,
modelled line-for-line on the deposit spec.

Note the withdrawal route reads `GLOBEPAY_WITHDRAW_NOTIFY_URL` and
`GLOBEPAY_PAYOUT_VERIFY_URL` and fails closed when either is missing — set
both in `beforeEach` and restore them in `afterEach`, exactly as the deposit
spec does for its two env vars.

**Verify**: the new spec file exists and
`npx jest credits --runInBand --forceExit` runs it.

## Test plan

New spec cases for the withdrawal route (all required):

1. `req.ip` set and a **different** `x-forwarded-for` present → the submitted
   `ipAddress` is `req.ip`. This is the fix; it must fail if Step 2 is
   reverted.
2. `req.ip` empty, `x-forwarded-for` present → the forwarded first hop is used
   (the fallback still works).
3. `x-forwarded-for` carrying a multi-hop list → the **first** entry, trimmed.
4. Neither set → falls through to `socket.remoteAddress`, then `'0.0.0.0'`.
5. `x-forwarded-for` present as an array (Node can produce that) → does not
   crash and does not produce `[object Object]`.

Also add case 5 to the deposit spec if it is not already covered — read it
first and skip if it is.

Prove case 1 red-green: restore the old ordering in the helper, confirm the
test fails, restore the fix, confirm it passes. Report both.

Verification:
`cd backend/packages/api && TEST_TYPE=unit NODE_OPTIONS=--experimental-vm-modules npx jest credits --runInBand --forceExit`
→ all pass.

## Done criteria

- [ ] `cd backend/packages/api && corepack yarn check-types` exits 0
- [ ] `cd backend/packages/api && corepack yarn test:unit` exits 0
- [ ] `grep -rn "x-forwarded-for" backend/packages/api/src/api/store/credits/` returns no matches
- [ ] `ls backend/packages/api/src/api/store/credits/withdraw/__tests__/route.unit.spec.ts` succeeds
- [ ] The red-green proof for test case 1 is reported
- [ ] Every other `x-forwarded-for` reader in the repo is listed in the completion note (and unchanged)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpts in "Current state" do not match the live code.
- An existing test asserts the **withdrawal** route's current XFF-first
  ordering. That would mean the ordering was deliberate; report the test
  before changing anything.
- The deposit spec fails after the extraction — the helper must be behaviour-
  identical for that route, so a failure means the extraction is wrong, not
  the test.

## Maintenance notes

- **The helper is the single source of truth.** If a third route ever needs to
  report a payer IP, it imports this; it does not re-derive.
- `req.ip` is trustworthy **because** `trust proxy` is 1. If the deployment
  ever gains a second proxy hop, that setting must be revisited — and this
  helper is where the consequence lands. `.env.template` already records the
  proxy-trust question as a prod-checklist item; plan 093 carries it forward.
- A reviewer should scrutinize: that the deposit route's behaviour is byte-
  identical after extraction, and that the new spec's env restoration matches
  the deposit spec's (a leaked env var makes a later suite pass or fail on
  ordering).
