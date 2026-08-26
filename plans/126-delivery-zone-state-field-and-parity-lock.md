# Plan 126: Collect the State the shipping zone is billed on, and parity-lock the delivery-fee mirror

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If a
> STOP condition occurs, stop and report — do not improvise. Do NOT update
> `plans/README.md`; the reviewer maintains it.
>
> **Drift check (run first)**:
> `git diff --stat affaab51..HEAD -- src/lib/delivery-fee.ts src/lib/actions/delivery.ts "src/app/(account)/addresses/AddressesClient.tsx" src/components/account/RequestDeliveryModal.tsx backend/packages/api/src/modules/packs/delivery.ts`
> On any change, re-read the file and compare against the "Current state"
> excerpts below. On a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED — changes what customers are charged for shipping, and edits two live address forms
- **Depends on**: none
- **Category**: security / bug
- **Planned at**: commit `affaab51`, 2026-08-26

## Why this matters

PR #491 made physical delivery wallet-charged, with a zone-based shipping fee:
RM15 West Malaysia, RM35 East. The commit records a security review that closed
a spoofing hole — a customer in Sabah typing a Kuala Lumpur postcode would
otherwise be billed the cheap West rate. The fix bills the **more expensive** of
the postcode zone and the address's state/city.

That fix does not work in production, because **no address form in the product
collects a state**. Every storefront-created address stores `province = null`,
so the composite check collapses to a 12-name city allowlist. An East Malaysian
address in any city outside those twelve — Kudat, Semporna, Papar, Beaufort,
Limbang, Sri Aman, Mukah and so on — combined with any West postcode is billed
RM15 instead of RM35. That is RM20 of real money per shipment, repeatable, with
no server-side signal that the fee was wrong.

The backend is already fully wired for this: `ship_province` is snapshotted on
the order, threaded into the charge, and re-checked on address edits. The only
missing piece is the input.

The second half of this plan closes the reason this class of bug will recur:
the storefront hand-copies the backend's fee math — rates, thresholds and the
zone regex — joined to it by nothing but a comment saying "keep the two in
sync". A one-sided rate edit quotes one number and charges another, with both
test suites green.

After this plan: the zone is billed on a state the customer actually chose, and
a one-sided edit to the fee math fails a test.

## Current state

### The backend is ready; only the input is missing

```ts
// backend/packages/api/src/modules/packs/delivery.ts:161-164
export const WEST_SHIPPING_MYR = 15;
export const EAST_SHIPPING_MYR = 35;
export const PROTECTION_INCLUDED_MYR = 200;
export const INSURANCE_RATE = 0.05;
```

```ts
// backend/packages/api/src/modules/packs/delivery.ts:181-219
// East Malaysia = Labuan 87xxx, Sabah 88xxx–91xxx, Sarawak 93xxx–98xxx — one
// contiguous numeric range (92xxx is unassigned in Malaysia's plan).
export function isEastMalaysiaPostcode(postalCode: string): boolean {
  const digits = postalCode.trim();
  if (!/^\d{5}$/.test(digits)) return false;
  const n = Number(digits);
  return n >= 87000 && n <= 98999;
}
/* ... */
// The East Malaysian states + their major localities. Matched on the address's
// province AND city because the postcode alone is customer-typed: a Sabah
// customer entering a KL postcode would otherwise be billed West RM15 for an
// East parcel (security review 2026-08-25, MEDIUM). Word-boundary anchored so
// a West place name can't collide on a substring.
const EAST_PLACE_RE =
  /\b(sabah|sarawak|labuan|kota\s*kinabalu|kuching|sandakan|tawau|miri|sibu|bintulu|lahad\s*datu|keningau)\b/i;

// The zone actually billed: the MORE EXPENSIVE of what the postcode says and
// what the state/city says. Both inputs are customer-supplied, so the rule is
// deliberately asymmetric — a mismatch bills East rather than under-charging a
// real East Malaysian shipment.
export function deliveryZone(
  postalCode: string,
  province: string | null | undefined,
  city: string | null | undefined,
): DeliveryZone {
  if (isEastMalaysiaPostcode(postalCode)) return 'east';
  const place = [province, city].filter(Boolean).join(' ');
  return EAST_PLACE_RE.test(place) ? 'east' : 'west';
}
```

