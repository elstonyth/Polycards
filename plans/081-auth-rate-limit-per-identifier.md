# Plan 081: Give the credential endpoints a per-identifier rate-limit tier

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat db2767f5..HEAD -- backend/packages/api/src/api/utils/rate-limit.ts backend/packages/api/src/api/middlewares.ts`
> If either file changed since this plan was written, compare the "Current
> state" excerpts against the live code before proceeding; on a mismatch,
> treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `db2767f5`, 2026-08-07

## Why this matters

Every storefront credential request — login, signup, email password reset,
phone password reset — is issued by a **Next.js server action**, not by the
browser. `src/lib/actions/auth.ts:1` is `'use server'`, and the SDK it calls
(`src/lib/medusa.ts:16-19`) forwards no client headers. In production the
backend therefore sees exactly **one egress IP** for every visitor's sign-in.

The limiter in front of those routes keys on IP (`rate-limit.ts:285-287`,
falling back to `ip:` because a pre-auth request has no `actor_id`) and is
sized **5/10s burst, 20/60s sustained**. That is not per-user protection — it
is a single sitewide bucket of 20 credential requests per minute for the whole
storefront. Two consequences:

- **Availability**: at modest traffic, real users 429 each other's sign-ins,
  registrations and password resets. Anyone who knows this can hold the bucket
  empty by scripting the public login action, locking out the entire site.
- **Security**: there is no per-account budget at all, so the limiter cannot
  distinguish "one account is being hammered" from "the site is busy".

This is not a new lesson for the repo. `createProfileReadRateLimit`
(`rate-limit.ts:598-616`) carries 600/60s with a comment naming the exact
"one Next.js origin IP" topology, and PR #328 solved it properly for OTP by
adding a per-phone tier (`phoneBodyKeyOf`, `rate-limit.ts:398-406`) stacked in
front of the IP tier. **The credential path never got the sibling.** This plan
adds it.

After this plan: a per-identifier tier bounds attempts against one account,
the existing IP tier stays as the sitewide circuit breaker, and one user's
retries can no longer 429 everyone else.

## Current state

### The limiter's key derivation (`rate-limit.ts:284-288`, verbatim)

```ts
const auth = (req as AuthenticatedMedusaRequest).auth_context as
  | AuthenticatedMedusaRequest['auth_context']
  | undefined;
