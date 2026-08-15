# Plan 096: State and enforce the free welcome pack's economics (deletion re-arm, eligibility invariant, detail-page truth)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Money-adjacent.** The free pull books real vault liability
> (`vault_value_usd`) and its buyback value becomes withdrawable credit after
> one paid open. Tests first on every behavioral change.
>
> **Drift check (run first)**:
> `git diff --stat 5c74ce17..HEAD -- backend/packages/api/src/subscribers/customer-free-pack.ts backend/packages/api/src/modules/packs/service.ts backend/packages/api/src/api/store/customers/me/delete/route.ts src/app/slots/[slug]/page.tsx src/app/slots/[slug]/PackDetailClient.tsx docs/superpowers/specs/2026-08-14-free-welcome-pack-design.md`
> On any in-scope drift, compare "Current state" before proceeding; mismatch = STOP.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: security / economics
- **Planned at**: commit `5c74ce17`, 2026-08-15

## Why this matters

PR #438 grants one free welcome pack per **registration** (`customer.created`
subscriber, unconditional). Three consequences nobody has written down or
bounded:

1. **Self-deletion re-arms the grant.** PR #434's account deletion hard-deletes
   the auth identities (deliberately, so re-signup works) and soft-deletes the
   customer. A re-signup with the same email mints a NEW `customer_id`, fires
   `customer.created` again, and stamps a fresh free-pack grant. Nothing records
   that this person already consumed one. Delete → re-register → free pack, in
   a loop.
2. **The minted value is fully withdrawable after one paid open.** The free-pull
   lock (server-enforced, sound) lifts on ANY paid open. The sale then credits
   at the free pack's `buyback_percent` (validated ≥90 for the free category) of
   live FMV, with `external_funded_cents = 0` — banking zero playthrough. An
   account that deposits D and spends D on the unlocking open has playthrough
   remaining 0, so the entire free-pull sale value is withdrawable real money.
   Per account the house pays ~0.9 × E[free-pool FMV] against the margin on one
   cheapest paid open — if the operator ever publishes a free pool whose EV
   exceeds that margin, every registration is a guaranteed net loss and farming
   is directly profitable. **No invariant anywhere states the EV constraint.**
3. **The detail page lies to ineligible visitors.** `/slots/[slug]` resolves the
   free pack for anyone with the URL (it is only hidden from the catalog list),
   and `PackDetailClient` keys its "Open Free Pack — nothing charged" rendering
   purely on `pack.categoryId === FREE_WELCOME_CATEGORY`. A customer who already
   spent their claim reaches the page via shared link/history/stale badge and
   sees an unconditional gift CTA the backend then refuses at the reel.

This plan (a) closes the deletion re-arm, (b) writes the EV invariant into the
design doc and an admin-side guard note, (c) gives the detail page an honest
already-claimed state.

## Current state

### Files

- `backend/packages/api/src/subscribers/customer-free-pack.ts` — stamps
  eligibility on `customer.created`, unconditionally (`:30-73`). Never throws;
  per-id catch.
- `backend/packages/api/src/modules/packs/service.ts` —
  `markFreePackAvailable` `:2824-2852` (advisory-locked, first-write-wins on
  `free_pack_available_at`, keyed `customer_id`); `claimFreePack` `:2872-2887`
  (single conditional UPDATE); `clearFreePackClaim` (compensation);
  `hasPaidOpen` `:2911`; `getActiveFreePack` `:2929`. Account deletion:
  `deleteAccountPreflight` `:3921+`, `purgeAccountPacksData` `:4099+`.
- `backend/packages/api/src/api/store/customers/me/delete/route.ts` — step 6
  hard-deletes auth identities (`:246-251`, with the why-comment), step 7
  soft-deletes the customer (`:264`). The header documents the
  destroy-PII / keep-anonymous-books contract.
- `src/app/slots/[slug]/page.tsx` — server component; resolves the pack (incl.
  uncataloged free pack via `getUncatalogedPack` in `src/lib/data/packs.ts:182-207`)
  and renders `PackDetailClient`.
