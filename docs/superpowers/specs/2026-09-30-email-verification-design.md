# Email verification before cash-out — design

Status: approved in chat 2026-09-30 (operator). Implementation plan to follow.

## Why

Email+password signup never proves the address. Two consequences surfaced in
the 2026-09-30 launch audit:

- **Account pre-hijack.** Anyone could register someone else's email with a
  password of their own; when the real owner later signed in with Google,
  `store/customers/link-google` linked into that account. Closed separately by
  removing the password login on link (#639) — but an email+password account
  that is never linked still carries an address nobody proved.
- **Security notices go to an unproven inbox.** "Bank account added" and
  "phone number changed" emails are the owner's only warning before money
  leaves; on an unverified account they may reach a stranger or nobody.

Operator decisions (2026-09-30):

1. The gate covers **cash-out only**: withdrawals and card delivery. Sign-in,
   top-up and play work immediately, so signup and first deposit keep their
   current friction.
2. **Existing** email+password accounts verify too, at their next cash-out.
   Grandfathering would exempt exactly the accounts whose email was never
   proven.

## Approach

An emailed link carrying a stateless HMAC token, a persisted
`email_verified_at` stamp, and a route middleware on the two cash-out routes.
It mirrors the phone-verification architecture (`utils/phone-verification.ts`,
`api/utils/phone-verification-guard.ts`) on purpose: same token shape, same
first-write-wins stamp, same fail-open environment lever, same exemption rules.

Rejected: a 6-digit emailed code (needs Twilio Verify's email channel or a code
store, and is worse across devices), and a magic link that also signs in (a
session-minting surface this feature does not need).

## Components

### 1. Data

`customer_account_state.email_verified_at timestamptz NULL` — model field,
migration, ORM snapshot entry. Service methods on PacksModuleService:

- `markEmailVerified(customerId)` — idempotent, first-write-wins (same shape
  as `markPhoneVerified`; creates the state row if missing).
- `isEmailVerified(customerId)` — true when the stamp is set.

### 2. Who passes the gate — `passesEmailGate(scope, customerId)`

In `api/utils/email-verification-guard.ts`. True when ANY holds:

1. `EMAIL_VERIFICATION_REQUIRED` is not exactly `'true'` (unset = off: the
   fail-open lever, same parse as `PHONE_VERIFICATION_REQUIRED`).
2. `email_verified_at` is set.
3. The account has **no** linked email+password login
   (`linkedEmailpassLogin(scope, customerId) === null`): a Google-only account,
   whose email Google verified. After #639 every Google-linked account is in
   this group too.
4. The customer's effective player group has `verification_exempt` (partner
   groups, spec 2026-09-09) — the same exemption the phone gate honours.

Read failures throw; the middleware fails closed (as `requirePhoneVerified`).

### 3. Token — `signEmailProof` / `verifyEmailProof`

In `utils/email-verification.ts`. `base64url(JSON{ c: customerId, e: email,
exp }) + '.' + HMAC-SHA256(jwtSecret, 'email-proof.v1.' + payload)`.

- 24-hour TTL.
- Domain string `email-proof.v1` separates it from the phone proofs and the
  app's JWTs, which share `jwtSecret`.
- Empty secret refused (same `assertSecret` rule as phone proofs).
- The email is lower-cased and embedded: changing the account's email voids
  every older link.
- Stateless: a replay inside the TTL only re-stamps a fact already true.

### 4. Routes

- **`POST /store/email-verification/start`** — authenticated customer
  (bearer). If the account already passes (verified, Google-only, exempt) it
  answers `{ ok: true, verified: true }` and sends nothing. Otherwise it mints a
  token for the customer's current email and sends the `email-verify` email
  with `${STOREFRONT_URL}/verify-email?token=…`; answers `{ ok: true,
  verified: false }`. Refuses to email a localhost link when `STOREFRONT_URL`
  is unset (as `subscribers/password-reset.ts`). Rate-limited per customer
  (`email-verify-start`: 3 per 10 min, 10 per day).
- **`POST /store/email-verification/confirm`** — public (the link must work on
  any device, signed in or not). Body `{ token }`. Verifies the HMAC and
  expiry, loads the customer, requires `customer.email` (lower-cased) to equal
  the token's email and `has_account`, then `markEmailVerified`. Answers
  `{ ok: true }`; any invalid, expired, mismatched or unknown token answers 400
  "This verification link is invalid or has expired." (one message, no oracle).
  Rate-limited per IP (`email-verify-confirm`).

### 5. The gate — `requireEmailVerified`

Middleware placed AFTER `requirePhoneVerified` on exactly two routes:

- `POST /store/credits/withdraw`
- `POST /store/delivery-orders`

Refusal: `NOT_ALLOWED` (HTTP 400, like the phone gate), "Verify your email
address before continuing." Not on top-up/deposit (decision 1), not on reads
or cancels.

### 6. Email — `email-verify` template

In `modules/resend/templates.ts`: subject "Verify your email for Polycards",
CTA button plus the plain link, "This link expires in 24 hours", and "If you
didn't create a Polycards account, ignore this email." Renders nothing (fails
closed) without a `url`.

### 7. Storefront

- **After email signup** (`actions/auth.ts#signup` success): call start,
  fire-and-forget — a failure must never fail the signup.
- **`/verify-email` page** (`src/app/verify-email/`): server page reads
  `token`, a client component posts it to confirm via a server action, then
  shows "Email verified — you can now withdraw and request delivery" or the
  invalid/expired state with a "Send a new link" button (signed-in only) and a
  sign-in link otherwise.
- **Settings** (`SettingsForm`): the email row shows "Verified" or "Not
  verified · Resend link" (the button calls start). Verification status comes
  from `GET /store/customers/me/account` (new `emailVerified` boolean, computed
  with the same predicate as the gate).
- **Error copy**: withdrawal and delivery error rules map `/verify your
  email/i` to "Verify your email address first — we sent you a link. Resend it
  from Account settings."

### 8. Rollout

- Code ships with the lever OFF (unset). The PR adds
  `EMAIL_VERIFICATION_REQUIRED="true"` to `.do/backend.app.yaml`; the operator
  runs `pwsh scripts/do-apply.ps1 backend` after merge to switch it on.
- Existing email+password accounts are asked to verify at their next
  withdrawal or delivery request (decision 2). No bulk email in this change.

## Error handling

- Resend not configured: start answers `NOT_ALLOWED` (400) "Email is not
  available right now." rather than pretending it sent.
- Notification send failure: logged with the customer id only (never the
  address); start answers the same retryable error.
- Gate read failure: fail closed (the request errors; the customer retries).

## Testing

- Unit: token sign/verify (TTL, tamper, wrong domain, email change), gate
  predicate (each of the four pass conditions and the refusal), start (already
  verified → no send; sends with the storefront URL; refuses without
  `STOREFRONT_URL`), confirm (valid → stamp; invalid/expired/mismatch → the one
  400), template rendering.
- HTTP integration on real Postgres: email signup → withdraw refused with the
  email message → start → confirm with the minted token → the withdrawal passes
  the email gate; a Google-only account passes without verifying; lever off →
  no gate.
- Storefront vitest: `/verify-email` action outcomes, the new error-rule
  mappings, signup still succeeds when start fails.

## Out of scope

- Verifying at login, or blocking top-up.
- A bulk "please verify" email to existing accounts.
- Email change flow changes (a changed email simply needs a new link).
