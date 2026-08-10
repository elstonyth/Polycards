# Plan 086: Bound unauthenticated SMS spend by destination country

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat db2767f5..HEAD -- backend/packages/api/src/api/store/phone-verification/start backend/packages/api/src/utils/phone-verification.ts src/components/PhoneField.tsx src/lib/profile-validation.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW (but see the product note in Step 1 — the default value is an
  operator decision, not an engineering one)
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `db2767f5`, 2026-08-07

## Why this matters

`POST /store/phone-verification/start` sends a real, billable SMS. It is
**unauthenticated**, and for `purpose: 'signup'` and `'phone-change'` it does
no account lookup at all — any syntactically valid E.164 number gets a
message. `E164_RE` accepts every country code, and there is no destination
allowlist anywhere in the backend.

The per-phone limiter (3 sends / 10 min, 6 / 24h per number) bounds _one_
number; a traffic-pumping run uses fresh numbers, so it bounds nothing. The
only remaining ceiling is the sitewide IP tier at 30/60s burst and 300/hour
sustained — roughly **7,200 billable sends per day** to attacker-chosen
destinations. That is the classic SMS revenue-share fraud setup, on a Twilio
account this team has already had to fund by hand.

The code comment defers to "Twilio's own Fraud Guard + geo-lock" — but that is
console state, not code, and nothing in the repo records which destinations are
actually permitted.

After this plan: the backend refuses to send to a destination the business does
not serve, the storefront picker offers only what the backend accepts, and the
permitted set is one env var an operator can widen.

## Current state

### The send route (`store/phone-verification/start/route.ts`, verbatim)

```ts
export async function POST(
  req: MedusaRequest<Body>,
  res: MedusaResponse,
): Promise<void> {
  const { phone, purpose } = req.body ?? {};
  if (typeof phone !== 'string' || !E164_RE.test(phone))
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'Invalid phone number.',
    );
  if (!isPhoneOtpPurpose(purpose))
    throw new MedusaError(MedusaError.Types.INVALID_DATA, 'Invalid purpose.');

  const logger = req.scope.resolve('logger') as { warn: (msg: string) => void };

  if (purpose === 'password-reset') {
    const customerService: ICustomerModuleService = req.scope.resolve(
      Modules.CUSTOMER,
    );
    const matches = await customerService.listCustomers(
      { phone, has_account: true } as unknown as CustomerFilters,
      { select: ['id'], take: 2 },
    );
    if (matches.length !== 1) {
      // Zero matches: don't text strangers. Two+: ambiguous, the check step
      // would refuse anyway. Same 200 either way — no oracle. Timing skew vs
      // the Twilio call exists; accepted (the email flow has the same shape:
      // core 201s unknown emails without sending).
      res.json({ ok: true });
      return;
    }
  }

  await sendPhoneOtp(process.env, logger, phone);
  res.json({ ok: true });
}
```

Note: a `logger` is already resolved here and currently only passed onward.
Plan 092 adds a warn on the `matches.length !== 1` branch; **do not do that
here** — it is that plan's step.

### The anti-oracle property you must not break

The route returns the identical `{ ok: true }` whether or not an SMS was sent.
That is deliberate (the comment says so). **Your allowlist rejection must
return the same generic success**, not a distinct error — otherwise it becomes
a "does this country work" probe and, worse, a different response shape than
the existing silent branch.

### The picker offers every country (`src/components/PhoneField.tsx:30-39`, verbatim)

```ts
// Country names from the built-in Intl API — no bundled name table.
const COUNTRIES: Country[] = (() => {
  const names = new Intl.DisplayNames(['en'], { type: 'region' });
  return getCountries()
    .map((iso) => ({
      iso,
      dial: getCountryCallingCode(iso),
      name: names.of(iso) ?? iso,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
})();
```

`getCountries()` is libphonenumber-js's **full** list. The default is
`DEFAULT_PHONE_COUNTRY = 'MY'` (`src/lib/profile-validation.ts:20`).

**This is the crux of the plan.** Restricting the backend without restricting
the picker means the UI offers a country, the user types their number, and the
code silently never arrives — the worst possible failure. The two must move
together.

### Repo conventions to match

- Env-driven configuration is read **per call**, not at module top (plan 066
  established this so a spec can drive both states through one booted app).
- `backend/packages/api/src/utils/phone-verification.ts` holds the primitives
  (`E164_RE`, `sendPhoneOtp`, the flag parsers). A destination check belongs
  beside them, not inline in the route.
- Backend source is Prettier-formatted with single quotes; storefront source is
  Prettier-formatted too (`npm run format:check` gates it in CI —
  `npm run check` does **not** run it).

