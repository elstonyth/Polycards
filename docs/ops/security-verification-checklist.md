# Security Verification Checklist — the controls code cannot enforce

**Status:** open. Every item in A–G is a question this repository **cannot answer**,
because the answer lives in a third-party console (Twilio) or in the
running production environment. Nothing there is answered by reading the code.

**Written:** 2026-08-07, at commit `db2767f5`, out of the round-10 security audit.
Referenced plans **083, 084, 086, 090** were all status **TODO** in `plans/README.md`
at the time of writing. Those plan files were not yet committed when this was
written, so a reader on a fresh clone may not find them — check the branch that
carries them before concluding a reference is dangling.

**Why it exists:** each of these questions changes how severe a code-level finding
is. The audit's arithmetic assumes documented defaults; a different console setting
moves some answers by two orders of magnitude. Left in an audit transcript they get
re-derived every round.

---

## How to use this

Work top to bottom. Answering an item is **two sequential steps**, not a choice
between them:

1. **Record it in place.** Replace that item's `> **Answer:** _(open)_` line with the
   answer and the date you checked. The item keeps its full context — the question,
   why it matters, and what you were asked to record — the same habit the
   neighbouring runbooks use, where the evidence a step produced matters as much as
   the step.
2. **Then copy the one-line fact up** into "Already settled" with its date and
   source. The item itself is **never deleted**, so the next auditor can see both the
   summary and the reasoning behind it.

Re-run the whole list at the start of each audit round. **This document goes stale by
design** — its answers are third-party console state and change without a commit.

Two standing rules:

- **No credential values in this file.** Name `TWILIO_VERIFY_SERVICE_SID` and every
  `GATEWAY_*` key as a variable, never its value. The same goes for service SIDs,
  merchant codes, and profile identifiers when you record an answer.
- **Do not write an answer you inferred.** An open question is useful; a confidently
  wrong one is worse than none. If you did not read it in a console, leave it open.

---

## Already settled in the repo

Rows 1–13 were harvested before the questions were written, so nobody re-answers what
is already recorded. As items A–G get answered, their one-line facts join this table.

**Every row is one of two kinds, and must say which:**

- **In-repo** — the fact is written down somewhere in this repository. Citation is a
  `file:line`. Source reads `in-repo`; Date is `—` unless the cited text itself
  carries one.
- **Console-observed** — the fact came from a third-party console or a person.
  There is no `file:line` to give, so Citation reads `—`, **Date and Source are
  mandatory**, and Source names who observed or supplied it.

Do not put a console answer in an `in-repo` row. The distinction is the whole value of
this table: it tells the next auditor which facts they can re-check by reading, and
which they must go and ask about again.

