# Plan 111: Make plan 054's success criteria drift-proof, and pick the cheaper first seam

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 16cc85d3..HEAD -- plans/054-extract-challenge-slice-from-service.md backend/packages/api/src/modules/packs/service.ts`
> `service.ts` drifting is expected and is the subject of this plan. If
> `plans/054-*.md` itself changed since `16cc85d3`, read it fully before
> proceeding — someone may already have re-baselined it a fourth time.
>
> **This plan edits a plan file. It changes no source code.**

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tech-debt
- **Planned at**: commit `16cc85d3`, 2026-08-18

## Why this matters

Plan 054 — extract the Weekly-Challenge slice out of `service.ts` — is this
repository's only standing TODO to survive eleven audit rounds. It has now been
re-baselined twice and drifted three times, and the reason is structural rather
than negligent: **its success criteria are absolute numbers measured against a
file that grows every week.**

The measurements:

| When                                           | `service.ts`    | Plan 054 said              |
| ---------------------------------------------- | --------------- | -------------------------- |
| plan written (`b5944e26`)                      | 5,096 lines     | "≥600 lines below 5,096"   |
| re-baselined 2026-08-15 (plan 106, `5c74ce17`) | 8,852 lines     | "≥1,155 lines below 8,852" |
| **today (`16cc85d3`)**                         | **9,302 lines** | still says 8,852           |

Three days, +450 lines, criterion stale again. Every re-baseline costs a round
and buys three days. The line-numbered symbol inventory (`:7149-8303` and the
thirteen `:NNNN` anchors) has the same problem, though it is mitigated by the
plan's own instruction to re-locate symbols by grep.

Re-baselining a fourth time would be doing the same thing and expecting a
different result. The fix is to state the criteria in terms that **cannot go
stale**: the challenge symbols are gone from `service.ts` and live in the new
module, and the file is smaller than it was when the executor started. Those are
true whenever the work is done, at any file size, on any future commit.

The second half: plan 106 recorded that a cheaper first extraction seam exists
(an account-lifecycle slice) and that the challenge slice has since grown a
cross-slice coupling (`deletedCustomerIds`). Eleven rounds of not starting is
evidence about the size of the first bite, not about the team. This plan makes
the cheaper seam the _recommended_ opening move and records why, without
deleting the challenge-slice plan.

## Current state

### Plan 054's drift-prone criterion

`plans/054-extract-challenge-slice-from-service.md:85`, the last row of the
"Commands you will need" table:

```
| Line count | `wc -l src/modules/packs/service.ts` | ≥1,155 lines below 8,852 (re-baselined 2026-08-15, plan 106; was ≥600 below 5,096) |
```

Both figures in that cell are now wrong, and the parenthetical is a fossil
record of the same failure happening twice.

### Plan 054's re-baseline banner

`plans/054-extract-challenge-slice-from-service.md:15-20`:

```
> **Re-baselined 2026-08-15 (plan 106) against `5c74ce17`; supersedes the
> 5,096-line-era inventory below.** Line numbers, the symbol list, and the
> dependency status were re-measured; the extraction pattern, decorator
> constraint, caller list, and spec list were left untouched (only
> re-anchored). See the "Cross-slice dependency" and "Sequencing option"
> subsections added under Current state.
```

### Plan 054's symbol inventory

`plans/054-extract-challenge-slice-from-service.md:39-47` lists the file as
"**8,852 lines at `5c74ce17`**" and enumerates thirteen symbols with `:NNNN`
anchors, including eight found by plan 106:

```
  - **8 methods new since plan-time, missing from the original inventory — all challenge-slice, all in scope for Step 3:** `:7281` `promoteDueChallengeSchedules`, `:7346` `promoteOneChallengeSchedule`, `:7402` `editChallengeSchedule`, `:7494` `challengeWinnerWeeks`, `:7623` `challengeWeekBounds`, `:7657` `settleChallengeWeek`, `:7856` `settleChallengeWinner` (`protected`), `:8120` `reserveSettledStock` (`private`). ...
