# Plan 037: Docs & env truth round 3 — DESIGN.md brand, CLAUDE.md drift, .env.template

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If a
> STOP condition occurs, stop and report — do not improvise. Your reviewer
> maintains `plans/README.md` — do not edit it.
>
> **Drift check (run first)**:
> `git diff --stat 38f7dbdd..HEAD -- DESIGN.md CLAUDE.md backend/packages/api/.env.template`
> On any change, compare "Current state" against live code before proceeding.
>
> **Secret-file note**: `.env.template` is guarded by the repo's
> `guard-secrets` hook against _shell reads_. You may open it with the editor's
> file-read (the Read tool), and you may edit it. Never print or echo its
> contents through the shell. When editing, add/rename **variable names and
> comments only** — never a real value.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (but coordinates with 034 on `.env.template` vendor
  lines — see Scope)
- **Category**: docs / dx
- **Planned at**: commit `38f7dbdd`, 2026-07-13

## Why this matters

The repo's agent-facing docs contain contradictions and stale brand/mechanic
references that compound every session (all `/impeccable`, design, and
onboarding agents read them):

- **`DESIGN.md` is git-tracked and ships**, stamped `name: Pokenic` (the repo
  rebranded to PixelSlot), while **`CLAUDE.md:96` tells every agent
  "`DESIGN.md` … is not yet written"** — a two-way contradiction. Code already
  depends on DESIGN.md (`src/components/ui/pill.tsx:6` cites "DESIGN.md §5").
- **`CLAUDE.md:49`** still claims UI primitives are "built on `@base-ui/react`"
  — removed by plan 030; `README.md` was corrected but `CLAUDE.md` (gitignored)
  was not swept.
- **`.env.template`** omits several vars the API actually reads (feature gates
  `REWARDS_REDEMPTION_ENABLED`, `COMMISSION_COOLDOWN_DAYS`; ops knobs
  `MEDUSA_WORKER_MODE`, `MERCUR_STOREFRONT_URL`, provisioning `ADMIN_EMAIL`/
  `ADMIN_PASSWORD`), never lists `ALLOW_MOCK_TOPUP` on its own PROD CHECKLIST
  (the flag whose _unset_ state keeps the mock credit gateway off in prod), and
  carries a stale `MERCUR_VENDOR_URL` + a duplicated `PRICECHARTING_API_TOKEN`.

None of this breaks a boot (every missing var has a safe default), so this is
truthfulness/onboarding debt, not a runtime bug — but it is exactly the class
plans 020/028 were closing, and these are the residual instances.

## Current state

**`DESIGN.md`** (git-tracked — `git ls-files DESIGN.md` returns it): front-
matter `name: Pokenic` (line 2); body has `# Design System: Pokenic` and
"Pokenic's own dark neutral base". The visual system it documents (app shell,
pill, px-fluid) is real and shipped — only the _brand name_ is stale.

**`CLAUDE.md`** (repo-root, gitignored per the audit but the primary agent
brief):

- Line ~17: "These are hard-won constraints from `docs/HANDOFF.md`, not
  preferences." (`docs/HANDOFF.md` is a stale, mojibake, wrong-repo-path,
  claw-era local file — the running/verifying constraints CLAUDE.md needs are
  already inlined in CLAUDE.md's own "Running & verifying" section just below.)
- Line ~49: "shadcn-style components in `src/components/ui/` built on
  `@base-ui/react` (not Radix directly)." (`@base-ui/react` is gone —
  `grep -rn "base-ui" package.json backend/apps/admin/package.json` = 0.
  `README.md:19` already says "Tailwind-only".)
- Line ~96: "`DESIGN.md` (visual system) is not yet written — generate it when
  the mobile-first redesign kicks off."

**`.env.template`** (`backend/packages/api/.env.template`) — read it with the
Read tool. Confirmed by the audit:

- Vars read by code but absent from the template: `ALLOW_MOCK_TOPUP`,
  `REWARDS_REDEMPTION_ENABLED`, `COMMISSION_COOLDOWN_DAYS`,
  `MERCUR_STOREFRONT_URL`, `MEDUSA_WORKER_MODE`, `ADMIN_EMAIL`,
  `ADMIN_PASSWORD`.
- Line 31 `MERCUR_VENDOR_URL` — read by nothing (grep finds it only in the
  template). **NOTE: plan 034 may remove this line if it fences the vendor
  surface. See Scope.**
- `PRICECHARTING_API_TOKEN` appears twice (line 36 commented, line 71 active).

## Commands you will need