- `src/app/slots/[slug]/PackDetailClient.tsx` — `isFreePack` at `:113`
  (`pack.categoryId === FREE_WELCOME_CATEGORY`); free rendering at `:293-299`
  (badge), `:459-465` (price slot), `:497-501` ("nothing charged" copy),
  mobile dock `:652+`.
- `src/lib/data/free-pack.ts` — `getFreePackState()` returns
  `{ mode: 'claim', slug }` only while THIS customer's claim is unspent;
  `{ mode: 'hidden' }` otherwise. This is the eligibility read the detail page
  should reuse.
- `docs/superpowers/specs/2026-08-14-free-welcome-pack-design.md` — the design
  doc; owns the eligibility model prose.
- Specs that lock current behavior:
  `backend/packages/api/integration-tests/http/free-pack-route.integration.spec.ts`,
  `modules/packs/__tests__/free-pack-claim.integration.spec.ts`,
  `free-pack-open.integration.spec.ts`, `free-pull-lock.integration.spec.ts`,
  `src/subscribers/__tests__/customer-free-pack.unit.spec.ts`,
  `integration-tests/http/account-self-service.spec.ts`.

### Key excerpts (as of `5c74ce17`)

`claimFreePack` (service.ts:2872-2887) — the one-shot claim:

```ts
const rows = await em.execute<{ id: string }[]>(
  'UPDATE customer_account_state ' +
    'SET free_pack_claimed_at = now(), updated_at = now() ' +
    'WHERE customer_id = ? AND free_pack_available_at IS NOT NULL ' +
    'AND free_pack_claimed_at IS NULL AND deleted_at IS NULL ' +
    'RETURNING id',
  [customerId],
);
```

`delete/route.ts:246-251` — the re-arm mechanism (identities hard-deleted so
the email can re-register; correct for its own purpose, do NOT change it):

```ts
const identities = await auth.listAuthIdentities({
  app_metadata: { customer_id: customerId },
});
if (identities.length > 0) {
  await auth.deleteAuthIdentities(identities.map((i) => i.id));
}
```

### Design decision required (made here, executor implements)

The chosen control is **stamp-time gating on phone verification**, NOT a
deletion-surviving marker:

- A marker surviving deletion contradicts #434's destroy-PII contract (it would
  have to key on something identifying — email hash, phone hash — retained
  after deletion). Rejected.
- Phone verification is the control the repo already uses to bound every other
  money surface (`requirePhoneVerified` on topup/deposit/withdraw/delivery),
  and phone numbers are the practical per-person scarcity (one number per
  withdrawal-capable account).
- Concretely: move the stamp from `customer.created` to **first phone
  verification**. The subscriber `customer-phone-verified.ts` already exists
  (it runs `markPhoneVerified`); the free-pack stamp becomes a second effect of
  that event, and `customer-free-pack.ts` is retired. A re-registered account
  can re-verify the same phone — but `markPhoneVerified`'s flow and the
  duplicate-phone signal (plan 092) make the same-number re-verify visible, and
  the phone-OTP rate limits (10/10min, 30/24h per number) price bulk farming.
  This does not make re-arm impossible; it makes it cost a phone number per
  cycle and leaves a visible trail — the same bound every other money surface
  accepts.
- **Behavior change**: unverified accounts no longer see the free pack. The
  logged-out `signup` badge stays (it advertises the promo, not a claim). The
  claim badge appears after phone verification — which is also the moment the
  account becomes able to deposit, so the funnel ordering stays coherent.

If the operator wants a different invariant (e.g. keep per-registration and
accept the farming bound), that is a STOP-and-ask, not an improvisation — but
absent contrary instruction, implement the above.

## Commands you will need

