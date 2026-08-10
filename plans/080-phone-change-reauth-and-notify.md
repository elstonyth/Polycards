# Plan 080: Require re-authentication to change a verified phone, and notify the account when it changes

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat db2767f5..HEAD -- backend/packages/api/src/api/store/phone-verification backend/packages/api/src/subscribers backend/packages/api/src/api/middlewares.ts src/lib/actions/phone-verification.ts src/components`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `db2767f5`, 2026-08-07

## Why this matters

`POST /store/phone-verification/change` moves the account's recovery phone
using nothing but a customer bearer token plus an OTP proof **for the new
number**. It asks for no current password and sends no OTP to the _old_
number. Because `POST /store/phone-verification/password-reset` resolves the
target account from whatever phone is on the row _now_, and mints a real
`emailpass` reset token, anyone holding a live customer session can convert it
into permanent account takeover in three calls:

1. `change` the phone to a number they control (no password needed),
2. OTP that number and call `password-reset` → receive a reset token,
3. set a new password → the real owner is locked out, and locked out of phone
   recovery too, because the phone is no longer theirs.

The same single `change` call also runs `markPhoneVerified`, which satisfies
`requirePhoneVerified` and therefore **unlocks `POST /store/credits/withdraw`**
(`middlewares.ts:604-615`) on an account that never verified anything. And the
whole sequence is silent: no email, no feed notification, no event.

After this plan: changing a verified phone requires proving the existing
identity (current password, or an OTP to the old number for Google-only
accounts), and the account is told about it either way.

## Current state

Files and their roles:

- `backend/packages/api/src/api/store/phone-verification/change/route.ts` —
  the authed phone-change route. The whole handler is 78 lines; the relevant
  half is below.
- `backend/packages/api/src/api/store/phone-verification/password-reset/route.ts`
  — exchanges a `password-reset` phone proof for an emailpass reset token.
  **Out of scope to change**; it is here so you understand what `change`
  feeds.
- `backend/packages/api/src/api/middlewares.ts` — matcher wiring. The `change`
  matcher is at lines 274-286.
- `backend/packages/api/src/subscribers/customer-phone-verified.ts` — the
  existing phone-related subscriber; use as the structural pattern for the new
  notification subscriber.
- `src/lib/actions/phone-verification.ts` — storefront server actions that
  call these routes.

### `change/route.ts` today (lines 23-100, verbatim)

```ts
export async function POST(
  req: AuthenticatedMedusaRequest<Body>,
  res: MedusaResponse,
): Promise<void> {
  // Register-token bearers carry actor_id '' until POST /store/customers
  // links the identity (same guard as store/vip/route.ts) — without this,
  // updateCustomers('', …) below reaches core with an empty id and 500s
  // instead of cleanly rejecting the caller.
  const customerId = req.auth_context.actor_id;
  if (!customerId) {
    throw new MedusaError(MedusaError.Types.UNAUTHORIZED, 'Unauthorized');
  }

  const { phone, token } = req.body ?? {};
  if (typeof phone !== 'string' || !E164_RE.test(phone))
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'Invalid phone number.',
    );

  const { jwtSecret } = req.scope.resolve('configModule').projectConfig.http;
  if (typeof jwtSecret !== 'string' || !jwtSecret)
    throw new MedusaError(
      MedusaError.Types.UNEXPECTED_STATE,
      'Server misconfigured.',
    );

  const proof =
    typeof token === 'string'
      ? verifyPhoneProof(jwtSecret, token, 'phone-change')
      : null;
  if (!proof || proof.phone !== phone)
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'Phone verification required.',
    );

  const customerService: ICustomerModuleService = req.scope.resolve(
    Modules.CUSTOMER,
  );

  // ... (duplicate-phone check at :82-90, elided) ...

  await customerService.updateCustomers(customerId, { phone });
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  await packs.markPhoneVerified(customerId);
  res.json({ customer: { id: customerId, phone } });
}
```

Note what is **absent**: any use of `password`, any read of the customer's
existing `phone`, any OTP against the old number, any event emit.

### The matcher today (`middlewares.ts:274-286`)

```ts
    {
      // Verified phone change (Task 4) — unlike start/check above, this one is
      // AUTHED: it consumes a 'phone-change'-purpose proof from the OTP flow
      // and is the only way to set a new phone once PHONE_VERIFICATION_REQUIRED
      // is on (blockUnverifiedPhoneWrite closes the direct /me write). Shares
      // the write-tier budget with the rest of the authed mutation matchers.
      matcher: '/store/phone-verification/change',
      method: 'POST',
      middlewares: [
        authenticate('customer', ['bearer']),
        deliveryWriteRateLimit,
      ],
    },