const key = keyOf?.(req) || auth?.actor_id || `ip:${req.ip ?? 'unknown'}`;
decision = await store.consume(prefix + key, rules, Date.now());
```

### The auth limiter today (`rate-limit.ts`, `createAuthRateLimit`)

Defaults come from the module-level `DEFAULTS` (`rate-limit.ts:313-318`).
**`DEFAULTS` is SHARED — verified by grep at plan time:**

```
313:const DEFAULTS = {
387:type EnvLimiterDefaults = typeof DEFAULTS;
458:  return createEnvRateLimit({ name: 'pack-open', defaults: DEFAULTS });
470:  return createEnvRateLimit({ name: 'pack-open-batch', defaults: DEFAULTS });
590:    defaults: DEFAULTS,          // ← createAuthRateLimit
```

So `pack-open`, `pack-open-batch` and `auth` all read the same object. Editing
it in place (Step 5) would silently widen the two gameplay limiters. Step 5
tells you to fork instead — **do not skip that instruction.**

The object itself:

```ts
const DEFAULTS = {
  burstLimit: 5,
  burstWindowMs: 10_000,
  limit: 20,
  windowMs: 60_000,
};
```

and the factory passes **no `keyOf`**, so it is pure IP on a pre-auth route:

```ts
export function createAuthRateLimit(): MiddlewareHandler {
  return createEnvRateLimit({
    name: 'auth',
    message: 'Too many sign-in attempts.',
    defaults: DEFAULTS,
  });
}
```

### The exemplar you are mirroring (`rate-limit.ts:398-406`, verbatim)

```ts
export const phoneBodyKeyOf = (req: MedusaRequest): string | undefined => {
  const phone = (req.body as { phone?: unknown } | undefined)?.phone;
  // Bounded: only a shape that actually passes the route's own E.164 check
  // becomes a key — an arbitrary/oversized body string would otherwise key
  // (and grow) the limiter's keyspace directly off unvalidated input.
  return typeof phone === 'string' && E164_RE.test(phone)
    ? `phone:${phone}`
    : undefined;
};
```

and its factory, `createPhoneOtpStartPhoneRateLimit` (`rate-limit.ts:768-780`),
which passes `keyOf: phoneBodyKeyOf` and its own defaults.

The module comment above those factories (`rate-limit.ts:738-755`) already
states the whole rationale — **read it before you start**; your new comment
should point at it rather than repeat it.

### The matchers today (`middlewares.ts:236-245` and `:289-292`)

```ts
    {
      matcher: '/auth/*/emailpass',
      method: 'POST',
      middlewares: [authRateLimit],
    },
    {
      matcher: '/auth/*/emailpass/*',
      method: 'POST',
      middlewares: [authRateLimit],
    },
```

```ts
    {
      matcher: '/store/phone-verification/password-reset',
      method: 'POST',
      middlewares: [authRateLimit],
    },
```

And the two-tier stacking pattern you are copying (`middlewares.ts:252-262`):

```ts
      matcher: '/store/phone-verification/start',
      method: 'POST',
      middlewares: [
        createPhoneOtpStartPhoneRateLimit(),
        createPhoneOtpStartRateLimit(),
      ],
```

Note the ordering rule stated in that matcher's comment: **the narrow tier
runs first**, so a hammered identifier 429s before spending the sitewide
budget.

### What is in the body of each matched route

You must confirm these yourself in Step 1 — the key extractor depends on it:

- `POST /auth/customer/emailpass` (login) and `/auth/customer/emailpass/register` — `{ email, password }`
- `POST /auth/customer/emailpass/reset-password` — the identifier field name is
  **not** assumed by this plan; check it.
- `POST /auth/*/emailpass/update` — carries a token and a password, **no**
  identifier. This one must fall back to IP; say so in a comment.
- `POST /store/phone-verification/password-reset` — carries only `{ token }`
  (a phone proof). No email in the body. See Step 4.

### Repo conventions to match

- Every limiter is env-tunable and documents its env var names in its JSDoc
  block. Follow that format exactly — the existing blocks are the bar.
- Each factory builds its **own** limiter instance. The module comment at
  `rate-limit.ts:751-755` explains why sharing one instance across two
  conceptually distinct budgets is a bug; do not collapse them.
- Backend source is Prettier-formatted with single quotes. If your editor
  rewrites the whole file's quotes, revert and re-apply narrowly.

## Commands you will need

| Purpose               | Command                                                                                                                        | Expected on success |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------- |
| Backend typecheck     | `cd backend/packages/api && corepack yarn check-types`                                                                         | exit 0              |
| Rate-limit unit tests | `cd backend/packages/api && TEST_TYPE=unit NODE_OPTIONS=--experimental-vm-modules npx jest rate-limit --runInBand --forceExit` | all pass            |
| Backend unit tier     | `cd backend/packages/api && corepack yarn test:unit`                                                                           | all pass            |
| Backend lint | NONE. `backend/packages/api` has no eslint config and no `lint` script, so `turbo run lint` skips it and CI never lints this package. Do NOT author one — out of scope. | n/a |

## Scope

**In scope**:

- `backend/packages/api/src/api/utils/rate-limit.ts`
- `backend/packages/api/src/api/middlewares.ts` (the three matchers quoted above only)
- `backend/packages/api/src/api/utils/__tests__/rate-limit*.unit.spec.ts` (extend the existing spec — find it with `ls backend/packages/api/src/api/utils/__tests__/`)
- `plans/README.md` (status row)

**Out of scope**:

- The OTP limiters and their matchers — they are already correct and are the
  model for this change.
- The store-read / profile-read / admin limiters — rounds 4/6/8 covered those.
- `src/lib/medusa.ts` — do **not** "fix" this by forwarding
  `x-forwarded-for` from the server action. Forwarding a client-controlled
  header into a limiter key is worse than the bucket you are fixing: it hands
  every attacker an unlimited supply of keys.
- Changing the existing IP tier's numbers. It stays as-is, as the circuit
  breaker.

## Git workflow

- Branch: `advisor/081-auth-ratelimit-per-identifier`
- Conventional commits, e.g.
  `fix(rate-limit): key the credential endpoints per identifier, not per site`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Confirm the body field names on every matched route

Read the installed provider to find the exact request-body shape for login,
register and reset: `backend/node_modules/@medusajs/auth-emailpass/dist/`
and the core auth route under
`backend/node_modules/@medusajs/medusa/dist/api/auth/`.

Record, as a comment you will paste into the new `keyOf`, which field names
you found and on which routes.

**Verify**: you can quote a file and line for each field name. If a route's
identifier field is something other than `email`, the extractor must accept
both — do not assume.

### Step 2: Add `emailBodyKeyOf` next to `phoneBodyKeyOf`

Place it immediately after `phoneBodyKeyOf` in `rate-limit.ts`. Requirements,
each of which mirrors a property of `phoneBodyKeyOf`:

- Reads the identifier field(s) confirmed in Step 1 from `req.body`.
- **Normalizes**: lowercase and trim, so `A@x.com` and `a@x.com ` share a
  bucket. (`phoneBodyKeyOf` gets this free from E.164; email does not.)
- **Bounds the keyspace**: only a value that looks like an email and is at
  most 254 characters becomes a key. Anything else returns `undefined` so the
  limiter falls back to IP. Copy the reasoning comment from `phoneBodyKeyOf`
  — an unbounded body string keying a Redis-backed limiter is a memory-growth
  vector.
- Returns `` `email:${normalized}` `` so the prefix cannot collide with
  `phone:` or `ip:` keys.

**Verify**: `cd backend/packages/api && corepack yarn check-types` → exit 0.

### Step 3: Add `createAuthIdentifierRateLimit()` and stack it

Add the factory beside `createAuthRateLimit`, passing `keyOf: emailBodyKeyOf`
and its own defaults. Suggested starting numbers, to be stated in the JSDoc as
env-tunable (`AUTH_IDENTIFIER_RATE_BURST_LIMIT` / `_BURST_WINDOW_MS` /
`AUTH_IDENTIFIER_RATE_LIMIT` / `_WINDOW_MS`):

- burst: **5 / 60s**
- sustained: **20 / 1h**

Rationale to write into the comment: a human who has forgotten their password
tries a handful of times in a minute and a couple of dozen in an hour; a
credential-stuffing run against one account does far more. These are
deliberately roomier than a legitimate user needs and far below hammering
rates — the same phrasing `createAuthRateLimit` already uses.

Then stack it **before** `authRateLimit` on the two `/auth/*/emailpass*`
matchers, matching the OTP pattern:

```ts
      middlewares: [createAuthIdentifierRateLimit(), authRateLimit],
```

Add a comment on the matchers naming the ordering rule and pointing at
`rate-limit.ts`'s phone-OTP module comment for the shared-egress-IP rationale.

**Verify**: `corepack yarn check-types` → exit 0, and
`grep -n "createAuthIdentifierRateLimit" backend/packages/api/src/api/middlewares.ts`
returns 2 matches.

### Step 4: Decide and document the `password-reset` matcher

`POST /store/phone-verification/password-reset` carries no email — only a
phone proof token. Two options; **pick the first unless Step 1 shows it is
impossible**:

1. Key it on the **phone inside the verified proof**. The route already
   verifies the proof (`password-reset/route.ts` — read it), but a middleware
   runs before the handler, so the middleware would have to verify the proof
   itself to extract the phone. If that means duplicating HMAC verification in
   a limiter, **do not do it** — fall back to option 2.
2. Leave it on `authRateLimit` (IP) and add a comment stating explicitly that
   this route's real per-identifier budget is the phone-OTP tier upstream: a
   caller cannot reach this route without having spent
   `createPhoneOtpCheckPhoneRateLimit`'s per-number budget (30/24h) to obtain
   the proof. That is a genuine per-identifier bound one hop earlier, and
   writing it down stops a future reader from "fixing" it wrongly.

**Verify**: the chosen option is implemented and a comment on the matcher
explains it in at least two sentences.

### Step 5: Raise the IP tier's sustained ceiling — by FORKING the defaults, never in place

The IP tier remains a whole-site bucket. With the narrow tier now doing the
per-account work, 20/60s sitewide is still low enough to 429 legitimate
traffic on a busy day.

**CRITICAL — do not edit `DEFAULTS`.** As shown in "Current state", it is
shared with `createPackOpenRateLimit` and `createPackOpenBatchRateLimit`;
mutating it would silently widen two gameplay limiters that have nothing to do
with this plan. Instead add a **new** exported object beside the existing
per-family ones:

```ts
export const AUTH_DEFAULTS: EnvLimiterDefaults = {
  burstLimit: 5,
  burstWindowMs: 10_000,
  limit: 300,
  windowMs: 60_000,
};
```

modelled on `STORE_READ_DEFAULTS` (`rate-limit.ts:631`) and
`PROFILE_APPEARANCE_DEFAULTS` (`:656`), which exist for exactly this reason.
Point `createAuthRateLimit` at it. Leave the burst at 5/10s; only the sustained
limit changes.

State in the comment that this tier is now explicitly a **sitewide circuit
breaker**, not per-client fairness — same wording `createProfileReadRateLimit`
uses — and that the per-identifier tier from Step 3 is what bounds one account.

**Do not** raise it without the narrow tier in place. If Steps 2–3 are
incomplete, this step alone weakens the system.

**Verify**: `grep -n "defaults: DEFAULTS" backend/packages/api/src/api/utils/rate-limit.ts`
returns **exactly two** matches (the two pack-open factories, unchanged), and
`grep -n "AUTH_DEFAULTS" backend/packages/api/src/api/utils/rate-limit.ts`
shows the new object and its single consumer.

## Test plan

Extend the existing rate-limit unit spec (find it under
`backend/packages/api/src/api/utils/__tests__/`; model the new cases on the
existing `phoneBodyKeyOf` cases — if there are none, model on whatever the
file's dominant shape is).

Cases (all required):

1. `emailBodyKeyOf` returns `email:a@x.com` for `{ email: ' A@X.com ' }`
   (normalization).
2. Returns `undefined` for a missing body, a non-string email, an email over
   254 chars, and a string that is not email-shaped (keyspace bound). Each as
   its own assertion.
3. Two requests with **different** emails from the same IP consume
   **different** buckets — i.e. the second is allowed after the first has
   exhausted its burst. This is the whole point of the change and must fail if
   Step 3 is reverted.
4. Requests with **no** email fall back to the IP bucket.

Prove the third case red-green: comment out `keyOf: emailBodyKeyOf` in the
factory, confirm the test fails, restore it, confirm it passes. Report both
outcomes in your completion note.

Verification: `cd backend/packages/api && TEST_TYPE=unit NODE_OPTIONS=--experimental-vm-modules npx jest rate-limit --runInBand --forceExit`
→ all pass, including the new cases.

## Done criteria

- [ ] `cd backend/packages/api && corepack yarn check-types` exits 0
- [ ] `cd backend/packages/api && corepack yarn test:unit` exits 0
- [ ] `grep -c "emailBodyKeyOf" backend/packages/api/src/api/utils/rate-limit.ts` ≥ 2
- [ ] `grep -c "createAuthIdentifierRateLimit" backend/packages/api/src/api/middlewares.ts` = 2
- [ ] `grep -c "defaults: DEFAULTS" backend/packages/api/src/api/utils/rate-limit.ts` = 2 — the shared object was NOT mutated; the two pack-open limiters are untouched
- [ ] The red-green proof for test case 3 is reported (both directions observed)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpts in "Current state" do not match the live code.
- Step 1 shows the login/register/reset routes use **different** identifier
  field names that cannot be covered by one extractor without accepting
  arbitrary body keys. Report the field names; do not widen the extractor to
  "any string field".
- Implementing option 1 in Step 4 would require re-verifying the phone proof
  inside a middleware. Take option 2 and say so.
- Any existing test asserts the current 20/60s auth ceiling. Report it — the
  number may be load-bearing for a spec you should not silently change.

## Maintenance notes

- **The ordering is load-bearing.** Narrow tier first, sitewide second. If a
  future matcher stacks them the other way, a hammered account will drain the
  sitewide bucket before its own — which is the bug this plan fixes.
- **Never forward `x-forwarded-for` from the storefront to make the IP tier
  "work".** It is client-settable, and using it as a limiter key gives an
  attacker unlimited buckets. If someone proposes it, point them here and at
  `deposit/route.ts:45-52`, which rejects the same idea for the same reason.
- A reviewer should scrutinize: keyspace bounding on the email extractor
  (unbounded keys are a Redis-growth vector), and that the burst window on the
  new tier is not so tight that a user fixing a typo trips it.
- **Deferred out of this plan**: applying the same treatment to the admin
  login path. Admin traffic does not route through the storefront, so it has a
  genuine per-client IP; it is not affected by this topology.
