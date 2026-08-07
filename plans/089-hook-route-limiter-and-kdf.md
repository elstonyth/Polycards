# Plan 089: Rate-limit the gateway hook routes and stop re-deriving the AES key per callback

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat db2767f5..HEAD -- backend/packages/api/src/api/middlewares.ts backend/packages/api/src/modules/packs/globepay.ts`
> On any mismatch with the "Current state" excerpts, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `db2767f5`, 2026-08-07

## Why this matters

`POST /hooks/globepay/{deposit,withdrawal,payout-verify}` are unauthenticated
by design — a webhook carries no customer token, and its authentication is the
RSA signature. That design is correct. What is missing is a budget.

There is **no `/hooks*` matcher anywhere in `middlewares.ts`**, so these three
routes run with no rate limiter at all. And the work they do before verifying
anything is expensive: `openCallback` **decrypts first and verifies second**,
and the decrypt calls `deriveAesKey`, which is a **synchronous**
`pbkdf2Sync(aesKey, aesKey, 1000, 32, 'sha1')` — recomputed on every single
invocation, blocking the event loop. The deposit route triggers a second
decrypt later in the same request.

So any host on the internet can force repeated blocking PBKDF2 rounds on the
API's single event loop, with no per-IP budget, degrading the **whole backend**
rather than just the webhook. Both halves are cheap to fix and there is no
upside to leaving either.

## Current state

### No `/hooks` matcher

```text
grep -n "'/hooks" backend/packages/api/src/api/middlewares.ts
```

returns nothing. The only broad matchers are `'/*'` (GET-only root redirect,
around :198-202) and `'/store/*'` (around :912-918).

### The key derivation (`modules/packs/globepay.ts:25-33`, verbatim)

```ts
/**
 * AES key derivation, §1.11. The password AND the salt are both the raw AES
 * key string — that is not a typo in the doc, all three of their samples
 * (C# Rfc2898DeriveBytes, Java PBKDF2WithHmacSHA1, PHP hash_pbkdf2 sha1) do
 * it. 1000 iterations is C#'s Rfc2898DeriveBytes default, spelled out
 * explicitly in the Java and PHP samples.
 */
function deriveAesKey(aesKey: string): Buffer {
  return pbkdf2Sync(aesKey, aesKey, 1000, 32, 'sha1');
}
```

### Decrypt runs before verify (`modules/packs/globepay.ts:153-162`)

Read `openCallback`. It decrypts, then throws unless `verifySignature` returns
true. That ordering is forced by the protocol (the signature covers the
decrypted plaintext), so it is **not** a bug — it is the reason the decrypt
must be cheap.

### The IP list that exists and is unused (`modules/packs/globepay.ts:188-196`, verbatim)

```ts
/**
 * Their callbacks arrive from a fixed set of source addresses (doc "Outgoing
 * IP"). Defence in depth only — the signature is the real gate, since behind a
 * tunnel or a load balancer the observed source IP is not theirs.
 */
