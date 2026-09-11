# Plan 137: Truth round 9 — the phone-gate flags the template omits, the security checklist row the gateway swap inverted, and the comments/constants that still describe GlobePay

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If a
> STOP condition occurs, stop and report — do not improvise. Do NOT update
> `plans/README.md`; the reviewer maintains it.
>
> **Drift check (run first)**:
> `git diff --stat 1bc30e6b..HEAD -- backend/packages/api/.env.template docs/ops/security-verification-checklist.md docs/superpowers/specs/2026-08-24-referral-tasks-rebuild-design.md docs/adr/0008-referral-code-is-a-random-short-code.md backend/packages/api/src/utils/customer-by-metadata.ts backend/packages/api/src/api/store/referral/route.ts backend/packages/api/src/api/utils/rate-limit.ts backend/packages/api/src/modules/packs/gateway-deposit.ts backend/packages/api/src/modules/packs/gateway-withdrawal.ts backend/packages/api/src/modules/packs/saved-accounts.ts CONTEXT.md .github/workflows/ci.yml backend/packages/api/integration-tests/run-http-shards.mjs`
> Expected on a branch cut from origin/master `51f74bcd`: empty. Anything
> listed → compare against "Current state"; on a mismatch, STOP.
>
> **Reading the env template**: a repo hook blocks _shell_ reads of any
> `.env*` file (it holds secrets in some variants). Use the **Read** and
> **Edit** tools on `backend/packages/api/.env.template`, never `cat` /
> `sed` / `grep -n`. The template carries placeholder values only, but the
> hook does not know that. Never paste any line of it into your report.

## Status

- **Priority**: P3
- **Effort**: S–M (many one-line edits; no behaviour change)
- **Risk**: LOW — comments, docs, one env template, three dead constants
- **Depends on**: none. **Overlaps**: plan 132 rewrites the `gateway_status` comment in `models/gateway-withdrawal.ts` — this plan does NOT touch that file.
- **Category**: docs / tech-debt / dx
- **Planned at**: commit `1bc30e6b` (working tree), 2026-09-10; drift-checked against origin/master `51f74bcd`

## Why this matters

