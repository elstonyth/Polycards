# Security Verification Checklist — the controls code cannot enforce

**Status:** open. Every item below is a question this repository **cannot answer**,
because the answer lives in a third-party console (Twilio, GlobePay365) or in the
running production environment. Nothing here is answered by reading the code.

**Written:** 2026-08-07, at commit `db2767f5`, out of the round-10 security audit.
Referenced plans **083, 084, 086, 090** were all status **TODO** in `plans/README.md`
at the time of writing (rows at `plans/README.md:1635`, `:1636`, `:1638`, `:1642`).

**Why it exists:** each of these questions changes how severe a code-level finding
is. The audit's arithmetic assumes documented defaults; a different console setting
moves some answers by two orders of magnitude. Left in an audit transcript they get
re-derived every round.

---

## How to use this

Work top to bottom. For each item, record the answer **inline, in the item, with the
date you checked** — the same habit the neighbouring runbooks use, where the evidence
a step produced matters as much as the step. An answered item is **not deleted**: move
it to "Already settled" below with its date and source, so the next auditor knows it
was checked and when.

Re-run the whole list at the start of each audit round. **This document goes stale by
design** — its answers are third-party console state and change without a commit.

Two standing rules:

- **No credential values in this file.** Name `TWILIO_VERIFY_SERVICE_SID` and every
  `GLOBEPAY_*` key as a variable, never its value. The same goes for service SIDs,
  merchant codes, and profile identifiers when you record an answer.
- **Do not write an answer you inferred.** An open question is useful; a confidently
  wrong one is worse than none. If you did not read it in a console, leave it open.

---

## Already settled in the repo