| Purpose                     | Command (run from)                                                                                                                                            | Expected          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| Backend typecheck           | `corepack yarn check-types` (`backend/`)                                                                                                                      | exit 0            |
| Free-pack module suites     | `TEST_TYPE=integration:modules node node_modules/jest/bin/jest.js --silent free-pack` (`backend/packages/api`, live `pokenic-postgres` + `.env.test`)         | pass              |
| Subscriber unit             | `TEST_TYPE=unit node node_modules/jest/bin/jest.js --silent customer-free-pack customer-phone-verified` (`backend/packages/api`)                              | pass              |
| Account-deletion HTTP suite | `NODE_OPTIONS=--experimental-vm-modules TEST_TYPE=integration:http node node_modules/jest/bin/jest.js --silent account-self-service` (`backend/packages/api`) | pass              |
| Storefront                  | `npm run check && npm test` (root)                                                                                                                            | exit 0 / all pass |

## Scope

**In scope**:

- `backend/packages/api/src/subscribers/customer-free-pack.ts` (retire or
  repoint — see Step 2)
- `backend/packages/api/src/subscribers/customer-phone-verified.ts` (add the
  stamp effect)
- Their unit specs
- `docs/superpowers/specs/2026-08-14-free-welcome-pack-design.md` (eligibility
  model + EV invariant sections)
- `src/app/slots/[slug]/page.tsx` (pass eligibility)
- `src/app/slots/[slug]/PackDetailClient.tsx` (already-claimed state)
- One storefront test for the new prop branch

**Out of scope** (do NOT touch):

- `service.ts` free-pack methods — `markFreePackAvailable` / `claimFreePack` /
  `clearFreePackClaim` are correct and stay byte-identical.