The province is already carried end to end on the backend — the address-edit
guard re-derives the same composite zone from the stored snapshot:

```ts
// backend/packages/api/src/api/store/delivery-orders/[id]/address/route.ts:85-101
  // Compares the SAME composite zone the charge used (postcode + state/city),
  // not the postcode alone — otherwise re-pointing a KL-postcode order at a
  // Sabah address would keep the RM15 it paid.
  if (
    order.shipping_fee != null &&
    deliveryZone(
      snapshot.ship_postal_code,
      snapshot.ship_province,
      snapshot.ship_city,
    ) !==
      deliveryZone(order.ship_postal_code, order.ship_province, order.ship_city)
  ) {
```

### Nothing collects a province

The storefront type has the field, optional:

```ts
// src/lib/actions/delivery.ts:359-369
export type AddAddressInput = {
  firstName: string;
  lastName: string;
  address1: string;
  address2?: string;
  city: string;
  province?: string;
  postalCode: string;
  countryCode: string;
  phone?: string;
};
```

The required-field gate does not include it:

```ts
// src/lib/actions/delivery.ts:~400-406
const missingRequired = (input: AddAddressInput): boolean =>
  !input.address1?.trim() ||
  !input.city?.trim() ||
  !input.postalCode?.trim() ||
  !input.countryCode?.trim();
```

The payload therefore always sends `null`:

```ts
// src/lib/actions/delivery.ts:387-397
const addressBody = (input: AddAddressInput) => ({
  first_name: input.firstName,
  last_name: input.lastName,
  address_1: input.address1,
  address_2: input.address2 || null,
  city: input.city,
  province: input.province || null,
  postal_code: input.postalCode,
  country_code: input.countryCode,
  phone: input.phone || null,
});
```

**Form 1 — the address book.** `src/app/(account)/addresses/AddressesClient.tsx`
has a `field(...)` helper declared at line 235 and used to build the grid. There
is no province entry, and the blank-form seed has no key for it:

```tsx
// src/app/(account)/addresses/AddressesClient.tsx:20-27
const EMPTY_FORM: AddAddressInput = {
  firstName: '',
  lastName: '',
  address1: '',
  city: '',
  postalCode: '',
  countryCode: '',
};
```

```tsx
// src/app/(account)/addresses/AddressesClient.tsx:336-362 (abridged)
          <div className="mt-4 grid grid-cols-2 gap-2">
            {field('First name', 'firstName', { autoComplete: 'given-name', required: true })}
            {field('Last name', 'lastName', { autoComplete: 'family-name', required: true })}
            <div className="col-span-2">
              {field('Address', 'address1', { autoComplete: 'address-line1', required: true })}
            </div>
            {field('City', 'city', { autoComplete: 'address-level2', required: true })}
            {field('Postal code', 'postalCode', { autoComplete: 'postal-code', required: true })}
            {field('Country code', 'countryCode', {
              autoComplete: 'country',
              placeholder: 'e.g. MY',
              maxLength: 2,
              required: true,
              pattern: '[A-Za-z]{2}',
              title: 'Two-letter country code, for example MY',
            })}
```

The edit path already reads a stored province back into form state, so once the
field exists, editing a legacy address surfaces its (empty) value:

```tsx
// src/app/(account)/addresses/AddressesClient.tsx:38
  province: a.province ?? undefined,
```

**Form 2 — the delivery-request modal.**
`src/components/account/RequestDeliveryModal.tsx` is a controlled form
(`const [form, setForm] = useState<AddAddressInput>({...})` at line 57, submitted
via `addAddress(form)` at line 104). Its fields are hand-written `<label>` +
`<input aria-label=...>` pairs sharing an `INPUT_CLASS` constant, e.g.:

```tsx
// src/components/account/RequestDeliveryModal.tsx:278-292
<label className="block">
  <span className="mb-1.5 block text-[12px] font-medium text-white/55">
    City
  </span>
  <input
    aria-label="City"
    autoComplete="address-level2"
    value={form.city}
    onChange={(e) => setForm((f) => ({ ...f, city: e.target.value }))}
    className={INPUT_CLASS}
  />
</label>
```