Harvested before the questions were written, so nobody re-answers what is recorded.
Every row below is already written down **in this repository** and carries its
`file:line`. None was obtained by opening a console for this checklist — where a row
does record a past console observation (#2), it is cited to the file that recorded it
and carries the date it was observed.

| # | Fact | Citation |
| --- | --- | --- |
| 1 | Our OTP check route accepts **any 4–10 digit** code: `/^\d{4,10}$/`. A short code configured upstream would be accepted here without complaint — this is what makes item **A** load-bearing. | `backend/packages/api/src/api/store/phone-verification/check/route.ts:24` |
| 2 | Malaysia (`+60`) **was** enabled in SMS geo permissions, observed during the 2026-08-07 outage triage. What **else** is enabled is unrecorded — that is the open half of item **B**. | `CONTEXT.md:188` |
| 3 | Twilio failure logs carry the numeric error code beside the HTTP status, so a compliance block, a geo block and a Fraud Guard hit are distinguishable **without** a console session. | `CONTEXT.md:200` |
| 4 | Diagnosis order if OTP breaks again: compliance profile → account type/balance → destination geo permission. All three sit upstream of every feature flag. | `CONTEXT.md:194-198` |
| 5 | The RSA callback signature is the **only** gate on the deposit hook — source-IP allowlisting was deliberately rejected (DO's LB hides their address). Nothing backstops a signature that verifies, which is what makes item **C** load-bearing. | `docs/payments/globepay365-setup.md:310-317` |
| 6 | Key **direction** is settled: outbound requests are signed with our merchant private key, inbound callbacks verified with GlobePay's public key (`GLOBEPAY_PUBLIC_KEY`). Key **scoping** — one platform key or one per merchant — is not stated anywhere. | `docs/payments/globepay365-setup.md:26-28`, `:38` |
| 7 | Only the `Data` object is covered by the signature; `TransactionId`, `MerchantTransactionId` and `Version` sit outside it and are mutable on an otherwise-genuine body. | `docs/payments/globepay365-setup.md:180-190` |
| 8 | `PMT10016` is the **documented** not-found code, but staging returned a bare 400 "Not found" **without** it. Both sweeps therefore treat any 400 as not-found. Partial answer to item **D**; what an **auth** failure returns is unrecorded. | `backend/packages/api/src/jobs/globepay-reconcile.ts:69-74`, `docs/payments/globepay365-setup.md:203` |
| 9 | Known error codes: `PMT10005` amount out of range, `PMT10024` payment-method routing gap, `PMT10000` duplicate merchant transaction id. None of these is an authentication failure. | `docs/payments/globepay365-setup.md:222`, `:239-242`, `backend/packages/api/src/modules/packs/models/globepay-deposit.ts:19-21` |
| 10 | Live deposit band is RM 30 – RM 10,000; payout band RM 50 – RM 50,000. Confirmed by the provider 2026-07-29, but nobody has submitted either ceiling against the live account. | `docs/payments/globepay365-setup.md:391-417` |
| 11 | The prod spec sets `PHONE_VERIFICATION_REQUIRED` only; `PHONE_GATE_REQUIRED` is deliberately **unset** and therefore follows it. So item **E** is one resolved value plus a confirmation that the second is still absent. | `.do/backend.app.yaml:235`, `:243` |
| 12 | `CONTEXT.md:175` records the OTP as valid for **10 minutes**. Treat this as **unconfirmed**: the same sentence attributes the six-digit length to "Twilio's own default", so the TTL is most likely the documented default rather than a reading of our service. Item **A** still asks for it. | `CONTEXT.md:175` |
| 13 | Alerting on a deposit pending past its window is **not built**. The admin Deposits page shows it; someone has to look. Both of plan 084's loud log lines are still only log lines. | `docs/payments/globepay365-setup.md:388-389` |

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

> **Answer:** _(open)_

---

## B. Twilio SMS geo permissions

**Question.** Which destination countries are enabled for SMS on the account, and is
**Fraud Guard** on?

**Why it matters.** Plan 086 (TODO) adds a code-side destination allowlist; this is
the upstream half. It is the difference between an unauthenticated endpoint reaching
~7,200 billable destinations/day and reaching only the served market. Malaysia is
known enabled (settled #2); the rest of the list is not. `CONTEXT.md:236` instructs an
operator to turn Fraud Guard on — that is an instruction, **not** evidence it is on.

**Where to look.** Twilio Console → Messaging → Settings → Geo Permissions for the
enabled list; Verify → the service → Fraud Guard toggle. Settled #3 means a geo block
is also visible in our own failure logs without a console session.

**Record.** The enabled country list, the Fraud Guard state, and the date. If the list
is wider than the allowlist plan 086 ships, say so explicitly — the two are a pair.

> **Answer:** _(open)_

---

## C. GlobePay365 callback key scoping

**Question.** Does GlobePay sign callbacks with a **platform-wide** key, or with a key
scoped to **our** merchant account?

**Why it matters.** It decides whether the `MerchantCode` check added by plan 083
(TODO) is defence-in-depth or the only thing preventing a credit for money that landed
in someone else's merchant account. If the key is platform-wide, a callback describing
a payment into a different merchant would verify against our configured
`GLOBEPAY_PUBLIC_KEY` — and the signature is our only gate (settled #5).

**Where to look.** Ask the provider directly; it is not derivable from the protocol
docs, and settled #6 records that the repo states the key's direction but never its
scoping. Do not infer it from the fact that we uploaded a per-merchant public key for
the **outbound** direction — the two directions are independent.

**Record.** The answer, **who** at the provider gave it, and the date. A name matters
here: this one is a verbal answer with no artifact behind it.

> **Answer:** _(open)_

---

## D. GlobePay365 error taxonomy

**Question.** Does a requery for a transaction that genuinely does not exist return a
**distinguishable** code (`PMT10016` or otherwise)? And what does an
authentication / merchant-code failure return?

**Why it matters.** Both reconcile sweeps decide "write this off" / "refund this" from
a bare HTTP 400. Plan 084 (TODO) makes the ambiguous case conservative; a confirmed
taxonomy would let it be **precise** instead, which is the difference between a sweep
that waits and one that acts. Settled #8 records the contradiction driving this: the
documented code is not the one staging returned.

**Where to look.** Ask the provider for the refusal taxonomy. Failing that, the
`CheckBalance` probe (`docs/payments/globepay365-setup.md:247-253`) exercises the whole
auth chain read-only — a deliberately wrong merchant code against it would show what an
auth failure looks like, **but that is a live-account probe and an operator decision,
not something to run casually.**

**Record.** The HTTP status **and** response body for both cases: genuine not-found,
and auth/merchant-code failure. Note the date and which environment.

> **Answer:** _(open)_

---

## E. Live environment flag state

**Question.** Do `PHONE_VERIFICATION_REQUIRED` and `PHONE_GATE_REQUIRED` resolve to
the intended values in the **running** production app — not just in the `.do` spec?

**Why it matters.** The parse is a strict `=== 'true'`, so unset, empty, `'True'`,
`'1'`, or a misspelled key all resolve to **false** and silently open every gate,
including the money gates. The flags live in two `.do` specs plus a `Dockerfile` build
ARG (`.do/backend.app.yaml:243`, `.do/storefront.app.yaml:170`, `Dockerfile:84`), and
were flipped off and back on during the 2026-08-07 Twilio incident (commits `3e36a623`
/ `db2767f5`). A partially-applied spec or a rebuild that missed the ARG would not
show up anywhere.

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
(`backend/packages/api/src/jobs/globepay-reconcile.ts:145-150`). Plan 084 (TODO) stops
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
from globepay_deposit
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

## Maintenance notes

- **Answered items move up, they do not disappear.** The next auditor needs to know a
  question was checked and when — a deleted item reads as a question nobody asked.
- **Dates are the point.** An undated answer to a console question is indistinguishable
  from a guess a year later.
- Items **A**, **B** and **E** gate how the phone-OTP findings are scored; **C**, **D**
  and **G** gate the GlobePay ones. If an audit round starts before these are answered,
  score those findings at their **worst** plausible reading, not their best.
- A reviewer of this file should check two things: that no item asserts an answer
  nobody verified, and that no credential value has been recorded into an
  "Answer:" line.
