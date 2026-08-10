# Plan 090: Log the resolved phone-gate state at boot, and correct the comment that misdescribes the rate limiter

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat db2767f5..HEAD -- backend/packages/api/src/utils/phone-verification.ts src/lib/actions/phone-verification.ts backend/packages/api/src/loaders`
> On any mismatch with the "Current state" excerpts, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `db2767f5`, 2026-08-07

## Why this matters

Two small things, both about a reader being told the truth.

**1. The phone gate fails open, invisibly.** `PHONE_VERIFICATION_REQUIRED` is
parsed as a strict `=== 'true'`, so unset, empty, `'True'`, `'1'`, `'yes'`, or
a misspelled key all resolve to **false** — every gate open. And
`PHONE_GATE_REQUIRED` deliberately _follows_ it when unset, so one wrong value
opens the money gates as well as the write gates.

The fail-open default itself is a **recorded decision** (`CONTEXT.md` keeps it
as the documented rollback lever) and this plan does not change it. The problem
is that nothing anywhere logs or asserts the _resolved_ state. The 2026-08-07
Twilio outage proved this lever gets flipped under time pressure — commits
`3e36a623` (off) and `db2767f5` (back on) — and it lives in two `.do` specs
plus a `Dockerfile` build ARG. A future typo, a partially-applied spec, or a
rebuild that misses the ARG silently disarms signup proof, the `/me` phone-write
block, the `customer.created` verification stamp **and** every money gate, with
no log line and no failing test to notice.

**2. A comment in the storefront asserts the opposite of the truth about a
security control.** `src/lib/actions/phone-verification.ts:3-8` claims running
server-side "lets the backend's IP rate limiter see the real client via
x-forwarded-for". It does not: `src/lib/medusa.ts:16-19` constructs the SDK
with a base URL and a publishable key and forwards no headers. The
authoritative comment in `rate-limit.ts:738-755` says the opposite, and the
entire per-phone limiter tier exists _because_ of it. A maintainer trusting the
storefront comment could reasonably delete the per-phone limiters as
"redundant with the IP tier" — removing the only budget that actually bounds
SMS spend and OTP guessing.

## Current state

### The flag parsers (`backend/packages/api/src/utils/phone-verification.ts:29-55`, verbatim)

```ts
export const isPhoneVerificationRequired = (
  env: PhoneVerificationEnv,
): boolean => env.PHONE_VERIFICATION_REQUIRED === 'true';

/**
 * The MONEY/GOODS gate (requirePhoneVerified) — separate from the signup and
 * phone-change gates above, because they are different risks with different
 * blast radii and must be rollback-able independently.
 * ...
 * Unset (or empty) means "follow PHONE_VERIFICATION_REQUIRED", so the deploy
 * needs no new configuration to behave as intended — the extra variable exists
 * to be set to 'false' in a hurry.
 */
export const isPhoneGateRequired = (env: PhoneVerificationEnv): boolean => {
  const own = env.PHONE_GATE_REQUIRED;
  if (own === undefined || own === '') return isPhoneVerificationRequired(env);
  return own === 'true';
};

export const isTwilioVerifyConfigured = (env: PhoneVerificationEnv): boolean =>
  Boolean(
    env.TWILIO_ACCOUNT_SID &&
    env.TWILIO_AUTH_TOKEN &&
    env.TWILIO_VERIFY_SERVICE_SID,
  );
```

The strictness is deliberate and already asserted —
`backend/packages/api/src/utils/__tests__/phone-verification.unit.spec.ts:18-19`
pins `'1' → false`. **Do not loosen the parse.**

### The false comment (`src/lib/actions/phone-verification.ts:3-8`, verbatim)

```ts
/**
 * Phone-OTP server actions. Thin proxies onto the backend's
 * /store/phone-verification/* routes — running server-side keeps the
 * publishable-key transport consistent with every other action and lets the
 * backend's IP rate limiter see the real client via x-forwarded-for.
 */