| # | Fact | Citation | Date | Source |
| --- | --- | --- | --- | --- |
| 1 | Our OTP check route accepts **any 4–10 digit** code: `/^\d{4,10}$/`. A short code configured upstream would be accepted here without complaint — this is what makes item **A** load-bearing. | `backend/packages/api/src/api/store/phone-verification/check/route.ts:24` | — | in-repo |
| 2 | Malaysia (`+60`) **was** enabled in SMS geo permissions, observed during the 2026-08-07 outage triage. What **else** is enabled is unrecorded — that is the open half of item **B**. | `CONTEXT.md:188` | 2026-08-07 | in-repo (outage triage) |
| 3 | Twilio failure logs carry the numeric error code beside the HTTP status, so a compliance block, a geo block and a Fraud Guard hit are distinguishable **without** a console session. | `CONTEXT.md:200` | — | in-repo |
| 4 | Diagnosis order if OTP breaks again: compliance profile → account type/balance → destination geo permission. All three sit upstream of every feature flag. | `CONTEXT.md:194-198` | — | in-repo |
| 5 | The RSA callback signature is the **only** gate on the deposit hook — source-IP allowlisting was deliberately rejected (DO's LB hides their address). Nothing backstops a signature that verifies. | `docs/payments/globepay365-setup.md:310-317` (removed 2026-09-07; see git history) | — | in-repo |
| 7 | Only the `Data` object is covered by the signature; `TransactionId`, `MerchantTransactionId` and `Version` sit outside it and are mutable on an otherwise-genuine body. | `docs/payments/globepay365-setup.md:180-190` (removed 2026-09-07; see git history) | — | in-repo |
| 8 | `PMT10016` is the **documented** not-found code, but staging returned a bare 400 "Not found" **without** it. Both sweeps therefore treat any 400 as not-found. | `backend/packages/api/src/jobs/deposit-reconcile.ts:69-74`, `docs/payments/globepay365-setup.md:203` (removed 2026-09-07; see git history) | — | in-repo |
| 9 | Known error codes: `PMT10005` amount out of range, `PMT10024` payment-method routing gap, `PMT10000` duplicate merchant transaction id. None of these is an authentication failure. | `docs/payments/globepay365-setup.md:222`, `:239-242` (removed 2026-09-07; see git history), `backend/packages/api/src/modules/packs/models/gateway-deposit.ts:19-21` | — | in-repo |
| 10 | Live deposit band is RM 30 – RM 10,000; payout band RM 50 – RM 50,000. Confirmed by the provider 2026-07-29, but nobody has submitted either ceiling against the live account. | `docs/payments/globepay365-setup.md:391-417` (removed 2026-09-07; see git history) | 2026-07-29 | in-repo (provider) |
| 11 | The prod spec sets `PHONE_VERIFICATION_REQUIRED` only; `PHONE_GATE_REQUIRED` is deliberately **unset** and therefore follows it. So item **E** is one resolved value plus a confirmation that the second is still absent. | `.do/backend.app.yaml:235`, `:243` | — | in-repo |
| 12 | `CONTEXT.md:175` records the OTP as valid for **10 minutes**. Treat this as **unconfirmed**: the same sentence attributes the six-digit length to "Twilio's own default", so the TTL is most likely the documented default rather than a reading of our service. Item **A** still asks for it. | `CONTEXT.md:175` | — | in-repo |
| 13 | Alerting on a deposit pending past its window is **not built**. The admin Deposits page shows it; someone has to look. Both of plan 084's loud log lines are still only log lines. | `docs/payments/globepay365-setup.md:388-389` (removed 2026-09-07; see git history) | — | in-repo |

---

## A. Twilio Verify service configuration

**Question.** On the Verify service named by `TWILIO_VERIFY_SERVICE_SID`: what are the
**code length**, the **code TTL**, and the **max check attempts per verification**?

**Why it matters.** The per-phone limiter allows 30 checks / 24 h
(`CONTEXT.md:219`). Against a 6-digit code that is 30/10⁶ ≈ 3×10⁻⁵ per day; against a
**4-digit** code it is 30/10⁴ = 0.3% — two orders of magnitude apart. Our own check
route accepts any 4–10 digit code (settled #1), so a short service configuration
would not be rejected anywhere in our stack.

**Where to look.** Twilio Console → Verify → Services → the service → General
settings. Code length and TTL are on that page; max attempts is on the same service's
rate-limit / settings panel.

**Record.** The three values and the date checked. Name the service by variable, not
by SID.

> **Answer (2026-09-07, Twilio One Console → the service named by
> `TWILIO_VERIFY_SERVICE_SID` → Settings):** code length **6**; code TTL **10 minutes**
> (Twilio-fixed — every logged verification expires exactly 10 min after creation);
> max check attempts is not exposed on the settings page and is Twilio's fixed
> **5 per verification** (their documented Verify limit). Custom code off, default
> template, "Do not share" warning off. Voice channel enabled the same day for the
> `call` fallback (see CONTEXT.md, 2026-09-07); WhatsApp channel disabled.

---

## B. Twilio SMS geo permissions

**Question.** Which destination countries are enabled for SMS on the account, and is
**Fraud Guard** on?

**Why it matters.** Plan 086 (TODO) adds a code-side destination allowlist; this is
the upstream half. It is the difference between an unauthenticated endpoint reaching
~7,200 billable sends/day and reaching only the served market. Malaysia is
known enabled (settled #2); the rest of the list is not. `CONTEXT.md:236` instructs an
operator to turn Fraud Guard on — that is an instruction, **not** evidence it is on.

**Where to look.** Twilio Console → Messaging → Settings → Geo Permissions for the
enabled list; Verify → the service → Fraud Guard toggle. Settled #3 means a geo block
is also visible in our own failure logs without a console session.

**Record.** The enabled country list, the Fraud Guard state, and the date. If the list
is wider than the allowlist plan 086 ships, say so explicitly — the two are a pair.

> **Answer (2026-09-07):** SMS geo permissions enable **Malaysia (+60) only** (237
> destinations listed, one checked). Fraud Guard is **on**; the Blocked Verifications
> log shows 0 in 30 days. This matches the code-side allowlist
> (`ALLOWED_SMS_COUNTRIES=MY`) exactly. Voice geo permissions are a SEPARATE list and
> were empty until the `call` fallback needed Malaysia enabled there the same day.

---

## E. Live environment flag state

**Question.** Do `PHONE_VERIFICATION_REQUIRED` and `PHONE_GATE_REQUIRED` resolve to
the intended values in the **running** production app — not just in the `.do` spec?

**Why it matters.** The parse is a strict `=== 'true'`
(`backend/packages/api/src/utils/phone-verification.ts:29-30`), so unset, empty,
`'True'`, `'1'`, or a misspelled key all resolve to **false** and silently open every
gate, including the money gates. The backend flag lives in the backend spec
(`.do/backend.app.yaml:243`), plus a storefront `NEXT_PUBLIC_` mirror in a second spec
and a `Dockerfile` ARG (`.do/storefront.app.yaml:170`, `Dockerfile:84`). They were
flipped off and back on during the 2026-08-07 Twilio incident (commits `3e36a623` /
`db2767f5`). A partially-applied spec or a rebuild that missed the ARG would not show
up anywhere.

**Where to look.** Once plan 090 (TODO) lands, read the `[phone-gate]` boot log line
in the deploy log — that is the whole point of it. Until then: the app's Environment
Variables in the DO console. Confirm `PHONE_GATE_REQUIRED` is still **absent** rather
than set to something non-`'true'` (settled #11) — absent is the intended state, and
absent and misspelled look identical from the spec alone.

**Record.** The two resolved values, whether they came from the boot log or the
console, and the date. The storefront's `NEXT_PUBLIC_` flag is UX-only; note it
separately if it has drifted.

> **Answer:** _(open)_

---

## F. Proxy trust

**Question.** Does `req.ip` resolve to the **actual client IP** in production, and how
many proxy hops are actually in front of the backend?

**Why it matters.** Medusa hardcodes Express `trust proxy` to `1` with no config knob —
correct behind **exactly one** proxy. Both failure modes and their fixes are already
written down in `backend/packages/api/.env.template:11-21` (PROD CHECKLIST item 4);
read it there rather than restating it here. Either mode degrades the per-IP limiter,
which is the sitewide SMS-spend circuit breaker backing items A and B.

**Where to look.** The template item ends with the instruction that matters: *verify
`req.ip` resolves to the actual client IP at deploy.* Count the real hops in the DO app
architecture (LB, and any CDN in front of it), then compare against a `req.ip` observed
in production request logs.

**Record.** The real hop count, the `req.ip` value observed for a known client, and
whether an override was needed. Date it.

> **Answer:** _(open)_

---

## G. Deposits that may have been written off in error

**Question.** Which closed deposits may in fact have been **paid** by the customer?

**Why it matters.** The sweep writes `status: 'failed'` for both "the gateway said no"
and "too old to keep chasing", then scans `pending` only — so an expired-but-live
deposit is never looked at again
(`backend/packages/api/src/jobs/deposit-reconcile.ts:145-150`). Plan 084 (TODO) stops
**new** rows entering this state; it deliberately does **not** backfill, because
deciding which historical rows to re-open is an operator call. This query finds them.

**Where to look.** Production Postgres, read-only. **Do not run this as part of
working through the checklist** — it is recorded here so the operator has it when they
decide to look.

```sql
-- READ-ONLY. Deposits closed by the sweep that a customer may in fact have paid:
-- SubmitDeposit took (they had a cashier page), nothing was ever credited, and the
-- gateway never returned a final failure (7 = fail).
select id, merchant_transaction_id, gateway_transaction_id, customer_id,
       amount_requested, gateway_status, created_at
from gateway_deposit
where status = 'failed'
  and amount_settled is null
  and gateway_transaction_id is not null
  and (gateway_status is null or gateway_status <> 7)
  and deleted_at is null
order by created_at desc;
```

`gateway_transaction_id is not null` is the same discriminator plan 084 adds to
`unknownDepositAction` — a row carrying one provably exists on their side, so a 400
requery was our config breaking, never non-existence. **After plan 084 lands this query
needs `status in ('failed', 'expired')`**, since expiry gets its own non-terminal
status there.

**Record.** The row count, and for each row the operator's decision (requery, credit,
leave). Date it. A zero count is a result worth recording too.

> **Answer:** _(open)_

---

## H. Withdrawals stranded by the plan-084 narrowing

**Question.** What should happen to a payout whose requery only ever returns an
**unattributable** 400 — where the customer's credits are already debited and nothing
will ever refund them automatically?

**Why it matters.** Plan 084 narrowed both sweeps so that only an explicit `PMT10016`
authorises the unknown-transaction path
(`backend/packages/api/src/modules/packs/gateway-reconcile.ts`,
`classifyRequeryError`). That was the right call — the alternative refunds every
in-flight payout the moment a merchant credential breaks, while the banks still execute
them. But the gateway's real not-found is a plain-text 400
carrying **no** code (`docs/payments/globepay365-setup.md:124`, removed 2026-09-07; see
git history), so on the live gateway
`PMT10016` may never arrive at all. That makes the unknown path effectively unreachable,
and the two sides are no longer symmetric:

- **Deposits survive it.** `expire` is still reachable from the ordinary non-final
  requery path, and plan 084 built the machinery around it: a non-terminal `expired`
  status, a bounded second scan tier that keeps requerying, an admin view and a badge,
  and an ageing bound (`ambiguousRefusalAction`) so endlessly-ambiguous rows leave the
  live queue instead of starving it.
- **Withdrawals got the narrowing with none of the machinery.** There is deliberately
  no `expire` for a payout — "expiring" one would confiscate a debit — so an ambiguous
  refusal resolves to `wait`, forever. The affected population is precisely the one the
  refund is **definitely owed** to: `SubmitWithdrawal` timed out, so the row carries no
  `gateway_transaction_id` and the crash-recovery refund was the only thing that would
  ever return the customer's money. Today those rows accumulate in the sweep's
  50-row oldest-first window (starving it exactly as the deposit zombies would have),
  emit a `logger.error` every ten minutes that nothing pages on, and appear on **no**
  operator surface — `/admin/payments/withdrawals` has no view for them.

**Proposed shape (NOT built — this needs its own plan).** A `needs_review` withdrawal
status, reached after a bounded age of nothing but ambiguous refusals, that is
explicitly **not** a refund and **not** a closure: it takes the row out of the live
queue, gives an operator a list to work, and leaves the refund decision to a human who
can check the bank. Mirrors the deposit side's `expired` without ever implying the
payout did not happen. Needs the status, a migration, an admin view and a badge.

**Where to look.** A confirmed not-found code from the active gateway would make the
unknown path reachable again and shrink this to a much smaller problem. Failing that,
count the population in production:

```sql
-- READ-ONLY. Payouts the sweep can no longer resolve on its own: debited, still
-- pending, no gateway id (so SubmitWithdrawal never returned), and older than any
-- plausible in-flight submit.
select id, merchant_transaction_id, customer_id, amount, created_at
from gateway_withdrawal
where status = 'pending'
  and gateway_transaction_id is null
  and created_at < now() - interval '1 day'
  and deleted_at is null
order by created_at asc;
```

**Record.** The row count and the total RM in limbo. A zero count is worth recording —
it says the narrowing cost nothing in practice and this can stay unbuilt.

> **Answer:** _(open)_

---

## I. The phone-change route is a faster password oracle than the login route

**Not a console question.** Unlike A–H, this one is answerable by reading this
repository, and it is recorded here because the answer is a **design decision nobody
has made yet**, not a fact nobody has looked up. Do not wait on a third party for it.

**Question.** Should `POST /store/phone-verification/change` — which now verifies a
password — carry a per-credential brute-force budget, and what should key it?

**Why it matters.** Plan 080 added a re-auth gate to that route: for an account with an
emailpass identity it calls `authService.authenticate('emailpass', …)` with a password
from the request body. That makes it a **password-testing endpoint**, but it is still
wired to the authed write tier, which was sized for delivery orders and avatar
uploads:

| Route | Limiter | Budget | Keyed on |
| --- | --- | --- | --- |
| `/auth/customer/emailpass` | `authIdentifierRateLimit` + `authRateLimit` | 5 / 60 s, 20 / 1 h | the **email** in the body |
| `/store/phone-verification/change` | `deliveryWriteRateLimit` | 10 / 10 s, 30 / 60 s | `auth_context.actor_id` |

30 guesses/minute versus 20 guesses/hour is **90× more throughput against the same
credential** on the route that was never meant to test one. The attacker model is
narrower than it looks — the change route sits behind `authenticate('customer',
['bearer'])`, so a guesser needs a valid session for the account whose password they
are guessing — but that is exactly the plan-080 threat: a stolen session that wants
the password in order to make the takeover permanent. The gate is what stops it, and
the gate is currently cheap to grind.

**Why the obvious reuse does not work.** Putting `authIdentifierRateLimit` on the
matcher fails *silently* rather than loudly, which is worse than not wiring it:

- It keys on `emailBodyKeyOf` (`api/utils/rate-limit.ts:522`), which reads an **email
  from the request body**. The change body is `{ phone, token, password,
  old_phone_token }` — no email. The account's email is on the customer row, reached
  by a `retrieveCustomer` the route already does and a middleware would have to
  duplicate.
- With no key extracted, `skipWhenNoKey: true` (`:792`) makes the limiter **skip the
  route entirely**. Wiring it would look like hardening and would add none — the
  matcher would read as protected to anyone scanning `middlewares.ts`.

Dropping `skipWhenNoKey` is not the fix either: that flag exists because the `/auth/*`
wildcard also covers the identifier-less emailpass `update` route, where falling back
to `ip:` turns a per-account budget into a sitewide ceiling.

**Proposed shape (NOT built — this needs its own plan).** A small per-actor
**credential-attempt** limiter, distinct from the write tier, wired to the change route
*alongside* `deliveryWriteRateLimit` rather than replacing it. `actor_id` is the right
key here and needs no body parsing: the session is already authenticated, and one
session grinding one account is precisely the threat. Budget on the order of the auth
tier (single digits per minute, low tens per hour) — a human changing their phone
number enters their password once, maybe twice. Worth checking in the same plan
whether any other route has quietly become a credential check since it was wired.

**Where to look.** `backend/packages/api/src/api/middlewares.ts` (the change and
auth matchers), the `auth-identifier` and `delivery-write` entries in
`backend/packages/api/src/api/utils/rate-limit.ts`, and the gate itself in
`backend/packages/api/src/api/store/phone-verification/change/route.ts`.

**Record.** The decision — build it, or accept the 90× with the reason why (the
bearer-token precondition is a legitimate argument for accepting it). If accepted, say
so in `middlewares.ts` at the matcher, so the next auditor does not re-raise it.

> **Answer:** _(open)_

---

## Maintenance notes

- **Answered items move up, they do not disappear.** The next auditor needs to know a
  question was checked and when — a deleted item reads as a question nobody asked.
- **Dates are the point.** An undated answer to a console question is indistinguishable
  from a guess a year later.
- Items **A**, **B** and **E** gate how the phone-OTP findings are scored; **G** and
  **H** gate the payment-gateway ones. If an audit round starts before these are
  answered, score those findings at their **worst** plausible reading, not their best.
- A reviewer of this file should check two things: that no item asserts an answer
  nobody verified, and that no credential value has been recorded into an
  "Answer:" line.