export const GLOBEPAY_CALLBACK_IPS = {
  production: '13.159.14.239',
  staging: '160.250.92.219',
} as const;
```

The comment is right that this cannot replace the signature. It is **not** a
substitute and this plan does not make it one.

### The limiter you will use

`backend/packages/api/src/api/utils/rate-limit.ts` — `createEnvRateLimit`
builds a burst + sustained limiter from a `name`, with env-tunable defaults and
a JSDoc block naming the env vars. Read two existing factories before writing
a third; they are the format bar.

### Repo conventions to match

- Matcher entries carry a comment explaining **why** the middleware stack is
  what it is. The `/store/phone-verification/*` entries are good examples.
- Rate limiters never take an endpoint down on their own failure — see the
  `catch` around `store.consume` in `createEnvRateLimit`.
- Backend source is Prettier-formatted with single quotes.

## Commands you will need

| Purpose           | Command                                                                                                                      | Expected on success |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| Backend typecheck | `cd backend/packages/api && corepack yarn check-types`                                                                       | exit 0              |
| Globepay tests    | `cd backend/packages/api && TEST_TYPE=unit NODE_OPTIONS=--experimental-vm-modules npx jest globepay --runInBand --forceExit` | all pass            |
| Backend unit tier | `cd backend/packages/api && corepack yarn test:unit`                                                                         | all pass            |
| Backend lint | NONE. `backend/packages/api` has no eslint config and no `lint` script, so `turbo run lint` skips it and CI never lints this package. Do NOT author one — out of scope. | n/a |

## Scope

**In scope**:

- `backend/packages/api/src/modules/packs/globepay.ts` (memoize the derivation)
- `backend/packages/api/src/api/utils/rate-limit.ts` (one new factory)
- `backend/packages/api/src/api/middlewares.ts` (one new matcher)
- `backend/packages/api/src/modules/packs/__tests__/globepay.unit.spec.ts` (extend)
- `plans/README.md` (status row)

**Out of scope**:

- The decrypt-before-verify ordering — protocol-mandated.
- Using `GLOBEPAY_CALLBACK_IPS` as an authentication gate. Do **not** add an
  IP allowlist that rejects; the comment explains why the observed source IP
  is unreliable behind a proxy, and a hard IP gate would drop real callbacks.
- RSA-SHA1 — vendor-mandated by the integration spec; not ours to choose.
- Everything else in the hook routes (plans 083, 084, 087).

## Git workflow

- Branch: `advisor/089-hooks-limiter-and-kdf`
- Conventional commits, e.g.
  `perf(payments): memoize the GlobePay AES key derivation and bound the hook routes`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Memoize the key derivation

`deriveAesKey` is a pure function of a string that is a process-lifetime
constant. Memoize it in a module-level `Map<string, Buffer>`.

Two properties to preserve, and to state in the comment:

- The cache key is the AES key string, so a config change (different key) does
  not return a stale buffer.
- The cached `Buffer` must not be mutated by callers. Check `aesEncrypt` /
  `aesDecrypt` — if either passes the buffer somewhere that could mutate it,
  return a copy instead and say why.

Do **not** log the key or the cache contents, and do not add the key to any
error message.

**Verify**: `corepack yarn check-types` → exit 0.

### Step 2: Add the hook limiter factory

Add `createGatewayHookRateLimit()` to `rate-limit.ts`, keyed on the default
(IP) — a webhook has no `auth_context` and no useful body key.

Size it **generously**: the gateway retries dropped callbacks, sometimes in
bursts, and a 429 to a real callback delays a customer's credit. Suggested
defaults, stated as env-tunable in the JSDoc
(`GATEWAY_HOOK_RATE_BURST_LIMIT` / `_BURST_WINDOW_MS` /
`GATEWAY_HOOK_RATE_LIMIT` / `_WINDOW_MS`):

- burst: **60 / 10s**
- sustained: **600 / 60s**

Write the rationale into the JSDoc: this is an abuse ceiling on an
unauthenticated endpoint that does blocking cryptography, **not** fairness
between callers — the gateway is the only legitimate caller, and it should
never come close to these numbers. Note explicitly that a 429 to a genuine
callback is recoverable (the gateway retries, and the reconcile sweep is the
backstop), which is what makes an abuse ceiling safe here.

**Verify**: `corepack yarn check-types` → exit 0.

### Step 3: Register the matcher

Add one entry to `middlewares.ts`:

```ts
    {
      matcher: '/hooks/globepay/*',
      method: 'POST',
      middlewares: [createGatewayHookRateLimit()],
    },
```

**Before committing to that matcher string**, confirm it actually matches all
three routes. This repo has a recorded routing gotcha: Medusa's `RoutesSorter`
silently drops a zero-segment matcher (see the long comment around
`middlewares.ts:168-176`), and a `*` wildcard spans `/` in path-to-regexp
(recorded in plan 061's notes). Verify by reading how the existing
`'/auth/*/emailpass/*'` and `'/store/packs/*/open'` matchers behave, or by
booting and probing. State in your completion note **how** you verified it —
"it looks right" is not verification.

Write a comment on the matcher naming: (a) these routes are deliberately
unauthenticated because their auth is the RSA signature, and (b) the limiter is
therefore the only thing bounding an anonymous caller.

**Verify**: `grep -n "'/hooks" backend/packages/api/src/api/middlewares.ts`
returns the new matcher; `corepack yarn check-types` → exit 0.

### Step 4: Tests

See "Test plan", then run the gates.

## Test plan

Extend `backend/packages/api/src/modules/packs/__tests__/globepay.unit.spec.ts`
(read it first).

Cases (all required):

1. `deriveAesKey` (or whatever the memoized entry point is) called twice with
   the same key returns an equal buffer, and `pbkdf2Sync` runs **once** — spy
   on `node:crypto` to assert the call count. This is the whole point of Step 1
   and must fail if it is reverted.
2. Called with two different keys → two derivations, two distinct buffers.
3. Round-trip: `aesEncrypt` then `aesDecrypt` still produces the original
   plaintext after memoization (proves the cached buffer is not corrupted).
4. `openCallback` still throws on a bad signature after memoization — the
   security property must be unchanged. If a signature fixture exists in the
   spec, reuse it; do not invent key material.

Prove case 1 red-green. Report both directions.

Verification:
`cd backend/packages/api && TEST_TYPE=unit NODE_OPTIONS=--experimental-vm-modules npx jest globepay --runInBand --forceExit`
→ all pass.

## Done criteria

- [ ] `cd backend/packages/api && corepack yarn check-types` exits 0
- [ ] `cd backend/packages/api && corepack yarn test:unit` exits 0
- [ ] `grep -n "'/hooks" backend/packages/api/src/api/middlewares.ts` returns the new matcher
- [ ] How the matcher was verified to cover all three routes is stated in the completion note
- [ ] `pbkdf2Sync` runs once per distinct key (asserted by test 1), with the red-green proof reported
- [ ] No IP-allowlist rejection was added
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpts in "Current state" do not match the live code.
- `'/hooks/globepay/*'` does not match all three routes and you cannot find a
  matcher shape that does. Report what you tried — the routing sorter's
  behaviour here is a known trap and getting it wrong means the limiter
  silently does nothing.
- Memoizing changes any test's behaviour beyond the call count — that would
  mean something depends on a fresh buffer.
- You find another caller of `deriveAesKey` outside this module.

## Maintenance notes

- **The limiter is not authentication.** The signature is. If anyone ever
  proposes relaxing signature verification because "the hooks are rate-limited
  now", that is exactly backwards.
- Sizing: if a real callback burst ever trips this, raise the env var — do not
  remove the limiter. The reconcile sweep makes a dropped callback recoverable,
  which is what makes the ceiling safe.
- A reviewer should scrutinize: the memo cache is keyed on the key string (not
  a boolean "already derived"), the buffer cannot be mutated by a caller, and
  the matcher was empirically verified rather than assumed.