```

### The authoritative version (`backend/packages/api/src/api/utils/rate-limit.ts:738-755`)

Read it in full. Key sentence: the storefront proxies every OTP request
through the Next.js server, "so in production the backend sees exactly ONE
egress IP for every visitor".

The same false sentence is duplicated in
`docs/superpowers/plans/2026-08-02-phone-verification.md` (find the line with
`grep -n "x-forwarded-for" docs/superpowers/plans/2026-08-02-phone-verification.md`).

### Where a boot log goes

Find the API's loader directory (`ls backend/packages/api/src/loaders/` — if it
does not exist, look at how `medusa-config.ts` wires startup work, and at
`assertMockTopupSafe`, which is called from `medusa-config.ts:13` and is the
repo's existing example of a boot-time assertion).

### Repo conventions to match

- Boot-time checks that must fail the process **throw** (see
  `assertMockTopupSafe`). This plan's check must **not** throw — it is
  observability, and a fail-open gate is a legitimate deployed state.
- Log lines use a bracketed prefix.
- Backend: Prettier, single quotes. Storefront: `npm run format:check` gates CI.

## Commands you will need

| Purpose           | Command                                                                                                                   | Expected on success |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| Backend typecheck | `cd backend/packages/api && corepack yarn check-types`                                                                    | exit 0              |
| Phone tests       | `cd backend/packages/api && TEST_TYPE=unit NODE_OPTIONS=--experimental-vm-modules npx jest phone --runInBand --forceExit` | all pass            |
| Backend unit tier | `cd backend/packages/api && corepack yarn test:unit`                                                                      | all pass            |
| Backend lint | NONE. `backend/packages/api` has no eslint config and no `lint` script, so `turbo run lint` skips it and CI never lints this package. Do NOT author one — out of scope. | n/a |
| Storefront gates  | `npm run typecheck && npm test && npm run format:check`                                                                   | all exit 0          |

## Scope

**In scope**:

- `backend/packages/api/src/utils/phone-verification.ts` (add the reporter; do
  not change the parsers' semantics)
- Wherever boot-time work is wired (a loader, or `medusa-config.ts`)
- `backend/packages/api/src/utils/__tests__/phone-verification.unit.spec.ts` (extend)
- `src/lib/actions/phone-verification.ts` (the comment only)
- `docs/superpowers/plans/2026-08-02-phone-verification.md` (the duplicated
  sentence — correct it or mark the doc superseded; do not rewrite the doc)
- `plans/README.md` (status row)

**Out of scope**:

- Changing the fail-open default, or making the parse lenient. Both are
  recorded decisions with a live rollback purpose.
- The limiters themselves (plans 081, 086).
- `.do/*.app.yaml` and the `Dockerfile` ARG — they currently read `true`;
  do not touch them.

## Git workflow

- Branch: `advisor/090-phone-gate-boot-evidence`
- Conventional commits, e.g.
  `chore(phone-otp): log the resolved gate state at boot; correct a false comment`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add a resolved-state reporter

Add an exported function to `phone-verification.ts` that returns the resolved
triple — `{ phoneVerificationRequired, phoneGateRequired, twilioConfigured }` —
computed from the existing parsers, plus a **warning list**: for each of
`PHONE_VERIFICATION_REQUIRED` and `PHONE_GATE_REQUIRED`, if the raw value is a
non-empty string that is neither `'true'` nor `'false'`, record that it will be
read as `false`.

Keep it pure (env in, object out) so it is trivially testable. No logging
inside it.

**Verify**: `corepack yarn check-types` → exit 0.

### Step 2: Call it at boot

Wire a call at startup that logs at INFO, e.g.:

```
[phone-gate] write=true money=true twilio=configured
```

and logs each warning at WARN level, naming the variable and the value it was
read as — **never** printing the raw value if it could be secret-shaped (these
two are booleans, so printing them is fine; `twilioConfigured` must be a
boolean, never the credentials).

It must not throw. A fail-open state is a legitimate deployed configuration;
the point is that it is now visible in the deploy log.

**Verify**: `corepack yarn check-types` → exit 0. If you can boot the backend
locally, capture the log line and paste it into your completion note. If you
cannot (no database), say so rather than claiming it was observed.

### Step 3: Correct the storefront comment

Replace the false sentence with the true reason the actions run server-side:
publishable-key transport consistency with every other action, and keeping the
proof token out of the browser. Add a pointer to
`backend/packages/api/src/api/utils/rate-limit.ts`'s phone-OTP module comment
for the actual limiter topology, and one sentence stating plainly that the
backend sees the storefront's egress IP, not the visitor's — so the per-phone
tier is the real per-client budget and must not be removed.

Then fix or supersede the duplicated sentence in the docs file.

**Verify**:
`grep -rn "real client via x-forwarded-for" src/ docs/` returns **no** matches;
`npm run typecheck && npm test && npm run format:check` → all exit 0.

## Test plan

Extend
`backend/packages/api/src/utils/__tests__/phone-verification.unit.spec.ts`
(read it first; it already tests the strict parse, so match that style).

Cases (all required):

1. Both vars `'true'` → triple is `true/true/*`, no warnings.
2. `PHONE_VERIFICATION_REQUIRED` unset → `write=false`, and `money` follows it
   to `false` (this is the fail-open coupling, made explicit in a test for the
   first time).
3. `PHONE_VERIFICATION_REQUIRED='True'` → resolves `false` **and** produces a
   warning naming the variable. This is the typo case the plan exists for.
4. `PHONE_VERIFICATION_REQUIRED='false'` → resolves `false` and produces **no**
   warning (an explicit off is not a typo).
5. `PHONE_GATE_REQUIRED='false'` with `PHONE_VERIFICATION_REQUIRED='true'` →
   `write=true, money=false`, no warning (the documented in-a-hurry lever).

Verification:
`cd backend/packages/api && TEST_TYPE=unit NODE_OPTIONS=--experimental-vm-modules npx jest phone --runInBand --forceExit`
→ all pass.

## Done criteria

- [ ] `cd backend/packages/api && corepack yarn check-types` exits 0
- [ ] `cd backend/packages/api && corepack yarn test:unit` exits 0
- [ ] `npm run typecheck && npm test && npm run format:check` all exit 0
- [ ] `grep -rn "real client via x-forwarded-for" src/ docs/` returns no matches
- [ ] The boot reporter is wired and cannot throw
- [ ] The existing `'1' → false` assertion still passes unchanged
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpts in "Current state" do not match the live code.
- There is no clean boot hook and wiring one would mean changing
  `medusa-config.ts` in a way that affects module loading order. Report it —
  a log line is not worth destabilising boot.
- You find that `PHONE_GATE_REQUIRED`'s follow-the-other-var behaviour is
  relied on by a test in a way your reporter would change. Do not change the
  parsers.

## Maintenance notes

- **This plan deliberately does not make the gate fail closed.** The fail-open
  default is the rollback lever, and 2026-08-07 is the evidence it is needed.
  What changes is that flipping it is now visible in the deploy log.
- If a future change makes the gate fail closed, this reporter is where the
  decision should be recorded.
- A reviewer should scrutinize: that the reporter cannot throw, that no
  credential value reaches a log line, and that the corrected comment does not
  merely delete the false claim but replaces it with the true one — a deleted
  comment leaves the next reader to re-derive it wrongly.