```

### How to verify a password server-side (the repo's own idiom)

`backend/packages/api/src/scripts/reset-customer-password.ts:29,51` resolves
the auth module and calls `register`:

```ts
const authService: any = container.resolve(Modules.AUTH);
const { authIdentity, error } = await authService.register('emailpass', {
  body: { email, password },
});
```

`authenticate` is the mirror of `register` on the same service. A typed
resolve idiom already exists in `backend/packages/api/src/api/utils/disabled-guard.ts:43`:

```ts
const auth = req.scope.resolve<IAuthModuleService>(Modules.AUTH);
```

**You must confirm the exact success/failure shape of
`authenticate('emailpass', …)` before relying on it** — see Step 1.

### Repo conventions to match

- Routes throw `MedusaError` with a `MedusaError.Types.*` type; the framework
  maps them to status codes. Never `res.status(4xx)` by hand in a `/store`
  route (the `/hooks` routes differ — they answer a gateway).
- Comments explain **why**, at length, including rejected alternatives. Match
  that density; this file's existing comments are the bar.
- Subscribers never throw: see the header comment of
  `customer-phone-verified.ts` ("Never throws: a missed stamp is fail-SAFE …").
  Follow that posture for the new notification subscriber.
- Backend source is Prettier-formatted with **single quotes**. If your editor
  or a hook rewrites the whole file's quotes, revert and re-apply the edit
  narrowly — whole-file churn will be rejected in review.

### Design constraint from the intent docs

`CONTEXT.md` records the phone-verification cutover and the deliberate
fail-open rollback lever (`PHONE_VERIFICATION_REQUIRED`). **This plan must not
change that lever's semantics.** The new re-auth requirement applies whenever
the `change` route runs, regardless of the flag — the flag governs whether
phone verification is _required_, not whether identity proof is required to
move a phone.

## Commands you will need

| Purpose                        | Command                                                                                                                   | Expected on success |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| Backend typecheck              | `cd backend/packages/api && corepack yarn check-types`                                                                    | exit 0, no errors   |
| Backend unit tests (filtered)  | `cd backend/packages/api && TEST_TYPE=unit NODE_OPTIONS=--experimental-vm-modules npx jest phone --runInBand --forceExit` | all pass            |
| Backend unit tests (full tier) | `cd backend/packages/api && corepack yarn test:unit`                                                                      | all pass            |
| Backend lint | NONE. `backend/packages/api` has no eslint config and no `lint` script, so `turbo run lint` skips it and CI never lints this package. Do NOT author one — out of scope. | n/a |
| Storefront typecheck           | `npm run typecheck` (repo root)                                                                                           | exit 0              |
| Storefront tests               | `npm test` (repo root)                                                                                                    | all pass            |
| Storefront format check        | `npm run format:check` (repo root)                                                                                        | exit 0              |

Note: `cd backend && corepack yarn lint` is known to fail on this machine with
"turbo/eslint not recognized" — call the eslint binary directly as above.

## Scope

**In scope** (the only files you should modify or create):

- `backend/packages/api/src/api/store/phone-verification/change/route.ts`
- `backend/packages/api/src/api/store/phone-verification/change/__tests__/route.unit.spec.ts` (create)
- `backend/packages/api/src/subscribers/customer-phone-changed.ts` (create)
- `src/lib/actions/phone-verification.ts` (pass the new field through)
- `src/components/` — only the component that calls the phone-change action;
  find it with `grep -rn "changePhone\|phone-verification/change" src/`
- `plans/README.md` (status row)

**Out of scope** (do NOT touch, even though they look related):

- `backend/packages/api/src/api/store/phone-verification/password-reset/route.ts`
  — it is correct as written (it binds the target to the proof's phone and
  refuses multi-matches). Fixing `change` closes the chain; changing
  `password-reset` would break phone recovery.
- `backend/packages/api/src/utils/phone-verification.ts` — the proof primitive
  is sound (domain-separated HMAC, purpose-bound, TTL, `timingSafeEqual`).
- `backend/packages/api/src/api/middlewares.ts` **except** if Step 4 requires
  it; the existing matcher already authenticates and rate-limits.
- Anything under `backend/packages/api/src/api/hooks/` — other plans own those.
- The `PHONE_VERIFICATION_REQUIRED` / `PHONE_GATE_REQUIRED` parsing.

## Git workflow

- Branch: `advisor/080-phone-change-reauth`
- Conventional commits, matching `git log --oneline -5`, e.g.
  `fix(phone-otp): require identity re-proof to change a verified phone`
- Commit per step or per logical unit.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Establish the auth-module contract before writing the guard

Do **not** guess the return shape. Write a scratch script or a focused unit
test that resolves `Modules.AUTH` and calls
`authenticate('emailpass', { body: { email, password } })` against a known
customer, and record what it returns for (a) the correct password and (b) a
wrong one. `@medusajs/auth-emailpass` is at
`backend/node_modules/@medusajs/auth-emailpass/dist/` — read its
`authenticate` implementation directly; that is faster and more reliable than
running it.

Write down, in a comment in the route you are about to edit, the exact shape
you found (e.g. `{ success: boolean; authIdentity?; error? }`) and whether a
wrong password **returns** a failure or **throws**.

**Verify**: you can quote the specific file and line in
`backend/node_modules/@medusajs/auth-emailpass/dist/` that produces the
failure result. If you cannot, that is a STOP condition.

### Step 2: Add the re-auth gate to `change/route.ts`

Insert the gate **after** the existing proof check (so an attacker without a
valid proof still learns nothing about passwords) and **before**
`updateCustomers`.

Target shape:

1. Read the customer's current row: `customerService.retrieveCustomer(customerId, { select: ['id', 'email', 'phone'] })`.
2. Resolve whether the account has an `emailpass` identity, using the same
   `listAuthIdentities` filter shape as
   `reset-customer-password.ts:43-46`:
   `{ provider_identities: { entity_id: <email>, provider: 'emailpass' } }`.
3. **If an emailpass identity exists**: require `password` (string, non-empty)
   in the request body and verify it via the Step-1 contract. On failure throw
   `MedusaError.Types.UNAUTHORIZED` with the message
   `'Enter your current password to change your phone number.'`
4. **If no emailpass identity exists** (Google-only account) **and the customer
   already has a phone**: require a second proof token, purpose
   `'phone-change'`, whose `proof.phone` equals the customer's **current**
   phone. Name the body field `old_phone_token`. On failure throw
   `MedusaError.Types.UNAUTHORIZED` with
   `'Verify your current phone number to change it.'`
5. **If no emailpass identity exists and the customer has no phone yet**: this
   is first-time verification on a Google account — allow it with only the new
   number's proof, exactly as today. Comment this branch explicitly; it is the
   one path that keeps working unchanged.

Write the "why" comment above the gate: state the takeover chain in two
sentences and name `password-reset/route.ts` as the downstream consumer that
makes it exploitable.

**Verify**: `cd backend/packages/api && corepack yarn check-types` → exit 0.

### Step 3: Emit a `customer.phone_changed` event and write the subscriber

In the route, after `markPhoneVerified(customerId)` succeeds, emit the event
through the event bus. Find the repo's emit idiom by reading how another
custom route emits (`grep -rn "eventBus\|Modules.EVENT_BUS\|emit(" backend/packages/api/src --include=*.ts | grep -v __tests__`).
Payload: `{ id: customerId, old_phone_masked, new_phone_masked }` — masked
means last 4 digits only, never the full number.

Create `backend/packages/api/src/subscribers/customer-phone-changed.ts`
modelled structurally on `customer-phone-verified.ts`:

- never throws (log and return on any failure);
- sends to the account **email**, not to either phone — the email is the
  channel the attacker has not taken over yet;
- also writes a feed notification via `notifyFeed`, matching how
  `subscribers/password-reset.ts` pairs its email with feed state (read that
  file first and follow it).

The emit must be **after** the phone write commits and must be best-effort:
a notification failure must not roll back or 500 the change.

**Verify**: `cd backend/packages/api && corepack yarn check-types` → exit 0,
and `ls backend/packages/api/src/subscribers/customer-phone-changed.ts`
succeeds.

### Step 4: Thread the new field through the storefront

`src/lib/actions/phone-verification.ts` currently forwards `{ phone, token }`
to the change route. Add the optional `password` / `old_phone_token` fields,
and surface the backend's 401 message in the UI the same way the file's
sibling actions surface errors (read the file's existing error handling and
match it — do not invent a new error shape).

Find the calling component with
`grep -rn "phone-verification/change\|changePhone" src/` and add the password
input to that form. Match the existing form's markup conventions; do not
restyle anything.

**Verify**: `npm run typecheck` → exit 0; `npm test` → all pass;
`npm run format:check` → exit 0.

### Step 5: Tests

See "Test plan" below, then run the full gates.

**Verify**: `cd backend/packages/api && corepack yarn test:unit` → all pass;
`npm test` → all pass.

## Test plan

New backend spec:
`backend/packages/api/src/api/store/phone-verification/change/__tests__/route.unit.spec.ts`.
Use `backend/packages/api/src/api/store/credits/deposit/__tests__/route.unit.spec.ts`
as the structural pattern — it mocks the module it calls with `jest.mock`,
builds a fake `req` via a `mkReq` helper, and restores `process.env` in
`afterEach`.

Cases (all required):

1. Emailpass account, correct password → phone is updated (assert
   `updateCustomers` called with the new phone) and the event is emitted.
2. Emailpass account, **wrong** password → throws `UNAUTHORIZED`, and
   `updateCustomers` is **not** called. This is the anti-regression case; it
   must fail if Step 2 is reverted.
3. Emailpass account, **no** password in the body → throws `UNAUTHORIZED`,
   `updateCustomers` not called.
4. Google-only account with an existing phone, no `old_phone_token` → throws
   `UNAUTHORIZED`.
5. Google-only account with an existing phone and a **valid** `old_phone_token`
   for the current number → succeeds.
6. Google-only account with **no** phone yet → succeeds with only the new
   number's proof (the first-time path must keep working).
7. A notification/emit failure does **not** fail the request (mock the emit to
   reject; assert `res.json` still ran).

Storefront: add a case to whichever existing test file covers the phone
actions (`grep -rln "phone" src/lib/actions/__tests__/`) asserting the new
field is forwarded in the request body.

Verification: `cd backend/packages/api && TEST_TYPE=unit NODE_OPTIONS=--experimental-vm-modules npx jest phone --runInBand --forceExit`
→ all pass, including the 7 new cases.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `cd backend/packages/api && corepack yarn check-types` exits 0
- [ ] `cd backend/packages/api && corepack yarn test:unit` exits 0, and the 7 new cases appear in the output
- [ ] `npm run typecheck && npm test && npm run format:check` all exit 0 at the repo root
- [ ] `grep -n "authenticate('emailpass'" backend/packages/api/src/api/store/phone-verification/change/route.ts` returns at least one match
- [ ] `ls backend/packages/api/src/subscribers/customer-phone-changed.ts` succeeds
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The `change/route.ts` code does not match the "Current state" excerpt above.
- You cannot establish the `authenticate('emailpass', …)` contract from the
  installed provider's source in Step 1. **Do not guess it** — a wrong
  assumption here produces a gate that always passes, which is worse than no
  gate.
- The event-bus emit idiom you find in the repo differs materially from what
  Step 3 assumes.
- Requiring the password turns out to break an existing e2e spec that changes
  a phone (`grep -rn "phone" tests/e2e/`) — report which spec and stop; the
  fixture needs an operator decision.
- You discover a second route that can write `customer.phone` without this
  gate. (`blockUnverifiedPhoneWrite` is supposed to close `/store/customers/me`
  — verify it, and if there is a third path, report it.)

## Maintenance notes

- **The gate and the reset route are a pair.** If anyone ever makes
  `password-reset` resolve accounts by something other than the current phone,
  re-read this plan's threat model; and if `change` ever gains a second
  caller, the gate must move into a shared helper rather than being copied.
- A reviewer should scrutinize: that the re-auth runs **after** the proof
  check (no password oracle for an attacker without a proof), that the
  Google-only-with-no-phone branch is still reachable, and that the subscriber
  cannot throw.
- **Deliberately deferred out of this plan**: rate-limiting the password
  attempts on this route specifically. It shares `deliveryWriteRateLimit`
  today; plan 081 reworks the credential-path limiters and is the right place
  to decide whether this route needs its own tier.
- **Deliberately not done**: revoking existing sessions on a phone change.
  That is a bigger behavioral change (it logs the legitimate user out of other
  devices) and needs an operator decision.