| Purpose                                               | Command                                                           | Expected           |
| ----------------------------------------------------- | ----------------------------------------------------------------- | ------------------ |
| Confirm base-ui absent                                | `grep -rn "base-ui" package.json backend/apps/admin/package.json` | 0 matches          |
| Confirm DESIGN.md tracked                             | `git ls-files DESIGN.md`                                          | prints `DESIGN.md` |
| Storefront check (only if you touch code — you won't) | n/a                                                               | —                  |

This is a docs-only plan; there is no build/test gate beyond the greps and a
read-back of each edited file.

## Scope

**In scope**:

- `DESIGN.md` — brand rename Pokenic → PixelSlot (front-matter `name`,
  headings, prose). Do NOT change tokens/values/component specs.
- `CLAUDE.md` — three edits: line ~17 (drop the `docs/HANDOFF.md` pointer,
  since its constraints are already inlined below it), line ~49 (`@base-ui/react`
  → "Tailwind-only", matching README.md:19), line ~96 (acknowledge DESIGN.md
  exists and is authoritative; reconcile with PRODUCT.md's "regenerate when the
  redesign kicks off" note — e.g. "DESIGN.md documents the shipped app-shell
  system; regenerate/extend it as the brand-surface redesign proceeds").
- `backend/packages/api/.env.template` — add the missing vars **with comments,
  no values**; add `ALLOW_MOCK_TOPUP` to the PROD CHECKLIST stating it must
  stay unset in prod; remove the duplicate `PRICECHARTING_API_TOKEN` (keep one).

**Out of scope**:

- `MERCUR_VENDOR_URL` (line 31) — **plan 034 owns this line.** If 034 has
  already landed and removed it, skip it. If 034 has not landed, LEAVE it
  (do not remove it here) to avoid a merge conflict; note in your report that
  034 should remove it.
- `PRODUCT.md` and `docs/HANDOFF.md` — both are git-untracked (local-only);
  editing them doesn't ship and risks touching the operator's local scratch.
  Note their staleness in your report as follow-ups, but do not edit.
- Any code file, any token/value in DESIGN.md, any real secret value.

## Git workflow

- Branch: `advisor/037-docs-env-truth-round3`
- Commit: `docs: fix stale brand/@base-ui/DESIGN references and .env.template drift`
- Do not push or open a PR.

## Steps

### Step 1: Rebrand DESIGN.md

Replace "Pokenic" with "PixelSlot" in the front-matter `name`, the
`# Design System:` heading, and prose brand references. Leave every color
token, typography value, spacing value, and component spec byte-identical.

**Verify**: `grep -in "pokenic" DESIGN.md` → 0 matches;
`git diff DESIGN.md` shows only brand-string lines changed.

### Step 2: Fix the three CLAUDE.md drifts

Apply the three edits described in Scope. For line ~17, remove the
`docs/HANDOFF.md` citation and keep the sentence pointing at CLAUDE.md's own
inlined "Running & verifying" section (or just drop the parenthetical source).

**Verify**: `grep -n "base-ui\|not yet written\|docs/HANDOFF.md" CLAUDE.md`
→ 0 matches (or, for HANDOFF, only if you kept a deliberate archival mention —
default is 0).

### Step 3: Update .env.template

Read the file with the Read tool. Add the missing vars grouped sensibly
(feature gates together, ops knobs together, provisioning `ADMIN_*` together),
each with a one-line comment and **no value** (e.g.
`# REWARDS_REDEMPTION_ENABLED=   # off unless "true"; gates the rewards economy`).
Add an `ALLOW_MOCK_TOPUP` note to the PROD CHECKLIST block (lines 1-22) stating
it must remain unset in production. Delete the duplicate
`PRICECHARTING_API_TOKEN` (keep the active line 71, remove the commented line
36 or vice-versa — keep exactly one, with its existing comment).

**Verify**: open the file with the Read tool and confirm: the new var names
present, `ALLOW_MOCK_TOPUP` named in the checklist, exactly one
`PRICECHARTING_API_TOKEN`. Do NOT grep it through the shell (guard-secrets
will block). No real values were added.

## Done criteria

- [ ] `grep -in "pokenic" DESIGN.md` → 0
- [ ] `grep -n "base-ui\|not yet written" CLAUDE.md` → 0
- [ ] `.env.template` (read via Read tool) shows the new vars, the checklist
      `ALLOW_MOCK_TOPUP` note, and a single `PRICECHARTING_API_TOKEN`
- [ ] No value strings added to `.env.template` (only names + comments)
- [ ] `git status` shows only `DESIGN.md`, `CLAUDE.md`, `.env.template` modified
- [ ] `git diff DESIGN.md` touches no token/spec lines

## STOP conditions

- `git ls-files DESIGN.md` returns nothing (it's not actually tracked — the
  premise is wrong; report).
- `grep -rn "base-ui" package.json backend/apps/admin/package.json` finds a
  match (base-ui is NOT gone — do not claim it in the docs; report).
- Editing `.env.template` triggers the guard-secrets hook on _write_ (it
  guards shell reads, not edits — but if the edit is blocked, stop and report
  rather than working around the hook).

## Maintenance notes

- `PRODUCT.md` (untracked) still says "Pokenic (pokenic.com)" and references
  the retired claw mechanic — flagged as a follow-up for the operator to fix
  locally (it's the strategic brief every design session reads).
- `docs/HANDOFF.md` (untracked, mojibake, wrong-repo) is now de-referenced
  from CLAUDE.md; the operator may delete or refresh it locally.
- If plan 034 lands after this, confirm `MERCUR_VENDOR_URL` ends up removed
  exactly once (034 owns it).
