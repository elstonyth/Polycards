# Plan 064: Validate the delivery-address phone like every other phone field

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat a993f34a..HEAD -- "src/app/(account)/addresses/AddressesClient.tsx" src/lib/actions/delivery.ts src/components/PhoneField.tsx`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: MED (legacy stored rows are unnormalized — sequencing matters)
- **Depends on**: none
- **Category**: bug (data quality on the fulfilment path)
- **Planned at**: commit `a993f34a`, 2026-08-01

## Why this matters

PR #311 required a validated E.164 phone at signup and settings precisely so
delivery orders carry a reachable number. But the address book — the actual
SOURCE of `ship_phone` on a delivery order — still accepts any string in a
plain text input, and the backend's profile-phone fallback fires only when the
address phone is BLANK (`if (!snapshot.ship_phone)`), so a garbage address
phone SUPPRESSES the validated fallback. The operator complaint #311 fixed
("delivery view shows —") can now show garbage instead. Storage also splits
into two formats: profiles canonical `+60…`, addresses free text.

## Current state

- `src/app/(account)/addresses/AddressesClient.tsx:350` —
  `{field('Phone (optional)', 'phone', { autoComplete: 'tel' })}` — a plain
  text input from the local `field()` helper.
- `src/components/PhoneField.tsx` — the country-code phone input used at
  `src/components/AuthForm.tsx:266` and
  `src/components/account/SettingsForm.tsx:81`; it submits E.164 through a
  hidden input named by its `name` prop. SettingsForm usage (the exemplar to copy):

  ```tsx
  <PhoneField
    name="phone"
    defaultValue={customer.phone ?? ''}
    inputClassName={INPUT_CLASS}
    placeholder="Phone number"
  />
  ```

- Server actions: `src/lib/actions/delivery.ts` — `addressBody` (~line 361)
  maps `phone: input.phone || null`; `missingRequired` (~line 375) does not
  include phone; `addAddress` (~line 383) and `updateAddress` (~line 418) never
  call `normalizePhone`. Both return `{ ok: false, error }` shapes.
- The pattern to mirror — `src/lib/actions/customer.ts:69-79`:

  ```ts
  let phone = clean(input.phone);
  if (typeof phone === 'string') {
    const normalized = normalizePhone(phone);
    if (!normalized) {
      return {
        ok: false,
        error: 'Please enter a valid phone number for the selected country.',
      };
    }
    phone = normalized;
  }
  ```

  (`normalizePhone` comes from the same module `customer.ts` imports it from —
  check its import line and use the same path.)

- Backend fallback (do NOT change): `backend/packages/api/src/workflows/steps/request-delivery.ts:125`
  and `backend/packages/api/src/api/store/delivery-orders/[id]/address/route.ts:68`
  use the profile phone only `if (!snapshot.ship_phone)`.
- Legacy data: existing address rows may hold unnormalized phones. A strict
  reject on `updateAddress` would make legacy rows uneditable until the phone
  is fixed — acceptable ONLY because the form will now prefill via PhoneField,
  which reformats-or-rejects visibly. Keep the error message identical to the
  settings one so the user understands what to fix.

## Commands you will need

| Purpose              | Command         | Expected on success |
| -------------------- | --------------- | ------------------- |
| Unit tests           | `npm test`      | all pass            |
| Typecheck+lint+build | `npm run check` | exit 0              |

## Scope

**In scope**:

- `src/app/(account)/addresses/AddressesClient.tsx`
- `src/lib/actions/delivery.ts` (`addressBody`, `addAddress`, `updateAddress` only)
- A test file for the delivery actions if one exists (`grep -rl "addAddress" src/lib/actions/__tests__` — extend it; if none exists, create `src/lib/actions/__tests__/delivery-address.test.ts` modeled on `auth.test.ts`'s sdk-mock harness)

**Out of scope**:

- Backend fallback logic (`request-delivery.ts`, delivery-orders address route).
- Any migration/backfill of stored address phones (normalize-on-write only).
- The delivery-order snapshot columns.
- Other fields of the address form.

## Git workflow

- Branch: `advisor/064-address-phone-e164`
- Conventional commit, e.g. `fix(delivery): validate address phone as E.164 like profile phone`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Swap the form field

In `AddressesClient.tsx`, replace the `field('Phone (optional)', 'phone', …)`
row with a `PhoneField` (name `phone`, defaultValue from the address being
edited, `inputClassName` matching the form's other inputs — read the local
`field()` helper for the class strings). Keep the "(optional)" affordance in
the label copy.

**Verify**: `npm run check` → exit 0.

### Step 2: Normalize server-side

In `delivery.ts`, mirror the `customer.ts:69-79` block inside BOTH `addAddress`
and `updateAddress` (before `addressBody` is built): empty/undefined phone
stays allowed (field is optional → `null`), non-empty must normalize or the
action returns `{ ok: false, error: 'Please enter a valid phone number for the selected country.' }`.
Feed the normalized value into `addressBody`.

**Verify**: `npm run check` → exit 0.

### Step 3: Tests

Cases: (a) add with valid MY-format local number → body carries `+60…`;
(b) add with garbage string → `{ ok: false }` with the exact error copy;
(c) add with empty phone → `phone: null`, still ok; (d) update path repeats
(b). Mock the sdk like `auth.test.ts` does.

**Verify**: `npm test` → all pass, 4 new cases.

## Test plan

Step 3. Pattern: `src/lib/actions/__tests__/auth.test.ts` (sdk mock +
action-return assertions).

## Done criteria

- [ ] `grep -n "PhoneField" "src/app/(account)/addresses/AddressesClient.tsx"` → match
- [ ] `grep -c "normalizePhone" src/lib/actions/delivery.ts` → ≥ 2 (add + update)
- [ ] `npm run check` exit 0; `npm test` all pass with 4 new cases
- [ ] No files outside the in-scope list modified
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back if:

- `PhoneField` cannot prefill from an unnormalized stored value without
  crashing (check its fallback at `PhoneField.tsx:75` first — it degrades to
  `+<dial><digits>`; if a stored value renders unusable, report before
  changing PhoneField).
- The delivery actions have no test harness AND `auth.test.ts`'s mock pattern
  doesn't transplant (report rather than inventing a new harness style).

## Maintenance notes

- Legacy rows: an edit of an old address now forces the user through phone
  re-entry if their stored value doesn't normalize. Support may see a few of
  these; the error copy tells the user what to do.
- If an SMS/courier integration lands, it can now assume E.164 for all NEW
  address rows; old rows remain mixed until edited (deliberate — no backfill).
- Reviewer scrutiny: `updateAddress` must not blank a phone the user didn't
  touch (the `|| null` mapping in `addressBody` is the existing contract for
  "cleared" — see the comment above `addressBody` about partial updates).