## Commands you will need

| Purpose           | Command                                                                                                                   | Expected on success |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| Backend typecheck | `cd backend/packages/api && corepack yarn check-types`                                                                    | exit 0              |
| Phone tests       | `cd backend/packages/api && TEST_TYPE=unit NODE_OPTIONS=--experimental-vm-modules npx jest phone --runInBand --forceExit` | all pass            |
| Backend unit tier | `cd backend/packages/api && corepack yarn test:unit`                                                                      | all pass            |
| Backend lint | NONE. `backend/packages/api` has no eslint config and no `lint` script, so `turbo run lint` skips it and CI never lints this package. Do NOT author one — out of scope. | n/a |
| Storefront gates  | `npm run typecheck && npm test && npm run format:check` (repo root)                                                       | all exit 0          |

## Scope

**In scope**:

- `backend/packages/api/src/utils/phone-verification.ts` (add the check)
- `backend/packages/api/src/api/store/phone-verification/start/route.ts` (call it)
- `backend/packages/api/src/utils/__tests__/phone-verification.unit.spec.ts` (extend)
- `src/components/PhoneField.tsx` (narrow the picker)
- `src/lib/profile-validation.ts` (export the permitted set if that is the
  cleanest place — check what already lives there first)
- `.env.template` and `.do/backend.app.yaml` (declare the new env var; **the
  DO spec uses `__SECRET__` placeholders for secrets — this is not a secret,
  so it is a plain value. Read `scripts/do-apply.ps1` before touching the spec:
  it aborts on any unresolved placeholder anywhere in the file, including in
  comments.**)
- `plans/README.md` (status row)

**Out of scope**:

- The per-phone and sitewide OTP limiters — they are correct and complementary.
- The anti-oracle response shape.
- `E164_RE` itself — it stays permissive; the allowlist is a separate,
  business-scoped check.
- Twilio console configuration — that is plan 093 (an operator item; code
  cannot enforce it).

## Git workflow

- Branch: `advisor/086-sms-destination-allowlist`
- Conventional commits, e.g.
  `fix(phone-otp): only send verification codes to served destinations`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Fix the default set, and say so out loud

The allowlist's **default value is a product decision**, and getting it wrong
locks real users out of signup. Facts you have:

- `DEFAULT_PHONE_COUNTRY` is `'MY'`.
- `CONTEXT.md` records that Malaysia was enabled on Twilio; it records nothing
  about other destinations.
- The picker currently offers every country, so today's users may include
  numbers outside MY.

Therefore: **default the env var to `MY` only**, and in the same change
narrow the picker to the same set, so the UI never offers a destination the
backend refuses. Write both the env var's default and the picker's source from
**one** shared constant if the module boundary allows it; if it does not
(backend and storefront are separate packages), duplicate the value and add a
comment in each place naming the other, so a future widening cannot half-land.

Before implementing, run this and put the result in your completion note:

```
grep -rn "phone" backend/packages/api/src/scripts/ | head -20
```

and check whether any seed/fixture uses a non-MY number. If one does, the
allowlist must include its country or the fixture breaks.

**Verify**: you can state the chosen default set and the evidence for it.

### Step 2: Add the destination check to the primitives

In `backend/packages/api/src/utils/phone-verification.ts`, add an exported
predicate (e.g. `isAllowedSmsDestination(env, phone)`) that:

- reads `ALLOWED_SMS_COUNTRIES` from env **per call**, comma-separated ISO
  codes, defaulting to the Step-1 set;
- parses the E.164 number's country. `libphonenumber-js` is a **storefront**
  dependency — check whether the backend has it
  (`ls backend/packages/api/node_modules/libphonenumber-js` and
  `grep -n libphonenumber backend/packages/api/package.json`). If it is **not**
  present, do **not** add a dependency: match on the dialling-code prefix
  instead (`+60` for MY), and comment that a prefix match is sufficient
  because the allowlist is coarse by design. Adding a parser dependency to the
  backend for one prefix check is not worth it.
- is case-insensitive on the ISO codes and tolerates whitespace in the env
  value.

**Verify**: `corepack yarn check-types` → exit 0.

### Step 3: Wire it into the send route

Call the predicate after the E.164 and purpose validation, before
`sendPhoneOtp`. On a disallowed destination:

- **return the same `{ ok: true }`** the silent branch returns — no new error
  shape, no oracle;
- `logger.warn` the **country/prefix only**, never the number, so a pumping
  attempt is visible in logs without writing PII;