### The mirror to lock

`src/lib/delivery-fee.ts` re-declares the backend's money math verbatim:

```ts
// src/lib/delivery-fee.ts:12-15
export const WEST_SHIPPING_MYR = 15;
export const EAST_SHIPPING_MYR = 35;
export const PROTECTION_INCLUDED_MYR = 200;
export const INSURANCE_RATE = 0.05;
```

```ts
// src/lib/delivery-fee.ts:38-39
const EAST_PLACE_RE =
  /\b(sabah|sarawak|labuan|kota\s*kinabalu|kuching|sandakan|tawau|miri|sibu|bintulu|lahad\s*datu|keningau)\b/i;
```

`isEastMalaysiaPostcode`, `isShippablePostcode`, `deliveryZone`, `toCents` and
`computeDeliveryFee` have identical bodies to their backend twins. The file's
docblock says "keep the two in sync when rates change" — that comment is the
only link between them.

The customer sees the storefront copy's number
(`src/components/account/RequestDeliveryModal.tsx:20,370`) and the wallet is
debited from the backend copy (`service.ts:3798,3842`).

### The exemplar to copy for the parity test

This repo has converged on one technique for exactly this problem — read the
other side's **source text** and regex the constant out, because the two
packages are not on one module graph:

```ts
// src/lib/__tests__/buyback-parity.test.ts:1-33 (abridged)
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { FLAT_BUYBACK_PERCENT } from '@/lib/packs-data';

// FLAT_BUYBACK_PERCENT is a hand-copied mirror of the backend's FLAT_PERCENT,
// and BUYBACK_RATE_LABEL is quoted as a guarantee on public marketing pages.
// If the backend rate ever moves and the mirror does not, the storefront makes
// a false money promise. Nothing else links the two files, so read the backend
// constant from source rather than importing it (the backend is a separate
// package with its own tsconfig, not on this project's module graph).
const BACKEND_SRC = join(
  process.cwd(),
  'backend/packages/api/src/modules/packs/buyback-rate.ts',
);

function backendFlatPercent(): number {
  const src = readFileSync(BACKEND_SRC, 'utf8');
  const m = src.match(/export const FLAT_PERCENT\s*=\s*(\d+(?:\.\d+)?)/);
  if (!m) {
    throw new Error(
      `FLAT_PERCENT not found in ${BACKEND_SRC}. If it was renamed or moved, ` +
        `update this guard -- do not delete it.`,
    );
  }
  return Number(m[1]);
}

describe('buyback rate parity: storefront mirror vs backend truth', () => {
  it('storefront FLAT_BUYBACK_PERCENT matches backend FLAT_PERCENT', () => {
    expect(FLAT_BUYBACK_PERCENT).toBe(backendFlatPercent());
  });
```

Note the **throw on a failed match**, with the message "If it was renamed or
moved, update this guard -- do not delete it." Reproduce that property: a guard
that silently passes when its regex stops matching is worse than no guard.

`src/lib/__tests__/free-pack-parity.test.ts` uses the same technique against the
admin SPA. Follow either.

### Conventions to match

- Storefront: TypeScript strict, no `any`; Tailwind utility classes, no inline
  styles; 2-space indent; named exports. Vitest specs live in
  `src/**/__tests__/*.test.ts`.
- The design system is documented in `DESIGN.md` and is mobile-first. Reuse the
  surrounding form's existing classes (`INPUT_CLASS` in the modal, the `field`
  helper in the address book) rather than inventing new styling.
- Accessibility is not optional here: the modal's inputs carry `aria-label`
  because they have no visible `<label for>` association. A new control must
  carry the same.

## Commands you will need

Run from the repo root unless stated.

| Purpose            | Command                                                  | Expected on success |
| ------------------ | -------------------------------------------------------- | ------------------- |
| Typecheck          | `npm run typecheck`                                      | exit 0              |
| Lint               | `npm run lint`                                           | exit 0              |
| Format check       | `npm run format:check`                                   | exit 0              |
| Unit tests         | `npm test`                                               | all pass            |
| One spec           | `npm test -- delivery-fee`                               | that suite passes   |
| Production build   | `npm run build`                                          | exit 0              |
| Backend typecheck  | `corepack yarn check-types` (from `backend/`)            | exit 0              |
| Backend unit tests | `corepack yarn test:unit` (from `backend/packages/api/`) | all pass            |