The 2026-09-06 gateway cutover (#557–#560) and the referral-code change
(#547) left a trail of statements that are now false where a reader will
trust them. None breaks runtime. Each one costs the next reader a wrong
premise on a money or auth surface, and this repo has recorded that exact
cost before (round 14 findings 9, 10, 16, 17; the CI-comment belief plan 131
corrects). Grouped so one executor can clear them in one pass:

1. **The two backend flags that gate every money and goods path are
   absent from the env template.** `PHONE_VERIFICATION_REQUIRED` and
   `PHONE_GATE_REQUIRED` are read by `utils/phone-verification.ts` and set
   in production; the tracked `.env.template` names neither (`grep -c` = 0
   for both). Unset means off, so a fresh clone never exercises the gate —
   round-14 finding 14's pattern, one delta later.
2. **The security checklist says source-IP allowlisting was deliberately
   rejected.** Row 5 of `docs/ops/security-verification-checklist.md`
   ("the RSA callback signature is the **only** gate … Nothing backstops a
   signature that verifies") describes GlobePay. TGPay's hooks enforce
   `TGPAY_CALLBACK_IPS` and **fail closed when it is unset in production**
   (`api/utils/payer-ip.ts`). The row's only citation is a file #559 deleted.
3. **The referral rebuild spec has no supersession marker** for the part
   ADR 0008 replaced; the ADR points at the spec, the spec does not point
   back — and ADR 0007's Successor section sends readers to the spec first.
4. **Two pointers name a function that does not exist** (`ensureReferralCode`
   in ADR 0008 and `utils/customer-by-metadata.ts`); the real allocator is
   `PacksModuleService.assignReferralCode`, whose global advisory lock is
   the sentence the ADR's "unindexed JSONB pre-check" consequence needs.
5. **`store/referral/route.ts` asserts a lock that one of its two writers
   never takes** ("Both metadata writers go through the per-customer advisory
   lock") — `claimUsername` writes `first_name` under `username:alloc`, not
   metadata under `metadata:<id>`. Harmless today (disjoint columns, disjoint
   locks); wrong premise for the next change.
6. **The `gateway-hook` limiter docstring** in `rate-limit.ts` still
   describes RSA signatures, AES decryption, PBKDF2 and a `payout-verify`
   hook that no longer exists — while the twin comment in `middlewares.ts`
   was rewritten for TGPay in the same PR.
7. **Dead money constants with GlobePay provenance**: `GATEWAY_MIN_RM = 30`
   (deposit floor; live floor is 50 from `GATEWAYS.tgpay.limits`) has zero
   importers; `GATEWAY_WD_MIN_RM` / `GATEWAY_WD_MAX_RM = 50000` (live ceiling
   30,000) are unread since #557. Their comments attribute the numbers to
   "the provider 2026-07-29 (Sean)" and cite a deleted doc. `gateway-deposit.ts:26`
   says credit lands "when a verified callback reports status 6" — a GlobePay
   numeric status.
8. **`saved-accounts.ts` claims the id-derivation check "holds by
   enforcement"** for every entry; for a legacy-coded entry the id being
   checked was recomputed two steps earlier by the parse, so the check
   cannot fail there. Not reachable today (both metadata writers compute the
   id correctly and client-supplied metadata is refused), but the recorded
   control is overstated.
9. **`CONTEXT.md:351`** records that the OTP TemplateSid is dropped on a
   voice call but not the consequence: the spoken code names no purpose,
   which is the compensating control §"Accepted Ceilings" relies on.
10. **Two stale suite counts** (`ci.yml:307` "84 suites", `run-http-shards.mjs:22`
    "88") — ~100 HTTP spec files exist.

## Current state

### Excerpts (each is the text to change)

**(1)** `backend/packages/api/src/utils/phone-verification.ts:37` reads
`PHONE_VERIFICATION_REQUIRED`; `:51-56` reads `PHONE_GATE_REQUIRED` with the
documented rule "Unset (or empty) means 'follow PHONE*VERIFICATION_REQUIRED'".
`CONTEXT.md` §Phone Verification, "Feature Flags" paragraph (lines ~322-330),
is the authoritative prose — copy its two bullet definitions into the
template comment, shortened. The template already has a `PHONE_OTP*\*` block
(the rate-limit tunables) — the two flags belong directly above it.

**(2)** `docs/ops/security-verification-checklist.md:71`:

```md
| 5 | The RSA callback signature is the **only** gate on the deposit hook — source-IP allowlisting was deliberately rejected (DO's LB hides their address). Nothing backstops a signature that verifies. | `docs/payments/globepay365-setup.md:310-317` (removed 2026-09-07; see git history) | — | in-repo |
```

The live control:

```ts
// backend/packages/api/src/api/utils/payer-ip.ts:110-121 (createTgpayCallbackAllowlist)
      .warn(
        `[tgpay] rejected callback from ${sourceIp || 'unknown'}: ${verdict.reason}` +
          (verdict.reason === 'unset-in-production'
            ? ' — TGPAY_CALLBACK_IPS is not set; refusing outside the sandbox'
```

and `docs/payments/tgpay-setup.md:210-219` (the "Callback source IPs" bullet:
both hooks enforce `TGPAY_CALLBACK_IPS`, judged on `do-connecting-ip`, never
on a caller-written `X-Forwarded-For`). Rows 7–10 and 13 of the same table
already carry the "(removed 2026-09-07; see git history)" annotation — row 5
is the one whose **claim**, not just its citation, was inverted.

**(3)** `docs/superpowers/specs/2026-08-24-referral-tasks-rebuild-design.md:102-105`:

```md
### Attribution flow

- `/invite/[handle]` (storefront route): validates the handle exists, sets a 30-day cookie,
  redirects to `/`. The signup server action reads the cookie and calls a backend endpoint that
```

`docs/adr/0008-…md:4-7` declares "Supersedes (in part): the 'Attribution'
decision in [that spec]". The spec contains no `0008` and no `uperseded`.

**(4)** `docs/adr/0008-referral-code-is-a-random-short-code.md:28-29`:

```md
beside the handle and assigned lazily on the first `/referral` visit
(`utils/referral-code.ts`, `ensureReferralCode`). No new table: the code is
```

`backend/packages/api/src/utils/customer-by-metadata.ts:29-31`:

```ts
/**
 * By referral code (metadata.referral_code — written by ensureReferralCode,
 * utils/referral-code.ts). Exercised by referral.spec.ts.
 */
```

Truth: `PacksModuleService.assignReferralCode` (`modules/packs/service.ts`,
`@InjectTransactionManager`, takes `pg_advisory_xact_lock('referral_code:alloc')`
then `metadata:<customerId>`, probes uniqueness and writes in one
transaction); `utils/referral-code.ts` holds `generateReferralCode`,
`normalizeReferralCode`, `findBindableReferrer` and, at its line 11, already
names `assignReferralCode` correctly.

**(5)** `backend/packages/api/src/api/store/referral/route.ts:27-28`:

```ts
  // Both metadata writers go through the per-customer advisory lock, so
  // running them side by side cannot lose a key.
  const [{ result }, code, summary] = await Promise.all([
    ensureProfileHandleWorkflow(req.scope).run({ input: { customer_id: customerId } }),
    packs.assignReferralCode({ customerId, generate: generateReferralCode }),
```

Truth (verified by the advisor): `ensureProfileHandleWorkflow` →
`claimUsername` writes `first_name` under `username:alloc` and is backstopped
by `IDX_customer_first_name_lower_unique`; `assignReferralCode` writes
`metadata` under `referral_code:alloc` + `metadata:<id>`. Different columns,
disjoint global locks, each transaction takes at most one `customer` row
lock — no lost update, no lock cycle.

**(6)** `backend/packages/api/src/api/utils/rate-limit.ts:953-998` — the
docstring above `'gateway-hook'`. Sentences to replace: "`POST /hooks/tgpay/{deposit,withdrawal
payout-verify}`" (no `payout-verify` hook exists; also a missing comma);
"its authentication is the RSA signature"; "§1.16 forces `openCallback` to
decrypt before it can verify, so a forged body still cost a real AES decrypt
(and, until plan 089 memoized it, a 1000-round PBKDF2)"; "every field is
inside the encrypted `Data` blob"; the `payout-verify: fails CLOSED` bullet.
Sentences to **keep** verbatim: "THIS IS AN ABUSE CEILING, NOT AUTHENTICATION
…" (rewritten to name the key-header check + allowlist as "the real gate"),
the sizing rationale, the burst/sustained consistency paragraph and the
env-tunable names. The already-correct twin at `middlewares.ts:297-310` is
the wording to mirror.

**(7)**

```ts
// backend/packages/api/src/modules/packs/gateway-deposit.ts:24-27
// The submit half of the gateway deposit loop: record intent, ask the
// gateway for a cashier page, hand the customer the URL. NO credit is issued
// here — that happens only when a verified callback reports status 6
// (src/api/hooks/tgpay/deposit/route.ts).
// backend/packages/api/src/modules/packs/gateway-deposit.ts:69-81
/**
 * Per-transaction limits for the PRODUCTION merchant account, confirmed by the
 * provider 2026-07-29 (Sean): Online Banking bank-to-bank and QR e-wallet both
 * RM 30 – RM 10,000. ...
 */
export const GATEWAY_MIN_RM = 30;
export const GATEWAY_MAX_RM = 10000;
// backend/packages/api/src/modules/packs/gateway-withdrawal.ts:52-62
/**
 * Per-transaction payout band, confirmed by the provider 2026-07-29 (Sean):
 * MYR Payout is RM 50 – RM 50,000, ...
 */
export const GATEWAY_WD_MIN_RM = 50;
export const GATEWAY_WD_MAX_RM = 50000;
```

Live bands: `modules/packs/gateway.ts:102-110` (`GATEWAYS.tgpay.limits`:
deposit 50–10,000, payout 50–30,000, "read from the PRODUCTION tenant's
settings 2026-09-06"). `GATEWAY_MAX_RM` is **live** — it is the sweep's
quarantine ceiling (`gateway-reconcile.ts:146`) and the deposit ceiling
guard (`gateway-deposit.ts:519`) and equals the site-wide `TOPUP_MAX_RM`;
keep it, re-describe it. The deposit callback settles on TGPay's string
status `APPROVED` (`docs/payments/tgpay-setup.md:34-35`).

**(8)** `backend/packages/api/src/modules/packs/saved-accounts.ts:93-99`
(parse: for a legacy code, `id` is **recomputed** as
`savedBankAccountId(bankCode, e.accountNumber)`) and `:238-248` (resolver
comment: "recomputing it HERE makes it hold by enforcement instead of by
convention … Any future writer that forgets savedBankAccountId … is refused
rather than paid"). For a canonical-coded entry the check is real; for a
legacy-coded entry it compares a value the parse just derived.

**(9)** `CONTEXT.md:351` — the sentence "TemplateSid is SMS-only and is
dropped on a call." The rationale it should carry is at
`backend/packages/api/src/utils/phone-verification.ts:365-378` ("Naming the
flow in the SMS is what lets the person reading it refuse").

**(10)** `.github/workflows/ci.yml:307` ("84 suites over 8 shards ≈ 10-11/shard");
`backend/packages/api/integration-tests/run-http-shards.mjs:22` ("88").
Count: `ls backend/packages/api/integration-tests/http/*.spec.ts | wc -l`.

### Conventions

- Docs and comments are prose, present tense, and say **why**; a corrected
  fact keeps a one-clause trace of what it replaced when the old belief is
  likely to be re-derived (the security checklist's "(removed 2026-09-07;
  see git history)" pattern; the `middlewares.ts:296-310` rewrite).
- Env template lines: `NAME=` with the comment block above; placeholders
  never real values.
- Deleting an export: grep `src/` **and** `integration-tests/` **and**
  `backend/apps/admin/src` for the identifier first.

## Commands you will need

| Purpose                                     | Command                                                                                                                                                                                                                                                                                                                                     | Expected on success                                                                                  |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Backend typecheck                           | `cd backend && corepack yarn check-types`                                                                                                                                                                                                                                                                                                   | exit 0                                                                                               |
| Backend lint                                | `cd backend && corepack yarn lint`                                                                                                                                                                                                                                                                                                          | exit 0                                                                                               |
| Backend unit (the files touched have specs) | `cd backend/packages/api && corepack yarn test:unit rate-limit gateway-deposit gateway-withdrawal saved-accounts referral`                                                                                                                                                                                                                  | all pass                                                                                             |
| Prettier on touched TS                      | `cd backend && corepack yarn prettier --check packages/api/src/api/utils/rate-limit.ts packages/api/src/modules/packs/gateway-deposit.ts packages/api/src/modules/packs/gateway-withdrawal.ts packages/api/src/modules/packs/saved-accounts.ts packages/api/src/api/store/referral/route.ts packages/api/src/utils/customer-by-metadata.ts` | exit 0                                                                                               |
| Root prettier on docs/yaml                  | `npx prettier --check docs/ops/security-verification-checklist.md docs/adr/0008-referral-code-is-a-random-short-code.md CONTEXT.md .github/workflows/ci.yml`                                                                                                                                                                                | exit 0 (if a doc was not prettier-clean **before** your edit, leave its formatting alone and say so) |
| Env-name presence (never the value)         | `grep -c "PHONE_GATE_REQUIRED" backend/packages/api/.env.template`                                                                                                                                                                                                                                                                          | `1` after Step 1                                                                                     |

## Scope

**In scope** (the only files you should modify):

- `backend/packages/api/.env.template` (Read/Edit tools only)
- `docs/ops/security-verification-checklist.md` — row 5 only
- `docs/superpowers/specs/2026-08-24-referral-tasks-rebuild-design.md` — a banner under "### Attribution flow" only
- `docs/adr/0008-referral-code-is-a-random-short-code.md` — lines 28-29 only
- `backend/packages/api/src/utils/customer-by-metadata.ts` — the docblock only
- `backend/packages/api/src/api/store/referral/route.ts` — the comment only
- `backend/packages/api/src/api/utils/rate-limit.ts` — the `gateway-hook` docstring only
- `backend/packages/api/src/modules/packs/gateway-deposit.ts` — lines 24-27 and 69-81
- `backend/packages/api/src/modules/packs/gateway-withdrawal.ts` — lines 52-62
- `backend/packages/api/src/modules/packs/saved-accounts.ts` — the resolver comment only
- `CONTEXT.md` — line 351 only
- `.github/workflows/ci.yml` — line 307 comment only
- `backend/packages/api/integration-tests/run-http-shards.mjs` — line 22 comment only

**Out of scope** (do NOT touch, even though they look related):

- `models/gateway-withdrawal.ts` `gateway_status` comment — plan 132.
- Any **behaviour**: `payer-ip.ts`, `phone-verification.ts` (the voice/purpose refusal is an unplanned operator decision — see README), `assignReferralCode` (fast path is an unplanned finding), `saved-accounts.ts` parse logic.
- `.do/*.yaml` — deploy specs; the withdrawal-guardrail declaration (DX-03) is an operator step recorded in the README, not this plan.
- `docs/payments/tgpay-setup.md` — plan 133 adds a paragraph there; do not create a conflicting hunk.
- `PRODUCT.md`, `CLAUDE.md`, `AGENTS.md` — gitignored operator files (plan 129).

## Git workflow

- Branch: `advisor/137-truth-round9`
- One commit per numbered item or per file, conventional style, e.g. `docs(security): row 5 — TGPay hooks enforce a callback IP allowlist, fail closed when unset`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Env template — the two phone-gate flags

With the **Read** tool, open `backend/packages/api/.env.template` and find the
`PHONE_OTP_` block. With the **Edit** tool, insert directly above it:

```
# Phone verification (CONTEXT.md §Phone Verification). Two flags, deliberately
# separate. Unset = off locally.
# PHONE_VERIFICATION_REQUIRED gates WRITING a phone: signup and phone-change
# must carry an OTP proof token. Production: true.
PHONE_VERIFICATION_REQUIRED=
# PHONE_GATE_REQUIRED gates SPENDING and SHIPPING (topup / deposit / delivery)
# for accounts with no verified phone. UNSET means "follow
# PHONE_VERIFICATION_REQUIRED" — set it only to reopen the money path in a
# hurry without reopening unproven phone writes. Production: unset.
PHONE_GATE_REQUIRED=
```

**Verify**: `grep -c "PHONE_VERIFICATION_REQUIRED" backend/packages/api/.env.template` → `2` (comment + key); `grep -c "^PHONE_GATE_REQUIRED=" backend/packages/api/.env.template` → `1`. (Count-only greps are allowed by the hook.)

### Step 2: Security checklist row 5

Replace row 5's Fact cell with:

> The TGPay deposit and payout hooks are gated by **two** controls: the
> gateway's key-header check (`x-public-key` / `x-secret-key`, constant-time,
> `tgpay-client.ts` `tgpayCallbackAuthorized`) **and** a source-IP allowlist
> (`TGPAY_CALLBACK_IPS`, judged on DigitalOcean's `do-connecting-ip`, never
> a caller-written `X-Forwarded-For`) that **fails closed when unset outside
> the sandbox**. This inverts the GlobePay-era decision this row recorded
> until 2026-09-07 ("allowlisting deliberately rejected — DO's LB hides their
> address"); the ingress header is what made it possible.

Citation cell: `` `backend/packages/api/src/api/utils/payer-ip.ts` (createTgpayCallbackAllowlist), `backend/packages/api/src/modules/packs/tgpay-client.ts` (tgpayCallbackAuthorized, callbackIpAllowed), `docs/payments/tgpay-setup.md` §"Open questions" callback-IP bullet ``. Date `2026-09-07`, Source `in-repo`. Keep the table's column order and the `in-repo` / console-observed rule from the section header.

**Verify**: `grep -c "deliberately rejected" docs/ops/security-verification-checklist.md` → `1` (only inside the new row's history clause); `grep -c "fails closed when unset" docs/ops/security-verification-checklist.md` → `1`.

### Step 3: Spec supersession banner

Under `### Attribution flow` in the referral spec, insert as the first line:

```md
> **Superseded in part by [ADR 0008](../../adr/0008-referral-code-is-a-random-short-code.md) (2026-09-03).**
> The referral identity is a random 8-character code in
> `customer.metadata.referral_code`, shared as `/r/<code>`, not the profile
> handle at `/invite/<handle>`. The cookie, the signup bind, the self-referral
> and already-attributed refusals below are unchanged.
```

**Verify**: `grep -c "ADR 0008" docs/superpowers/specs/2026-08-24-referral-tasks-rebuild-design.md` → `1`.

### Step 4: The two `ensureReferralCode` pointers

ADR 0008 lines 28-29 → "(allocated by `PacksModuleService.assignReferralCode`,
`backend/packages/api/src/modules/packs/service.ts`, under a global
`referral_code:alloc` advisory lock with the uniqueness probe and the write
in one transaction — which is what keeps the unindexed pre-check below
safe)". `customer-by-metadata.ts:30` → "written by
`PacksModuleService.assignReferralCode` (modules/packs/service.ts)".

**Verify**: `grep -rn "ensureReferralCode" docs backend/packages/api/src` → no matches.

### Step 5: Referral route comment

Replace `route.ts:27-28` with:

```ts
// Two writers, two columns, two disjoint global locks: the handle workflow
// writes first_name under `username:alloc` (backstopped by
// IDX_customer_first_name_lower_unique); assignReferralCode writes metadata
// under `referral_code:alloc` + `metadata:<id>`. Each transaction locks at
// most one customer row, so running them side by side cannot lose either
// write or deadlock.
```

**Verify**: `grep -c "Both metadata writers" backend/packages/api/src/api/store/referral/route.ts` → `0`.

### Step 6: `gateway-hook` docstring

Rewrite per Current state (6): route list `POST /hooks/tgpay/{deposit,withdrawal}`;
authentication = the gateway's key headers checked in the handler
(`tgpayCallbackAuthorized`) plus `tgpayCallbackAllowlist` on the same
matcher; drop the RSA/AES/PBKDF2/`Data`-blob sentences and the
`payout-verify` bullet; keep the "ABUSE CEILING, NOT AUTHENTICATION"
paragraph (pointing at the two real gates), the sizing paragraph, the
burst/sustained consistency scar, and the env names. Add one line: "Keyed on
`callbackSourceIp` (do-connecting-ip), the same address the allowlist
judges."

**Verify**: `sed -n '/gateway-hook limiter/,/gateway-hook.: {/p' backend/packages/api/src/api/utils/rate-limit.ts | grep -c "RSA\|AES\|PBKDF2\|payout-verify\|encrypted"` → `0`; `corepack yarn test:unit rate-limit` → passes (the docstring is inside a `RATE_LIMITS` literal; a stray `*/` would break the file).

### Step 7: Gateway constants and comments

- `gateway-deposit.ts:26-27`: "… only when a verified callback reports the
  gateway's success status (TGPay: `APPROVED`) — src/api/hooks/tgpay/deposit/route.ts."
- `gateway-deposit.ts:69-81`: delete `GATEWAY_MIN_RM` after confirming
  `grep -rn "GATEWAY_MIN_RM" backend/packages/api/src backend/packages/api/integration-tests backend/apps/admin/src` returns only the declaration. Rewrite the comment above `GATEWAY_MAX_RM`: it is the **site-wide** deposit ceiling (`TOPUP_MAX_RM`, 10,000), enforced at the deposit guard and used as the sweep's quarantine ceiling; per-gateway bands live in `GATEWAYS[id].limits` (`gateway.ts`). Drop the 2026-07-29 provider attribution and the deleted-doc reference.
- `gateway-withdrawal.ts:52-62`: same grep for `GATEWAY_WD_MIN_RM` and `GATEWAY_WD_MAX_RM`; if both are unreferenced, delete both and their comment, leaving a two-line pointer: "Payout bands are per gateway — `GATEWAYS[id].limits.withdrawalMin/Max` (`gateway.ts`), enforced in `startWithdrawal`." If either **is** referenced, keep it and correct its comment to the registry instead (and say so in the report).

**Verify**: `cd backend && corepack yarn check-types` → exit 0; `grep -rn "Sean\|globepay365-setup" backend/packages/api/src/modules/packs/gateway-deposit.ts backend/packages/api/src/modules/packs/gateway-withdrawal.ts` → no matches.

### Step 8: Saved-accounts guard comment

Replace the resolver comment (`saved-accounts.ts:238-248`) so it says: the
derivation check is real for entries stored with a canonical bank id; for a
legacy-coded entry the parse recomputes the id from the canonical code
(lines 93-99), so the resolver's comparison is against a value it derived
and cannot fail for that entry — the guard covers canonical entries, and the
legacy path is protected by both metadata writers computing the id
(`save route`, `backfill script`) and by client-supplied metadata being
refused (`middlewares.ts` customer-write guards). Keep the "same message as
the unknown-id branch" sentence.

**Verify**: `grep -c "hold by enforcement instead of by convention" backend/packages/api/src/modules/packs/saved-accounts.ts` → `0`; `corepack yarn test:unit saved-accounts` → passes.

### Step 9: CONTEXT.md and the suite counts

`CONTEXT.md:351`: append to the sentence: "— so a voice-delivered code
carries no statement of which flow it authorises; the purpose-naming
template is the compensating control §Accepted Ceilings relies on, and the
voice channel does not have it (recorded 2026-09-10; refusing `call` for
`password-reset` is an open operator decision, plans/README round 15)."

`ci.yml:307` and `run-http-shards.mjs:22`: replace the number with the
current count from `ls backend/packages/api/integration-tests/http/*.spec.ts | wc -l`
and add "(as of 2026-09-10)".

**Verify**: `grep -c "compensating control" CONTEXT.md` ≥ 1 (there may be an existing use elsewhere; the new sentence must be at line ~351 — confirm with `grep -n "voice-delivered code" CONTEXT.md`); `python -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml'))"` → exit 0.

### Step 10: Full verification

Run the Commands table.

## Test plan

No new tests — every change is a comment, a doc, a template line, or a dead
constant. The existing suites named in the Commands table prove nothing
behavioural moved. Additionally run `cd backend/packages/api && corepack yarn test:unit` (whole tier) once at the end: 169+ suites green.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `grep -c "^PHONE_GATE_REQUIRED=" backend/packages/api/.env.template` → `1` and `grep -c "^PHONE_VERIFICATION_REQUIRED=" backend/packages/api/.env.template` → `1`
- [ ] `grep -rn "ensureReferralCode" docs backend/packages/api/src` → no matches
- [ ] `grep -c "ADR 0008" docs/superpowers/specs/2026-08-24-referral-tasks-rebuild-design.md` → `1`
- [ ] `grep -c "fails closed when unset" docs/ops/security-verification-checklist.md` → `1`
- [ ] `grep -rn "GATEWAY_MIN_RM\b" backend/packages/api/src` → no matches
- [ ] `grep -c "RSA\|PBKDF2\|payout-verify" backend/packages/api/src/api/utils/rate-limit.ts` → `0`
- [ ] `grep -c "Both metadata writers" backend/packages/api/src/api/store/referral/route.ts` → `0`
- [ ] `cd backend && corepack yarn check-types && corepack yarn lint` exit 0; `cd backend/packages/api && corepack yarn test:unit` exit 0
- [ ] `git status --porcelain` lists only in-scope files; `git diff --stat` shows **no** `.do/`, `models/`, or `tgpay-setup.md` hunk

## STOP conditions

Stop and report back (do not improvise) if:

- The Read tool cannot open `backend/packages/api/.env.template` (a hook
  in your environment also blocks tool reads) — report; do not try the shell.
- `GATEWAY_WD_MIN_RM` / `GATEWAY_WD_MAX_RM` / `GATEWAY_MIN_RM` **are**
  referenced somewhere the advisor's grep missed — keep and re-comment,
  never delete a referenced money constant.
- Row 5 of the security checklist has already been rewritten (someone got
  there first) — reconcile, do not duplicate.
- The `PHONE_OTP_` block is absent from the template (the anchor for Step 1) — place the flags in the Twilio/phone section instead and say where.

## Maintenance notes

- Two operator items this plan cannot do, recorded in the round-15 README
  section: (a) declare `GATEWAY_WD_APPROVAL_ABOVE_RM` and
  `GATEWAY_WD_DAILY_MAX_RM` explicitly in `.do/backend.app.yaml` so the
  payout guardrails are policy, not code defaults (DX-03); (b) decide whether
  `channel: 'call'` should be refused for `purpose: 'password-reset'`
  (SECURITY-02).
- Round 14 finding 8 (Mercur collision-repair migration untested), 18
  (settlement status unions hand-copied into admin) and 19 (destructive
  `down()` guards unspecced) are still true at HEAD and still unplanned.
- The security checklist's "Already settled" table now has two rows citing
  a deleted file with the same annotation; a future docs round may collapse
  rows 5–13 into a "GlobePay era (retired 2026-09-07)" sub-table.
