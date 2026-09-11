# Plan 135: Storefront money-surface truth — never say "try again" over a charged open, honour the gateway's channel flags, drop the phantom RM 10,000 clamp, stop shipping a 68 KB image eagerly

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If a
> STOP condition occurs, stop and report — do not improvise. Do NOT update
> `plans/README.md`; the reviewer maintains it.
>
> **Drift check (run first)**:
> `git diff --stat 1bc30e6b..HEAD -- src/lib/actions/packs.ts src/lib/actions/__tests__/packs.test.ts src/lib/actions/vault.ts src/lib/payment-limits.ts src/lib/data/schemas.ts src/components/app-shell/TopUpSheet.tsx src/components/app-shell/__tests__/topup-sheet-gateway.test.ts src/app/bank-withdrawal/WithdrawForm.tsx src/components/app-shell/TelegramBanner.tsx`
> Expected on a branch cut from origin/master `51f74bcd`: only
> `src/lib/data/schemas.ts` (+19, `AccountInfoSchema` policy fields — nothing
> near `PaymentConfigSchema`). Anything else → compare against "Current
> state"; on a mismatch, STOP.

## Status

- **Priority**: P2
- **Effort**: S–M
- **Risk**: LOW — copy, two optional schema fields, one clamp, two image props
- **Depends on**: none
- **Category**: bug / tech-debt / perf
- **Planned at**: commit `1bc30e6b` (working tree), 2026-09-10; drift-checked against origin/master `51f74bcd`

## Why this matters

Four small, adjacent defects on the surfaces where the customer spends and
adds money, each confirmed by reading the cited lines:

1. **"Please try again." over a committed, charged open.** `openBatch` and
   `openPack` return `PACKS_FALLBACK` (`'Could not open the pack. Please try
again.'`) at three sites that are reached only **after** a 2xx — i.e. after
   the backend has debited the customer and vaulted the pulls: a 200 body
   whose `rolls` is not an array, and the projection `catch` blocks of both
   actions. `schemas.ts:143-146` states the rule in this same delta: that
   sentence is "the one sentence a committed open must never show". The
   sibling branch four lines away already has the honest copy ("Your pack
   opened and the card is in your Vault, but we couldn't show it here.").
   The slot machine treats a rejected result with `needsTopUp !== true` by
   refreshing the balance and re-enabling Spin (`SlotMachineClient.tsx:520-542`)
   — so the customer sees a lower balance next to an invitation to pay again.
2. **The channel flags never reach the customer.** `GET /store/payments/config`
   sends `deposits_enabled` and `withdrawals_enabled` and its header says the
   storefront needs them "to render the top-up sheet and the withdrawal
   form"; `PaymentConfigSchema` / `PaymentLimits` / `getPaymentLimits` drop
   both. With a channel switched off the sheet still offers presets and a
   live Pay button; the customer learns from the refusal after submitting.
3. **A hard-coded `Math.min(10_000, limits.max)`** survives in `TopUpSheet`
   under a header that says the band "belongs to whichever gateway the admin
   has active". Inert today (TGPay's ceiling is exactly 10,000) and wrong the
   day a gateway with a higher ceiling is switched on.
4. **The Telegram ticket** (`#573`) renders a 68,246-byte 864×393 `.webp` in a
   160–240 px box with `unoptimized` (so `sizes` is inert) and
   `loading="eager"`, on every route except three, before `useAuth` has even
   resolved — an LCP competitor on a 1-vCPU instance for ~60 KB nobody sees.

After this plan: every post-2xx failure path in the open actions says where
the card went; a closed deposit or withdrawal channel is shown as closed
before the customer types; the sheet's ceiling is the gateway's; the ticket
image is served at its rendered size and lazily.

## Current state

### Files

- `src/lib/actions/packs.ts` — `PACKS_FALLBACK` (107); `openPack` projection catch (199-207); `openBatch` non-array guard (266-274), honest sibling (287-293), projection catch (308-316).
- `src/lib/actions/__tests__/packs.test.ts` — pins the current strings at 247-262 and 338-360.
- `src/lib/data/schemas.ts` — `PaymentConfigSchema` (513-517).
- `src/lib/payment-limits.ts` — `PaymentLimits` type + `DEFAULT_PAYMENT_LIMITS`.
- `src/lib/actions/vault.ts` — `getPaymentLimits` (186-199).
- `src/components/app-shell/TopUpSheet.tsx` — clamp at 130; band fetch 122-146; header 27-45.
- `src/components/app-shell/__tests__/topup-sheet-gateway.test.ts` — eight cases; `'offers no Pay button above the RM 10,000 ceiling'` at 203.
- `src/app/bank-withdrawal/WithdrawForm.tsx` — band fetch at 92-99.
- `src/components/app-shell/TelegramBanner.tsx` — `<Image>` at 75-84.
- `backend/packages/api/src/api/store/payments/config/route.ts` — the source of truth for (2); read-only for this plan.

### Excerpts

```ts
// src/lib/actions/packs.ts:107
const PACKS_FALLBACK = 'Could not open the pack. Please try again.';

// src/lib/actions/packs.ts:199-207 (openPack — inside the r.ok projection try/catch)
  } catch (error) {
    logger.error('[packs] response projection failed:', error);
    return {
      ok: false,
      error: PACKS_FALLBACK,
      needsAuth: false,
      needsTopUp: false,
    };
  }

// src/lib/actions/packs.ts:266-274 (openBatch — inside r.ok)
    if (!Array.isArray(rawRolls)) {
      logger.error(`[packs] open-batch returned no rolls array for '${slug}'`);
      return {
        ok: false,
        error: PACKS_FALLBACK,
        needsAuth: false,
        needsTopUp: false,
      };
    }

// src/lib/actions/packs.ts:287-293 (the honest sibling)
    if (rolls.length === 0 && rawRolls.length > 0) {
      return {
        ok: false,
        error:
          "Your pack opened and the card is in your Vault, but we couldn't show it here.",
      };
    }
```

The comment above the non-array guard (260-265) explains it exists to keep
the _pre-port_ answer (`PACKS_FALLBACK` with both flags false) "rather than
invoking card-mapping copy". That reasoning predates the `schemas.ts` rule
and is what this plan overrides — the guard stays; only the sentence changes.

The rule (same delta):

```ts
// src/lib/data/schemas.ts:140-146
 * - the response must not be REJECTED at the envelope because the customer has
 *   already been CHARGED (`openPack`/`openBatch`/the free-rip spend). A drifted
 *   field would classify as `invalid_shape`, and that action's copy for a
 *   generic failure says "try again" — the one sentence a committed open must
 *   never show.
```

The tests that pin today's strings:

```ts
// src/lib/actions/__tests__/packs.test.ts:247-253
  it('a body with no rolls array answers, never throws, over a charged batch', async () => {
    backend({ 'POST /store/packs/:slug/open-batch': { body: { balance: 880 } } });
    expect(await openBatch('bronze', 2)).toEqual({
      ok: false,
      error: 'Could not open the pack. Please try again.',
// src/lib/actions/__tests__/packs.test.ts:341-360 ('unchecked JSON projection parity')
    backend({ 'POST /store/packs/:slug/open': { body: null } });
    await expect(openPack('bronze')).resolves.toEqual({ ok: false, error: 'Could not open the pack. Please try again.', needsAuth: false, needsTopUp: false });
  it.each([null, { rolls: [null] }])('contains malformed batch projection %j', ...
```

Note `{ rolls: [null] }` reaches the honest branch today (one unmappable
roll → `rolls.length === 0 && rawRolls.length > 0`)? No — read the test:
it expects the fallback string, which means `mapBatchRoll(null)` throws
before that branch and lands in the catch. Both are post-2xx; both change.

Channel flags:

```ts
// backend/.../store/payments/config/route.ts:20-26
res.json({
  gateway,
  deposits_enabled: gatewayEnabled(),
  withdrawals_enabled: withdrawalsEnabled(),
  deposit: { min_rm: limits.depositMin, max_rm: limits.depositMax },
  withdrawal: { min_rm: limits.withdrawalMin, max_rm: limits.withdrawalMax },
});
// src/lib/data/schemas.ts:513-517
export const PaymentConfigSchema = z.looseObject({
  gateway: z.string(),
  deposit: z.looseObject({ min_rm: finite, max_rm: finite }),
  withdrawal: z.looseObject({ min_rm: finite, max_rm: finite }),
});
// src/lib/payment-limits.ts:6-10
export type PaymentLimits = {
  gateway: string;
  deposit: { minRm: number; maxRm: number };
  withdrawal: { minRm: number; maxRm: number };
};
// src/lib/actions/vault.ts:186-199 (getPaymentLimits) maps the four numbers; any failure → DEFAULT_PAYMENT_LIMITS
```

The clamp:

```ts
// src/components/app-shell/TopUpSheet.tsx:126-130
const [limits, setLimits] = useState({
  min: GATEWAY_MIN_RM,
  max: GATEWAY_MAX_RM,
});
const minAmount = USE_GATEWAY ? Math.max(0.01, limits.min) : 0.01;
const maxAmount = USE_GATEWAY ? Math.min(10_000, limits.max) : 10_000;
// src/components/app-shell/TopUpSheet.tsx:42-46
// The band belongs to whichever gateway the admin has active, so it is
// fetched per open (getPaymentLimits); these are only the until-it-answers
// defaults, which sit inside every gateway's band.
const GATEWAY_MIN_RM = DEFAULT_PAYMENT_LIMITS.deposit.minRm;
const GATEWAY_MAX_RM = DEFAULT_PAYMENT_LIMITS.deposit.maxRm;
```

The backend enforces its own ceiling (`TOPUP_MAX_RM`, `gateway-deposit.ts:519`)
regardless of the sheet, so removing the clamp cannot let a larger amount
through; it only stops the sheet lying about the ceiling.

The image:

```tsx
// src/components/app-shell/TelegramBanner.tsx:75-84
<Image
  src="/images/polycards/telegram-community-ticket.webp"
  alt="Join our Telegram community — Join now"
  width={864}
  height={393}
  loading="eager"
  unoptimized
  sizes="(max-width: 400px) 160px, (max-width: 600px) 40vw, 240px"
  className="block h-auto w-full [mask-image:url('/images/polycards/telegram-ticket-mask.svg')] [mask-size:100%_100%]"
/>
```

`next.config.ts:129` — `images: { remotePatterns, dangerouslyAllowLocalIP }`;
local `/images/**` paths are optimisable by default (the file's comment at
line 13 says so). The component returns `null` until `useAuth` resolves, so
`eager` never affects LCP positively.

### Conventions

- Copy in this repo is plain, honest, and names where the money went
  (`PRODUCT.md` principle 3: "Never gamble-ify the money"; CONTEXT.md §Money).
- Optional-with-fallback schema fields use `.optional()` (see
  `ReferralSummarySchema.code`), and a comment saying which backend version
  omits the field.
- Component tests: vitest + jsdom; `topup-sheet-gateway.test.ts` is the
  pattern for the sheet (it stubs `getPaymentLimits` — read its `vi.mock`
  block first).
- `DESIGN.md` §5 "Inputs / Fields": a disabled money field shows a reason
  line under it; reuse the sheet's existing guidance line under the amount
  field for the closed-channel message rather than adding a banner.

## Commands you will need

| Purpose                                                    | Command                                                                                                                                                                                                                                                 | Expected on success |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| Typecheck                                                  | `npm run typecheck`                                                                                                                                                                                                                                     | exit 0              |
| Lint                                                       | `npm run lint`                                                                                                                                                                                                                                          | exit 0              |
| Format                                                     | `npx prettier --check src/lib/actions/packs.ts src/lib/actions/vault.ts src/lib/payment-limits.ts src/lib/data/schemas.ts src/components/app-shell/TopUpSheet.tsx src/app/bank-withdrawal/WithdrawForm.tsx src/components/app-shell/TelegramBanner.tsx` | exit 0              |
| Tests (filtered)                                           | `npx vitest run src/lib/actions/__tests__/packs.test.ts src/components/app-shell/__tests__ src/lib/actions/__tests__/vault.test.ts`                                                                                                                     | all pass            |
| Full unit suite                                            | `npm test`                                                                                                                                                                                                                                              | 114+ files pass     |
| Prod build (image optimisation is a build/runtime concern) | `npm run build`                                                                                                                                                                                                                                         | exit 0              |

## Scope

**In scope** (the only files you should modify):

- `src/lib/actions/packs.ts`
- `src/lib/actions/__tests__/packs.test.ts`
- `src/lib/data/schemas.ts` — `PaymentConfigSchema` only
- `src/lib/payment-limits.ts`
- `src/lib/actions/vault.ts` — `getPaymentLimits` only
- `src/lib/actions/__tests__/vault.test.ts` — if it pins `getPaymentLimits`
- `src/components/app-shell/TopUpSheet.tsx`
- `src/components/app-shell/__tests__/topup-sheet-gateway.test.ts`
- `src/app/bank-withdrawal/WithdrawForm.tsx`
- `src/components/app-shell/TelegramBanner.tsx`

**Out of scope** (do NOT touch, even though they look related):

- `src/app/slots/[slug]/SlotMachineClient.tsx` — the rejected-result handling (balance refresh, Vault dot, phase → idle) is correct; only the sentence it displays changes.
- `PACKS_FALLBACK` for **pre-2xx** failures (`openFailure`, line 131) — "try again" is right there.
- The backend `/store/payments/config` route and `gatewayEnabled` / `withdrawalsEnabled`.
- The `DEFAULT_PAYMENT_LIMITS` numbers — documented as the intersection of every gateway's band.
- The Telegram ticket's dismissal logic, `sessionStorage` handling, route exclusions, and the guest-cannot-dismiss product choice.
- `public/images/polycards/telegram-community-ticket.webp` itself — do not re-encode the asset; Step 4 lets the optimizer do it.

## Git workflow

- Branch: `advisor/135-storefront-money-sheet-truth`
- Conventional commits per step, e.g. `fix(packs): never say "try again" over an open that already charged`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Charged-open copy

`packs.ts`: hoist the honest sentence to a constant beside `PACKS_FALLBACK`:

```ts
const PACKS_FALLBACK = 'Could not open the pack. Please try again.';
// Every failure AFTER a 2xx: the open is committed and the pull vaulted, so
// "try again" would invite a second charge (schemas.ts, the unchecked-envelope
// rule). Says where the card went instead.
const CHARGED_BUT_UNSHOWABLE =
  "Your pack opened and the card is in your Vault, but we couldn't show it here.";
```

Use it at: the existing honest branch (287-293), the `openPack` projection
catch (203), the `openBatch` non-array guard (270), the `openBatch` projection
catch (312). Keep `needsAuth: false, needsTopUp: false` on all of them —
`needsTopUp: false` is what makes `handleRoll` refresh the balance and light
the Vault dot. Rewrite the comment at 260-265 to say the guard keeps the
**shape** (both flags false) but not the pre-port sentence, and why.

The `openPack` catch also covers `r.data === null` (the `'contains a null
single-open envelope'` test). A null 2xx body is still a 2xx — the charge
committed — so it takes the new sentence too.

**Verify**: `grep -n "PACKS_FALLBACK" src/lib/actions/packs.ts` → the
constant declaration plus **exactly one** use, inside `openFailure` (the
pre-2xx path). `npx vitest run src/lib/actions/__tests__/packs.test.ts` →
fails on the four pinned strings (expected); proceed to Step 2.

### Step 2: Re-pin the tests

`packs.test.ts`: at 247-262 and 338-360 change the expected `error` to the
new sentence and rename the `'unchecked JSON projection parity'` describe's
intent in its comment: parity with the pre-port **shape**, not the pre-port
sentence. Add one new case: `'every post-2xx failure path says where the
card went — none says try again'` that runs the three malformed bodies
(`{ balance: 880 }`, `null`, `{ rolls: [null] }`) through the two actions and
asserts `error` does not match `/try again/i` for any of them.

**Verify**: `npx vitest run src/lib/actions/__tests__/packs.test.ts` → all pass.

### Step 3: Channel flags to the storefront

`schemas.ts` `PaymentConfigSchema`: add

```ts
  // Absent on a backend older than #557's /store/payments/config; absent
  // reads as open so an older backend keeps today's behaviour.
  deposits_enabled: z.boolean().optional(),
  withdrawals_enabled: z.boolean().optional(),
```

`payment-limits.ts` `PaymentLimits`: add `depositsEnabled: boolean;
withdrawalsEnabled: boolean;` and set both `true` in
`DEFAULT_PAYMENT_LIMITS` (the until-it-answers value must not close a
channel).

`vault.ts` `getPaymentLimits`: map `depositsEnabled: r.data.deposits_enabled ?? true`,
`withdrawalsEnabled: r.data.withdrawals_enabled ?? true`.

`TopUpSheet.tsx`: store the whole `PaymentLimits` in state instead of
`{ min, max }` (keep the reset-on-open behaviour at 138-141). When
`USE_GATEWAY && !limits.depositsEnabled`: disable the amount input and the
Pay button and show, in the existing guidance line under the field,
"Top-ups are paused right now. Your balance and cards are unaffected." (No
banner, no new element — DESIGN.md §5 Inputs.)

`WithdrawForm.tsx`: same pattern with `withdrawalsEnabled` — disable the
amount field and submit, guidance line "Withdrawals are paused right now."
Keep the saved-accounts list rendering as today.

**Verify**: `npm run typecheck` → exit 0; `npx vitest run src/components/app-shell/__tests__/topup-sheet-gateway.test.ts` → existing eight pass (the mock's `getPaymentLimits` return gains the two booleans — update the mock), plus the new case from the Test plan.

### Step 4: The clamp

`TopUpSheet.tsx:130`: `const maxAmount = USE_GATEWAY ? limits.deposit.maxRm : 10_000;`
(field names per your Step 3 state shape). Rename the test
`'offers no Pay button above the RM 10,000 ceiling'` (203) to `'offers no
Pay button above the gateway's ceiling'` and make it feed a ceiling of
12,000 through the mocked `getPaymentLimits`, asserting 12,000.01 has no Pay
button and 12,000 does — that is the assertion the literal clamp would fail.

**Verify**: `grep -n "10_000" src/components/app-shell/TopUpSheet.tsx` → only the non-gateway (`mock`) branch and the doc comment at 62 remain.

### Step 5: The image

`TelegramBanner.tsx`: remove `unoptimized` and `loading="eager"`. Keep
`sizes`, `width`, `height` and the mask class. Then confirm the optimizer
serves it: `npm run build`, then serve the standalone bundle per CLAUDE.md
(`pwsh scripts/serve-standalone.ps1 -Port 4000`) and request
`/_next/image?url=%2Fimages%2Fpolycards%2Ftelegram-community-ticket.webp&w=256&q=75`
with curl — a `200` `image/webp` under 15 KB. Stop the server afterwards
(`Get-Process node | Stop-Process -Force` if it lingers — CLAUDE.md's
runaway-node note).

If the mask visibly misaligns on the resized variant (the mask is CSS on the
element, so it should not), STOP and report with a screenshot from
`scripts/qa-telegram-banner.mjs`.

**Verify**: `grep -c "unoptimized\|loading=\"eager\"" src/components/app-shell/TelegramBanner.tsx` → `0`; the curl above returns `HTTP/1.1 200` with `content-type: image/webp`.

### Step 6: Full verification

Run every command in the Commands table.

## Test plan

- `packs.test.ts`: Step 2's re-pins plus the new "none says try again" case.
- `topup-sheet-gateway.test.ts`: (a) `depositsEnabled: false` → amount input
  disabled, no Pay button, guidance line says "paused"; (b) the 12,000
  ceiling case (Step 4); (c) existing cases unchanged.
- `vault.test.ts` (if it covers `getPaymentLimits`): a config body without
  the two flags yields `depositsEnabled: true`; with `deposits_enabled: false`
  yields `false`.
- `WithdrawForm`: if a test file exists under `src/app/bank-withdrawal/__tests__`,
  add the mirror of (a); if none exists, do not create one — the withdraw form
  is covered by `scripts/qa-tgpay-withdraw.mjs` (Playwright) and a jsdom test
  of a form that mounts `useLiquidGlass` is not worth its setup.
- Mutation check: revert Step 1's `openBatch` non-array site to
  `PACKS_FALLBACK` → the new "none says try again" case fails; restore.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `npm run typecheck`, `npm run lint`, the prettier check → exit 0
- [ ] `npx vitest run src/lib/actions/__tests__/packs.test.ts src/components/app-shell/__tests__` exits 0 with ≥ 3 new cases
- [ ] `grep -c "PACKS_FALLBACK" src/lib/actions/packs.ts` → `2` (declaration + `openFailure`)
- [ ] `grep -c "deposits_enabled" src/lib/data/schemas.ts src/lib/actions/vault.ts` → each `1`
- [ ] `grep -c "Math.min(10_000" src/components/app-shell/TopUpSheet.tsx` → `0`
- [ ] `grep -c "unoptimized" src/components/app-shell/TelegramBanner.tsx` → `0`
- [ ] `npm run build` exits 0
- [ ] `git status --porcelain` lists only in-scope files

## STOP conditions

Stop and report back (do not improvise) if:

- `openBatch` / `openPack` no longer have the `r.ok` → projection structure
  with a `catch` returning `PACKS_FALLBACK` (the #561 store-port refactor
  moved again).
- `SlotMachineClient` branches on the **text** of `error` anywhere
  (`grep -n "try again" src/app/slots/[slug]/SlotMachineClient.tsx` must be
  empty) — if it does, changing the sentence changes control flow.
- `/store/payments/config` no longer sends the two flags (re-read the route).
- The optimizer returns a non-200 for the local image in Step 5 (a
  `localPatterns` change) — report, do not add `unoptimized` back silently.

## Maintenance notes

- Reviewers: read the four copy sites together; the invariant is "after a
  2xx, never 'try again'". A future free-rip or free-welcome path added to
  `packs.ts` must use `CHARGED_BUT_UNSHOWABLE` on its post-2xx failures.
- The channel-closed guidance copy is deliberately calm (`PRODUCT.md`
  anti-reference: no manufactured urgency). If the operator wants a link to
  `/contact`, add it there, not a modal.
- Deferred: `deposits_enabled` could also hide the top-up entry points
  (`/me` tile, the `TopUpProvider` trigger) rather than only disabling the
  sheet. Product call; not this plan.
- `DEFAULT_PAYMENT_LIMITS` still hard-codes TGPay's band as the fallback;
  when a second gateway is configured, keep it the intersection (its own
  comment says so).