Never pipe a test command through `tail` — it truncates the summary and a red
run reads as green.

**Do not verify UI changes with `next dev`.** It serves images slowly on this
machine and makes a correct build look broken. If you want to see the forms
render, use `npm run build` then `pwsh scripts/serve-standalone.ps1 -Port 4000`.
Visual verification is optional for this plan; the typecheck, the tests and the
build are the gate.

## Scope

**In scope** (the only files you may modify or create):

- `src/lib/actions/delivery.ts`
- `src/app/(account)/addresses/AddressesClient.tsx`
- `src/components/account/RequestDeliveryModal.tsx`
- `src/lib/__tests__/delivery-fee-parity.test.ts` (**create**)
- `src/lib/__tests__/delivery-fee.test.ts` (extend)
- `backend/packages/api/src/modules/packs/__tests__/delivery-fee.unit.spec.ts` (extend)
- `src/lib/my-states.ts` (**create** — see Step 1)

**Out of scope** (do NOT touch, even though they look related):

- `backend/packages/api/src/modules/packs/delivery.ts` — the backend zone logic
  is **correct**; it was starved of input, not wrong. Do not change the rates,
  the regex, `deliveryZone`, or `computeDeliveryFee` on either side.
- `src/lib/delivery-fee.ts` — same reason. The parity test locks it; it does not
  need editing.
- `backend/packages/api/src/api/store/delivery-orders/[id]/address/route.ts` and
  `backend/packages/api/src/workflows/steps/request-delivery.ts` — already
  thread `province` correctly.
- Any change that makes `province` required **on the backend**. Legacy rows have
  `null` and must keep working; the backend's null-tolerant behaviour is
  deliberate.
- `src/lib/address-view.ts` and `src/app/(account)/orders/OrdersClient.tsx` —
  they already read `province` through.

## Git workflow

- Branch: `advisor/126-delivery-zone-state-field`, cut from `origin/master`
  (not local `master` — squash merges make it diverge).
- Conventional commits matching `git log` style, e.g.
  `fix(delivery): bill the shipping zone on a state the customer actually picks`
- Commit per step or per logical unit.
- Do NOT push or open a PR — the reviewer does that.

## Steps

### Step 1: Add the Malaysian state list

Create `src/lib/my-states.ts` exporting a `readonly` tuple of Malaysia's 16
states and federal territories, spelled so that the three East entries match the
backend's `EAST_PLACE_RE` word-boundary alternations `sabah`, `sarawak`,
`labuan` case-insensitively:

Johor, Kedah, Kelantan, Melaka, Negeri Sembilan, Pahang, Perak, Perlis, Pulau
Pinang, Sabah, Sarawak, Selangor, Terengganu, W.P. Kuala Lumpur, W.P. Labuan,
W.P. Putrajaya.

Export the tuple and a `MalaysianState` union type derived from it. Add a short
docblock stating that these values feed `deliveryZone`'s province arm and that
the three East spellings are load-bearing — renaming "Sabah", "Sarawak" or
"W.P. Labuan" changes what customers are charged.

**Verify**: `npm run typecheck` → exit 0.

### Step 2: Require the province when the country is Malaysia

In `src/lib/actions/delivery.ts`, extend `missingRequired` so a missing
`province` is a validation failure **only when `countryCode` is `MY`**
(case-insensitive, trimmed).

Scope this to MY deliberately, and say so in a comment: `missingRequired` is
shared by `addAddress` and `updateAddress`, and an unconditional requirement
would block editing any pre-existing non-MY address until a state was invented
for it. Delivery is MY-only at the backend anyway
(`workflows/steps/request-delivery.ts` refuses other country codes).

Do not change `addressBody` — `input.province || null` is already correct.

**Verify**: `npm run typecheck` → exit 0.

### Step 3: Add the State control to the address book form

In `src/app/(account)/addresses/AddressesClient.tsx`:

1. Add `province: ''` to `EMPTY_FORM`.
2. Add a **State** control to the grid, positioned between City and Postal code
   so the visual order reads City → State → Postal code.

Render it as a `<select>` over the `MY_STATES` tuple with a disabled empty
placeholder option, not a free-text input — canonical values are the whole point
(a customer typing "Sabah, Malaysia" or "sabah " must still zone East, and a
select removes the question). Mark it `required` and give it
`autoComplete="address-level1"`.

Read the `field(...)` helper at line 235 before you start. If it only renders
`<input>`, do **not** contort it into rendering a `<select>` — write the select
as its own `<label>` block matching the helper's markup and classes, and say so
in your report.

**Verify**:

- `npm run typecheck` → exit 0
- `npm run lint` → exit 0
- `grep -n 'address-level1' "src/app/(account)/addresses/AddressesClient.tsx"` → 1 match

### Step 4: Add the same control to the delivery-request modal

In `src/components/account/RequestDeliveryModal.tsx`, add the matching State
select to the inline add-address form, in the same City → State → Postal code
position, wired to `form.province` via `setForm`. Give it
`aria-label="State"` and `autoComplete="address-level1"`, and reuse
`INPUT_CLASS` (or the nearest select-appropriate variant already in the file).

Also add `province: ''` to the `useState<AddAddressInput>` seed at line 57 if it
is not already keyed.

**Verify**:

- `npm run typecheck` → exit 0
- `grep -c 'aria-label="State"' src/components/account/RequestDeliveryModal.tsx` → 1

### Step 5: Parity-lock the fee mirror

Create `src/lib/__tests__/delivery-fee-parity.test.ts`, patterned on
`src/lib/__tests__/buyback-parity.test.ts`. It must read
`backend/packages/api/src/modules/packs/delivery.ts` as **source text** and
assert against the storefront's imported values:

1. `WEST_SHIPPING_MYR`, `EAST_SHIPPING_MYR`, `PROTECTION_INCLUDED_MYR` and
   `INSURANCE_RATE` each equal the backend's declared literal.
2. `EAST_PLACE_RE`'s source string is identical on both sides. Extract the
   backend's regex literal by regex and compare against the storefront's
   `EAST_PLACE_RE.source` — export the regex from `src/lib/delivery-fee.ts` if
   it is not already exported (that is the one edit to that file this plan
   allows; keep it to adding `export`).
3. The East postcode band (`87000`/`98999`) matches on both sides.

Every extraction **must throw** with a "if it was renamed or moved, update this
guard -- do not delete it" message when its regex fails to match. A guard that
silently passes on a rename is not a guard.

**Mutation-prove it**: temporarily change `WEST_SHIPPING_MYR` in
`src/lib/delivery-fee.ts` to `16`, run the suite, confirm **RED**, revert. Do the
same for one alternation in the storefront `EAST_PLACE_RE`. Report both results.
If either mutation stays green, the test is vacuous — fix it before proceeding.

**Verify**: `npm test -- delivery-fee-parity` → passes, then the two mutation
checks above.

### Step 6: Fix the specs that assert a shape production could not produce

The backend spec `backend/packages/api/src/modules/packs/__tests__/delivery-fee.unit.spec.ts`
proves the anti-spoof fix using province values the product never sent (around
lines 58-65). Those cases become **valid** with this plan — a customer can now
select "Sabah" — so keep them. Add two cases that pin the parts that are still
true:

1. A legacy address (`province: null`) with an East postcode still zones East —
   the postcode arm alone must keep working for rows written before this change.
2. A legacy address (`province: null`, city not in the twelve-name list) with a
   West postcode zones **west**, and add a comment naming this as the accepted
   residual: rows created before this plan carry no state, and the postcode is
   the only signal available for them.

Mirror both cases into `src/lib/__tests__/delivery-fee.test.ts` so the two
suites stay symmetric.

**Verify**:

- `corepack yarn test:unit delivery-fee` from `backend/packages/api/` → all pass
- `npm test -- delivery-fee` from the repo root → all pass

### Step 7: Full green

**Verify**, in order:

1. `npm run typecheck` → exit 0
2. `npm run lint` → exit 0
3. `npm run format:check` → exit 0 (run `npm run format` first if it fails, then re-check)
4. `npm test` → all pass
5. `npm run build` → exit 0
6. `corepack yarn check-types` from `backend/` → exit 0
7. `corepack yarn test:unit` from `backend/packages/api/` → all pass
8. `git status --porcelain` → only the in-scope files

## Test plan

| Test                           | File                                                          | Cases                                                                                                                                              |
| ------------------------------ | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fee-math parity                | `src/lib/__tests__/delivery-fee-parity.test.ts` (**new**)     | 4 constants match; `EAST_PLACE_RE.source` identical; postcode band identical; every extractor throws on a failed match. **Mutation-proved** twice. |
| Legacy null-province behaviour | `delivery-fee.unit.spec.ts` + `delivery-fee.test.ts` (extend) | null province + East postcode → east; null province + unlisted East city + West postcode → west (documented residual).                             |

Pattern to follow: `src/lib/__tests__/buyback-parity.test.ts` for the parity
test; the existing `describe` blocks in each fee spec for the new cases.

No new test is required for the form controls themselves — presentational
markup is covered by the Playwright capture/compare loop in this repo, not by
unit assertions (`.claude/rules/common/testing.md`). Do not write brittle
markup assertions.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `npm run typecheck` exits 0
- [ ] `npm run lint` exits 0
- [ ] `npm run format:check` exits 0
- [ ] `npm test` exits 0, including the new parity suite
- [ ] `npm run build` exits 0
- [ ] `corepack yarn check-types` (from `backend/`) exits 0
- [ ] `corepack yarn test:unit` (from `backend/packages/api/`) exits 0
- [ ] `grep -c 'address-level1' "src/app/(account)/addresses/AddressesClient.tsx" src/components/account/RequestDeliveryModal.tsx` → 1 in each file
- [ ] The parity test was mutation-proved RED twice (a rate change and a regex change), and your report states exactly what you changed and what failed
- [ ] `backend/packages/api/src/modules/packs/delivery.ts` and `src/lib/delivery-fee.ts` contain **no** change other than adding `export` to the storefront's `EAST_PLACE_RE` (`git diff` those two paths and show it)
- [ ] `git status --porcelain` lists only files from the In-scope list

## STOP conditions

Stop and report back — do not improvise — if:

- Any "Current state" excerpt does not match the live code.
- The `field(...)` helper cannot render a `<select>` and writing the control
  inline would mean duplicating more than ~15 lines of markup per form. Report
  it; the reviewer will decide between duplication and refactoring the helper.
- Making `province` required breaks an existing test or an existing caller of
  `addAddress`/`updateAddress` you were not told about
  (`grep -rn "addAddress\|updateAddress" src/` to enumerate before you start).
- Either mutation in Step 5 leaves the parity test green and you cannot make it
  fail. Report the vacuous assertion.
- You conclude the province arm should be removed rather than fed. That option
  was considered and explicitly rejected by the operator — the decision is to
  collect the state. Report rather than re-litigating it in code.
- The storefront and backend fee constants already **disagree** when you write
  the parity test. That would mean the drift has already happened; stop and
  report the values, do not "fix" one side to make the test pass.

## Maintenance notes

- **For the reviewer**: check (a) that the three East state spellings in
  `my-states.ts` actually match `EAST_PLACE_RE` — a "Wilayah Persekutuan Labuan"
  spelling would still match on `labuan`, but "Sabah Negeri" style suffixes
  should be verified, not assumed; (b) that `missingRequired`'s new condition is
  MY-scoped, or every legacy non-MY address becomes uneditable; (c) that the
  parity extractors throw rather than silently pass.
- Legacy addresses keep `province = null` until their owner edits them. The
  residual RM20 exposure therefore shrinks over time rather than closing at
  deploy. If the operator wants it closed immediately, that is a backfill script
  over `customer_address`, deliberately **not** in this plan's scope.
- If a future change moves the fee constants into a shared package, delete the
  parity test in the same commit — a parity guard over a single source of truth
  is dead weight, and leaving it invites confusion about which side is truth.
- Deliberately deferred: the 12-name city allowlist stays as a second signal. It
  is now redundant for new addresses but still the only signal for legacy rows.
