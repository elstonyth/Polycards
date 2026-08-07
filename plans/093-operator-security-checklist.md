# Plan 093: Write the operator security checklist for the controls code cannot enforce

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **This plan produces a document, not code.** You are writing down questions
> and procedures, not answering the questions — the answers live in third-party
> consoles the repo cannot read. Do not guess an answer and write it as fact.
>
> **Drift check (run first)**:
> `git diff --stat db2767f5..HEAD -- docs/ops docs/payments CONTEXT.md`
> On any mismatch with the "Current state" notes, re-read the affected doc
> before proceeding.

## Status

- **Priority**: P3
- **Effort**: S–M
- **Risk**: LOW
- **Depends on**: none (but its content references plans 083, 084, 086 — cite
  them by number and state their status at the time of writing)
- **Category**: docs
- **Planned at**: commit `db2767f5`, 2026-08-07

## Why this matters

The round-10 security audit ended with a set of questions that **cannot be
answered by reading this repository**, each of which changes how severe a
code-level finding is:

- Twilio Verify's per-service settings (code length, TTL, max attempts per
  verification) determine how strong the OTP actually is. The audit's
  brute-force arithmetic assumes the documented defaults; a 4-digit
  configuration would change the answer by two orders of magnitude.
- Twilio's SMS **geo permissions** determine whether the destination-allowlist
  work in plan 086 is closing a live hole or a theoretical one. `CONTEXT.md`
  records that Malaysia was enabled and records nothing about what else is.
- Whether GlobePay365 signs callbacks with a **platform-wide** key or a
  **per-merchant** key decides whether the missing `MerchantCode` check (plan 083) is defence-in-depth or a real path to credit without money arriving.
- Whether GlobePay's HTTP 400 distinguishes not-found from an auth failure
  decides how tight plan 084's not-found test can safely be.
- Whether `PHONE_VERIFICATION_REQUIRED` and `PHONE_GATE_REQUIRED` are actually
  `'true'` in the live environment — the repo's `.do` specs say so, but a
  partially-applied spec or a rebuild that missed the `Dockerfile` ARG would
  not show up anywhere. (Plan 090 adds a boot log; until it lands, this is a
  console check.)

Right now these live only in an audit transcript. A checklist in `docs/ops/`
turns them into something an operator can work through, and something the next
audit round can read instead of re-deriving.

## Current state

- `docs/ops/` holds runbooks:
  `production-reset-and-golive-runbook.md`,
  `infra-rename-migration-runbook.md`,
  `vip-voucher-amounts-before-2026-08-05.md`.
  **Read at least the go-live runbook before writing** — match its heading
  style, its checkbox convention, and its habit of recording the _evidence_ a
  step produced, not just the step.
- `docs/payments/globepay365-setup.md` is the existing gateway doc. Read it —
  some of the GlobePay questions below may already be answered there, and a
  question with an answer in the repo does not belong on an operator
  checklist.
- `docs/adr/` holds decisions (0001–0005). This document is **not** an ADR — it
  records open questions and verification procedures, not a decision.
- `CONTEXT.md` carries the phone-verification cutover notes.
- `.env.template` already records the proxy-trust question as a prod-checklist
  item — read it and fold that item in rather than duplicating it.

## Commands you will need

| Purpose                                          | Command                                              | Expected on success |
| ------------------------------------------------ | ---------------------------------------------------- | ------------------- |
| Storefront format check (covers `docs/`? verify) | `npm run format:check`                               | exit 0              |
| Markdown sanity                                  | none — no markdown linter is configured in this repo | —                   |

Confirm whether Prettier's `format:check` covers `docs/` in this repo before
assuming it does: `npm run format:check` scopes to `src scripts` per
`package.json`. If `docs/` is not covered, note that and format by hand to
match the neighbouring runbooks.

## Scope

**In scope**:

- `docs/ops/security-verification-checklist.md` (create)
- A pointer line from `docs/payments/globepay365-setup.md` to the new file
- `plans/README.md` (status row)

**Out of scope**:

- Any code change.
- Actually contacting Twilio or GlobePay, or logging into either console.
- Answering the questions. If you happen to find an answer **in the
  repository**, write it in with its `file:line` citation and move the item to
  a "settled" section — but do not infer, and do not fetch anything external.
- Editing `CONTEXT.md` or the ADRs.

## Git workflow

- Branch: `advisor/093-operator-security-checklist`
- Conventional commit, e.g.
  `docs(ops): security verification checklist for console-side controls`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Harvest what the repo already answers

Before writing a single question, grep for an existing answer:

```
grep -rn "Verify\|verify service\|VA9\|geo\|permission" docs/payments docs/ops CONTEXT.md
grep -rn "TWILIO_" .env.template .do/backend.app.yaml
grep -rn "PMT10016\|httpStatus === 400" backend/packages/api/src
```

Anything already documented goes into a **"Already settled in the repo"**
section with its citation, not into the open-questions list. A checklist that
asks an operator to re-answer something the repo records is noise.

**Verify**: you can state which of the five question areas already have partial
answers in-repo.

### Step 2: Write the checklist