- comment that the identical response is deliberate and points at the existing
  anti-oracle comment.

**Verify**: `corepack yarn check-types` → exit 0 and
`grep -n "isAllowedSmsDestination" backend/packages/api/src/api/store/phone-verification/start/route.ts`
returns a match.

### Step 4: Narrow the picker to match

In `src/components/PhoneField.tsx`, filter `COUNTRIES` to the permitted set.
Keep the `Intl.DisplayNames` construction — only the input list changes.

If the permitted set is a single country, consider whether the picker should
still render (a one-option select is noise) — but **do not remove the
`<select>` wholesale** without checking what depends on it: it feeds the
country used to parse a local leading zero (`PhoneField.tsx:75-81`), and
`qa`/e2e specs may target it. Grep `tests/e2e/` and `src/**/__tests__/` for
the select before changing its structure.

**Verify**: `npm run typecheck && npm test && npm run format:check` → all
exit 0.

### Step 5: Declare the env var

Add `ALLOWED_SMS_COUNTRIES` to `.env.template` with a one-line comment, and to
`.do/backend.app.yaml` as a plain (non-secret) value.

**Verify**: `grep -n "ALLOWED_SMS_COUNTRIES" .env.template .do/backend.app.yaml`
returns both; and re-read `scripts/do-apply.ps1`'s placeholder scan to confirm
your addition cannot trip it.

## Test plan

Extend
`backend/packages/api/src/utils/__tests__/phone-verification.unit.spec.ts`
(read it first — it already asserts the strict `'1' → false` flag parse, so
match that style).

Cases (all required):

1. A `+60…` number with the default env → allowed.
2. A non-permitted country's number with the default env → **not** allowed.
3. `ALLOWED_SMS_COUNTRIES` widened via env → the previously-refused number is
   allowed (proves it is per-call, not module-top).
4. Env set to an empty string / whitespace → falls back to the default set,
   does **not** allow everything. This is the fail-closed case and must be
   explicit.
5. Env value with mixed case and stray spaces → parsed correctly.

Route-level: add a case asserting a disallowed destination returns `{ ok: true }`
and `sendPhoneOtp` was **not** called. Put it wherever the start route's
existing route-level coverage lives; if there is none, add it to the primitives
spec and say so.

Prove case 2 red-green by stubbing the predicate to always return true;
confirm the route test fails; restore; confirm it passes. Report both.

Verification:
`cd backend/packages/api && TEST_TYPE=unit NODE_OPTIONS=--experimental-vm-modules npx jest phone --runInBand --forceExit`
→ all pass.

## Done criteria

- [ ] `cd backend/packages/api && corepack yarn check-types` exits 0
- [ ] `cd backend/packages/api && corepack yarn test:unit` exits 0
- [ ] `npm run typecheck && npm test && npm run format:check` all exit 0
- [ ] A disallowed destination returns `{ ok: true }` and sends nothing (asserted)
- [ ] An empty/whitespace env value falls back to the default, not to "allow all" (asserted)
- [ ] `src/components/PhoneField.tsx` offers exactly the permitted set
- [ ] `grep -n "ALLOWED_SMS_COUNTRIES" .env.template .do/backend.app.yaml` returns both
- [ ] No backend dependency was added (`git diff backend/packages/api/package.json` is empty)
- [ ] The red-green proof is reported
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpts in "Current state" do not match the live code.
- A seed, fixture, or e2e spec uses a non-MY phone number that your default set
  would refuse. Report it; the default may need to widen, and that is an
  operator call.
- Narrowing the picker breaks an e2e spec that selects a country.
- You find the backend already depends on `libphonenumber-js` **and** a
  different module already parses destination countries — use that rather than
  adding a second parser, and report which.
- Restricting to MY would refuse numbers already stored on existing customer
  rows. You cannot query prod from here; if you find any non-MY number in a
  fixture or seed, treat it as a signal and report it.

## Maintenance notes

- **The backend allowlist and the storefront picker are a pair.** Widening one
  without the other either breaks signup (backend narrower) or resumes the
  toll-fraud exposure (picker narrower, backend open). Whichever file you
  touch, the comment in it names the other.
- The allowlist is **not** a substitute for Twilio's geo permissions — it is
  the half this repo can enforce. Plan 093 carries the console half.
- A reviewer should scrutinize: that the refusal is response-identical to the
  existing silent branch, that the log line carries no phone number, and that
  an empty env value fails closed rather than open.
- **Deferred**: per-country SMS cost weighting in the sitewide limiter. A
  coarse allowlist removes the expensive-destination problem entirely, which
  is why it is preferred over a spend-based budget here.