- The account-deletion route and purge — their contract is settled (#434).
- The free-pull sell/deliver lock (`buyback-pull.ts`, `request-delivery.ts`) —
  verified correct.
- `FreePackBadge.tsx` / `/api/free-pack` — plan 097's surface. The eligibility
  semantics you change flow through `getFreePackState()` unchanged.
- Admin pack editors.

## Git workflow

- Branch: `advisor/096-free-pack-economics`
- Conventional commits per step, e.g.
  `fix(free-pack): stamp eligibility at phone verification, not registration`.
- No push/PR without operator instruction.

## Steps

### Step 1 (RED): the re-arm regression test

In `free-pack-claim.integration.spec.ts` (or the account-self-service HTTP
suite if the container wiring is easier there — pick ONE), add a case named
for the invariant: _"a deleted-and-reregistered person does not get a second
free pack without re-verifying a phone"_. Drive: create customer → stamp via
the NEW path (phone-verified event) → claim → delete account → re-register same
email → assert no `free_pack_available_at` on the new customer row until phone
verification fires again. (Under the new model the assertion is that
REGISTRATION ALONE never stamps.)

**Verify**: fails under current code (registration stamps immediately).

### Step 2 (GREEN): move the stamp

1. In `customer-phone-verified.ts`, after `markPhoneVerified` succeeds for an
   id, call `packs.markFreePackAvailable(id)` under the same per-id
   never-throws discipline (copy the loop/catch shape from
   `customer-free-pack.ts:42-61` — it exists precisely for this).
2. Retire `customer-free-pack.ts`: delete the subscriber file and its unit
   spec, OR (if `grep -rn "customer-free-pack" backend/packages/api/src` shows
   other references) gut it to a comment pointing at the new home. Prefer
   deletion — dead subscribers are a recorded audit trap in this repo.
3. Move the relevant unit coverage into
   `customer-phone-verified`'s spec: array/object payload shapes, blank ids,
   partial-batch failure, never-throws (the exact cases the old spec had).

**Verify**: Step 1 passes; subscriber unit suites pass; free-pack module
suites pass; `corepack yarn check-types` exit 0.

### Step 3: write the EV invariant down

In `2026-08-14-free-welcome-pack-design.md`, add a short **Economics
invariant** section: the published free pool's expected buyback value
(Σ odds×FMV × buyback_percent) must stay below the gross margin of the
cheapest paid pack open, because the free-pull sale value is withdrawable
after one paid open (`external_funded_cents = 0` banks no playthrough); state
that eligibility is stamped at phone verification (this plan) and why. Also
update the eligibility-model prose that currently says "new registrations
only".

**Verify**: `grep -n "Economics invariant" docs/superpowers/specs/2026-08-14-free-welcome-pack-design.md` → 1 match.

### Step 4 (RED): detail-page eligibility test

Storefront: add a test (pattern: existing `PackDetailClient`-adjacent tests or
the hand-rolled createRoot harness used by `use-*` hook tests) asserting that
when the free pack renders with `freePackEligible={false}`, the CTA is not
"Open Free Pack" and an already-claimed message renders instead.

**Verify**: fails (prop doesn't exist yet).

### Step 5 (GREEN): honest detail page

1. `src/app/slots/[slug]/page.tsx`: when the resolved pack's `categoryId ===
FREE_WELCOME_CATEGORY`, call `getFreePackState()` (already importable from
   `@/lib/data/free-pack`) and pass
   `freePackEligible={state.mode === 'claim' && state.slug === pack.slug}`
   into `PackDetailClient`. Non-free packs pass nothing (default true is
   WRONG — default `false` and gate all free rendering on
   `isFreePack && freePackEligible`? No: default the prop to `true` so the
   non-free path is untouched, and pass the computed value only for the free
   pack. Keep the diff minimal.)
2. `PackDetailClient.tsx`: accept `freePackEligible?: boolean` (default
   `true`). Where `isFreePack` currently renders the gift CTA
   (`:293-299`, `:459-465`, `:497-501`, and the mobile dock), branch: if
   `isFreePack && !freePackEligible`, render an "Already claimed — your
   welcome pack was a one-time gift" state (match the page's existing muted
   copy style, e.g. the sold-out state if one exists) with no spin CTA and no
   "nothing charged" promise.

**Verify**: Step 4 passes; `npm run check` + `npm test` green.

## Test plan

- Backend: 1 new integration case (Step 1), migrated subscriber unit cases
  (Step 2.3). Existing free-pack suites are the regression net — all must stay
  green: claim idempotency, open compensation, paid-open lock lift, route.
- Storefront: 1 new component/branch test (Step 4).
- Full: the five commands in the table.

## Done criteria

- [ ] `grep -rn "customer.created" backend/packages/api/src/subscribers/customer-free-pack.ts` → file absent or contains no live subscriber
- [ ] `grep -n "markFreePackAvailable" backend/packages/api/src/subscribers/customer-phone-verified.ts` → ≥1
- [ ] Step 1's regression case exists and passes
- [ ] `grep -n "freePackEligible" src/app/slots/[slug]/PackDetailClient.tsx` → ≥2 (prop + gate)
- [ ] Design doc carries the Economics invariant section
- [ ] All table commands green; `git status` clean outside scope
- [ ] `plans/README.md` row updated

## STOP conditions

- `customer-phone-verified.ts` does not exist or does not run
  `markPhoneVerified` (model drifted) — STOP.
- The e2e suite (`tests/e2e`) turns out to depend on registration-time free-pack
  availability (grep `free` under `tests/e2e/` first) — STOP and report which
  specs; they need a phone-verify step added, which is its own decision.
- The operator's live prod already has stamped-but-unclaimed grants from the
  registration era: this plan does NOT revoke them (`free_pack_available_at`
  stays). If you find code that would revoke them, you are off-plan — STOP.
- Anything requires touching `claimFreePack`/`markFreePackAvailable` bodies.

## Maintenance notes

- The stamp now depends on the phone-verification rollout flags; if the phone
  gate is ever disabled site-wide (the #390 incident shape), free packs stop
  being granted — that coupling is deliberate (no verified phone = no money
  surface) but should be named in any incident runbook touching the gate.
- Reviewer: check Step 2's event payload handling against
  `customer-phone-verified.ts`'s actual event shape — the free-pack loop must
  not assume `customer.created`'s array shape.
- Deferred: an admin-side EV calculator/warning when publishing a free pool
  (DIR-G's funnel tile is the natural home); recorded in the design doc, not
  built here.