Create `docs/ops/security-verification-checklist.md` with these sections.
Each item must state: **the question**, **why it matters** (one sentence,
naming the plan or code path it affects), **exactly where to look**, and
**what to record afterwards**.

**A. Twilio Verify service configuration**

- Code length, code TTL, max check attempts per verification, on the Verify
  service used by `TWILIO_VERIFY_SERVICE_SID`.
- Why: the per-phone limiter allows 30 checks/24h; combined with a 6-digit
  code that is ~3×10⁻⁵ per day, but a 4-digit code makes it ~0.3%.
- Record: the three values and the date checked.

**B. Twilio SMS geo permissions**

- Which destination countries are enabled for SMS on the account.
- Why: plan 086 adds a code-side destination allowlist; this is the upstream
  half, and it is the difference between an unauthenticated endpoint being
  able to text ~7,200 destinations/day and only the served market.
- Record: the enabled list and whether Fraud Guard is on.

**C. GlobePay365 callback key scoping**

- Does GlobePay sign callbacks with a platform-wide key or a key scoped to our
  merchant account?
- Why: it decides whether the `MerchantCode` check added by plan 083 is
  defence-in-depth or the thing preventing a credit for money that landed in
  someone else's merchant account.
- Record: the answer, who at the provider gave it, and the date.

**D. GlobePay365 error taxonomy**

- Does a requery for a transaction that genuinely does not exist return a
  distinguishable code (`PMT10016` or otherwise), and what does an
  authentication/merchant-code failure return?
- Why: both reconcile sweeps decide "write this off" / "refund this" from an
  HTTP 400; plan 084 makes the ambiguous case conservative, but a confirmed
  taxonomy would let it be precise.
- Record: the status codes and bodies for both cases.

**E. Live environment flag state**

- Confirm `PHONE_VERIFICATION_REQUIRED` and `PHONE_GATE_REQUIRED` resolve to
  the intended values in the running production app, not just in the `.do`
  spec.
- Why: the parse is strict `=== 'true'`, so any other value silently opens
  every gate; the flags live in two specs plus a `Dockerfile` build ARG, and
  were flipped off and back on during the 2026-08-07 Twilio incident
  (commits `3e36a623` / `db2767f5`).
- How: once plan 090 lands, read the boot log line. Until then, check the app's
  environment in the DO console.
- Record: the resolved values and the date.

**F. Proxy trust**

- Fold in the existing `.env.template` item about Medusa's hardcoded
  `trust proxy` 1 and both of its failure modes. Cite the template rather than
  restating it.

**G. Deposits that may have been written off in error**

- The query to find deposits closed by the sweep that a customer may in fact
  have paid, for the operator to review. Write the query but **mark it
  read-only and do not run it**. Cross-reference plan 084, which stops new
  rows entering this state.

Close the document with a short "how to use this" note in the style of the
neighbouring runbooks: work top to bottom, record evidence inline with dates,
and re-run before each audit round.

**Verify**: the file exists, every item has all four required parts, and no
item asserts an answer you did not find in the repo.

### Step 3: Cross-link

Add one pointer line at the top of `docs/payments/globepay365-setup.md`
directing a reader to the new checklist for the console-side questions. Do not
restructure that document.

**Verify**: `grep -n "security-verification-checklist" docs/payments/globepay365-setup.md`
returns a match.

## Test plan

No automated tests — this is a document. The verification is structural:

- Every item has: question, why-it-matters, where-to-look, what-to-record.
- No item states an answer without a `file:line` citation from this repo.
- Every plan number referenced (083, 084, 086, 090) exists in `plans/` and the
  claim made about it matches that plan's actual content — **check each one**.
- No secret values appear anywhere in the file: it may name
  `TWILIO_VERIFY_SERVICE_SID` as a variable, never its value, and the same for
  every `GLOBEPAY_*` key.

## Done criteria

- [ ] `ls docs/ops/security-verification-checklist.md` succeeds
- [ ] All seven sections (A–G) are present, each with the four required parts
- [ ] `grep -n "security-verification-checklist" docs/payments/globepay365-setup.md` returns a match
- [ ] Every referenced plan number exists and the description of it is accurate
- [ ] No credential value appears in the file — verify by reading it end to end and stating so
- [ ] The "Already settled in the repo" section lists what Step 1 found, with citations
- [ ] `npm run format:check` exits 0 (or it is noted that `docs/` is out of its scope)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `docs/payments/globepay365-setup.md` already answers three or more of the
  questions. The checklist may not be worth writing as specified — report what
  is covered and propose a smaller document.
- You are tempted to write an answer you inferred rather than read. Leave the
  item open instead; an open question is useful and a wrong answer is worse
  than none.
- Any of the plans referenced (083, 084, 086, 090) does not exist or says
  something different from what this plan claims. Report the discrepancy —
  a checklist that misdescribes the code it points at will mislead the next
  reader.

## Maintenance notes

- **This document goes stale by design.** Its answers are third-party console
  state and change without a commit. Date every recorded answer and re-run the
  checklist at the start of each audit round.
- When an item is answered, do not delete it — move it to the settled section
  with its date and source. The next auditor needs to know it was checked, and
  when.
- A reviewer should scrutinize: that no item asserts an unverified answer, and
  that no credential value made it into the file.