```

The plan already instructs the executor to "Re-locate every symbol by NAME
(grep), not line number" in its drift-check banner — so the names are the
durable part and the numbers are decoration that ages badly.

### The measurement you will take

```
wc -l backend/packages/api/src/modules/packs/service.ts
```

At `16cc85d3` this is **9,302**. Take it yourself; do not trust this number if
the drift check showed movement.

### The cheaper seam plan 106 recorded

Plan 054 carries a "Sequencing option" subsection under Current state (added by
plan 106) describing an account-lifecycle slice as a smaller first extraction,
and a "Cross-slice dependency" subsection describing the `deletedCustomerIds`
coupling that makes `settleChallengeWinner` harder to move than it was. Read
both before editing — this plan promotes what they say from an option to a
recommendation; it does not re-derive them.

### Convention for editing a plan file

`plans/README.md` and the plan files use a `>` blockquote banner at the top for
supersession/re-baseline notices, dated, naming the plan that did it. Follow
that. Do not delete superseded prose — this repo keeps it and marks it, so a
reader can see what changed and why.

## Commands you will need

| Purpose                   | Command                                                                           | Expected on success            |
| ------------------------- | --------------------------------------------------------------------------------- | ------------------------------ |
| Measure the file          | `wc -l backend/packages/api/src/modules/packs/service.ts`                         | a number (9,302 at `16cc85d3`) |
| Confirm no source changed | `git status --short`                                                              | only `plans/*.md` listed       |
| Symbol still present      | `grep -c "settleChallengeWeek" backend/packages/api/src/modules/packs/service.ts` | ≥1                             |

No build, typecheck or test run is required — **this plan touches no code.** If
you find yourself running `yarn check-types`, you have gone out of scope.

## Scope

**In scope**:

- `plans/054-extract-challenge-slice-from-service.md`
- `plans/README.md` (status row for 111, and the note on 054)

**Out of scope** (do NOT touch):

- `backend/packages/api/src/modules/packs/service.ts` — **do not start the
  extraction.** This plan makes plan 054 executable; executing it is plan 054's
  job and a much larger change.
- Any other source file, spec, or script.
- Plan 054's extraction pattern, decorator constraint, caller list, spec list,
  Steps, or STOP conditions. Those were reviewed when written and are still
  right. You are changing **how success is measured** and **which seam is
  recommended first** — nothing else.
- Plan 106 (the previous re-baseline). It is DONE; leave it as the historical
  record.

## Git workflow

- Branch: `advisor/111-plan-054-drift-proof`
- Conventional commit, e.g.
  `docs(plans): state plan 054's criteria relatively so they stop going stale`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Measure, and record the third drift in the banner

Run `wc -l backend/packages/api/src/modules/packs/service.ts` and note the
number.

Add a banner immediately below the existing 2026-08-15 re-baseline banner at
`plans/054-*.md:15-20`. Do not remove the old one. The new banner must state:

- that as of 2026-08-18 (`16cc85d3`) the file measured **<your number>** lines,
  a third drift in three days against the 8,852 figure the previous re-baseline
  set;
- that this plan (111) therefore replaced the **absolute** criteria with
  **relative** ones, so no future growth can invalidate them and no fourth
  re-baseline is needed for that reason;
- that the line-numbered symbol anchors below remain stale by construction and
  the plan's existing "re-locate by NAME (grep)" instruction is the operative
  one.

**Verify**: `grep -n "111" plans/054-extract-challenge-slice-from-service.md`
→ ≥1 match in the banner region.

### Step 2: Replace the line-count criterion with relative criteria

Replace the `Line count` row at `plans/054-*.md:85` with criteria that are true
whenever the work is done, regardless of the file's size. Use these three (the
executor of 054 records the baseline itself, at the moment it starts):

1. **Baseline, recorded not assumed** — before any edit, run
   `wc -l backend/packages/api/src/modules/packs/service.ts` and write the
   number into the PR description. That number, not a number from this plan, is
   the comparison point.
2. **The slice is gone from `service.ts`** — for every symbol named in the
   inventory,
   `grep -c "<symbolName>" backend/packages/api/src/modules/packs/service.ts`
   returns either `0`, or the count of a thin decorated forwarder only (the
   plan already allows forwarders; say which symbols kept one and why).
3. **The slice exists in its new home** — every one of those symbols is present
   in `backend/packages/api/src/modules/packs/challenge.ts`, and
   `wc -l` on the new module is within a reasonable margin of the block removed.
4. **`service.ts` shrank by at least the size of what moved** — final count is
   at least (lines removed) below the recorded baseline. Note that concurrent
   work on master can add lines during the extraction; the criterion is about
   the _delta this change makes_, not the absolute floor, so state it as
   "`git diff --stat` on `service.ts` shows a net deletion of ≥N lines" rather
   than an absolute `wc -l` target.

Keep the rest of the "Commands you will need" table unchanged.

**Verify**: `grep -n "8,852" plans/054-extract-challenge-slice-from-service.md`
→ matches **only** inside the historical banners, never in the criteria table.
Read the table to confirm.

### Step 3: Promote the cheaper seam to the recommended opening move

In plan 054's "Sequencing option" subsection (added by plan 106), change the
framing from an option to a recommendation:

- state that after eleven rounds without the challenge slice being started, the
  evidence is about the size of the first bite;
- recommend the **account-lifecycle slice** as the first extraction, because it
  rehearses the same facade-delegation pattern at lower risk and because the
  challenge slice has since grown the `deletedCustomerIds` cross-slice coupling
  documented in the sibling subsection;
- keep plan 054 valid as written for the challenge slice — this is an ordering
  recommendation, not a replacement. Say so explicitly, so nobody reads it as
  the challenge extraction being cancelled.

Do not write the account-lifecycle plan here. Record it in
`plans/README.md`'s Round 12 section as a recommended next plan.

**Verify**: `grep -n "account-lifecycle" plans/054-extract-challenge-slice-from-service.md`
→ ≥1 match.

### Step 4: Update the index

In `plans/README.md`:

- update the status row for **111**;
- update the note on **054** so it reflects that its criteria are now relative
  and that the recommended first seam is the account-lifecycle slice. Its status
  stays **TODO** — this plan does not execute it.

**Verify**: `git status --short` lists only
`plans/054-extract-challenge-slice-from-service.md` and `plans/README.md`.

## Test plan

None. This plan produces no executable change. Its correctness is checked by the
greps in the Done criteria and by a human reading the amended criteria table and
agreeing that a future +500 lines on `service.ts` cannot invalidate it.

That is the actual acceptance question, and the reviewer should ask it in exactly
those words: **"if `service.ts` is 10,000 lines when someone executes 054, does
any criterion here become wrong?"** If yes, the plan failed.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `git status --short` lists **only** `plans/054-extract-challenge-slice-from-service.md`
      and `plans/README.md` — no source file, no test, no script
- [ ] `grep -n "8,852" plans/054-extract-challenge-slice-from-service.md` shows
      matches only inside historical banner text, none in the criteria table
- [ ] `grep -n "wc -l" plans/054-extract-challenge-slice-from-service.md` — the
      criterion reads as a recorded-baseline comparison, not an absolute target
- [ ] `grep -n "account-lifecycle" plans/054-extract-challenge-slice-from-service.md` → ≥1 match
- [ ] The current `wc -l` of `service.ts` is quoted in the new banner and in your
      report
- [ ] `plans/README.md` status rows for 111 and the note on 054 both updated

## STOP conditions

Stop and report back (do not improvise) if:

- Plan 054 has been re-baselined again (a fourth time) since `16cc85d3` by
  someone else — coordinate rather than stacking a fifth banner.
- Plan 054's status in `plans/README.md` is no longer TODO — if it is IN
  PROGRESS or DONE, editing its criteria mid-flight would move the goalposts
  under an executor.
- You conclude the criteria cannot be stated relatively — e.g. because the
  inventory's symbol names are themselves unstable. Report which names moved;
  that is a bigger finding than this plan.
- You are tempted to start the extraction. Stop. That is plan 054, it is a
  large move-only refactor of the repo's highest-blast-radius file, and it needs
  its own worktree, its own review, and the full test tiers.

## Maintenance notes

- **The general rule this instance teaches**: a plan's done criteria must not
  contain a measurement of a file that other work changes. Absolute line counts,
  absolute symbol line numbers, and absolute test counts all rot. State
  criteria as deltas the executor records at start, or as presence/absence
  greps.
- **A reviewer should scrutinize**: that no source file is in the diff, and that
  the amended criteria survive the "what if it is 10,000 lines" question.
- **What this deliberately does not do**: it does not shrink `service.ts` by a
  single line. The file is still the repo's highest-blast-radius refactor
  target, still growing, and still unextracted. This plan only ensures the next
  attempt is not spent re-measuring.
- **Follow-up to schedule**: write the account-lifecycle extraction plan. It is
  the recommended first seam and does not exist yet as a plan file.
