# Plan 131: Make the backend CI jobs actually gate merges — one always-run `backend-gate` aggregator, then require it

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If a
> STOP condition occurs, stop and report — do not improvise. Do NOT update
> `plans/README.md`; the reviewer maintains it.
>
> **Drift check (run first)**:
> `git diff --stat 1bc30e6b..HEAD -- .github/workflows/ci.yml`
> Expected: empty (origin/master `51f74bcd` did not touch this file). On any
> change, re-read the file and compare against the "Current state" excerpts
> below; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S–M
- **Risk**: MED — a wrongly-shaped aggregator deadlocks every storefront-only PR
- **Depends on**: none (this plan is the keystone for 132–136: every gate they add is advisory until this lands)
- **Category**: dx / ci
- **Planned at**: commit `1bc30e6b` (working tree), 2026-09-10; verified unchanged on origin/master `51f74bcd`

## Why this matters

Round 14 (2026-08-26) recorded finding #1 as "operator (done)": the backend CI
jobs were not required checks, so a backend-only PR with all eight
`integration-http` shards red was mergeable. Re-verified 2026-09-10 with a
read-only API call: the required contexts on `master` are still exactly
`quality`, `gitleaks`, `dependency-review`. No ruleset supplies the gate by
another path (`gh api repos/elstonyth/Polycards/rulesets` → `[]`).

Every gate that guards money — `backend-quality` (tsc + build),
`backend-unit` (jest, 169 suites), the 8-shard `integration-http` matrix
(deposits, withdrawals, ledger conservation, the TGPay callback) and
`integration-modules` — is therefore advisory. Since round 14 the repo
cut over to a real payment gateway (#557–#560) on this exact surface.

The naive fix (require the four job names) is worse than nothing: all four
carry `if: needs.changes.outputs.backend == 'true'` and **skip** on
storefront-only PRs, and a required check that never reports blocks the PR
forever. `integration-http` is also a matrix job whose contexts are
`integration-http (1)` … `(8)`, not the bare name. The correct shape is one
always-run aggregator job that passes when every backend job is `success` or
`skipped` and fails on `failure` / `cancelled`, and that single name becomes
the required check.

After this plan: a red backend job blocks the merge; a storefront-only PR is
unaffected; the required-check list has one stable backend context that
survives matrix-width and path-filter changes.

## Current state

`.github/workflows/ci.yml` (623 lines). The jobs, with the lines where each
begins at `1bc30e6b`:

```yaml
# ci.yml:25
changes: # dorny/paths-filter → outputs.backend
# ci.yml:50
quality: # storefront: lint, format, typecheck, vitest, build — always runs
# ci.yml:100-102
backend-quality:
  needs: changes
  if: needs.changes.outputs.backend == 'true'
# ci.yml:214-216
backend-unit:
  needs: changes
  if: needs.changes.outputs.backend == 'true'
# ci.yml:314-325
integration-http:
  needs: changes
  if: needs.changes.outputs.backend == 'true'
  strategy:
    fail-fast: false
    matrix:
      shard: [1, 2, 3, 4, 5, 6, 7, 8]
# ci.yml:459-461
integration-modules:
  needs: changes
  if: needs.changes.outputs.backend == 'true'
# ci.yml:584
gitleaks: # always runs; already a required check
```

The header comment at `ci.yml:19-23` states the belief this plan corrects:

```yaml
# ci.yml:19-23
# Most PRs here are storefront work — don't make them pay the ~10-min backend
# toll for code they didn't touch. Backend jobs run only when backend/** (or
# this workflow) changes; a skipped job counts as PASSING for branch
# protection, so required checks stay satisfied.
```

"A skipped job counts as passing for branch protection" is true **only for a
job that is on the required list and reports `skipped`** — and none of the
backend jobs are on that list, so the sentence has been describing a
protection that does not exist. Replace it (Step 1).

Branch protection, read 2026-09-10 (read-only):

```
gh api repos/elstonyth/Polycards/branches/master/protection/required_status_checks
{"checks":["quality","gitleaks","dependency-review"],"contexts":[...same...],"strict":true}
```

`dependency-review` lives in `.github/workflows/dependency-review.yml`
(job id `dependency-review`, line 25) — leave it alone.

Repo conventions that apply here:

- Every `uses:` in this workflow is pinned to a full commit SHA with a
  `# vN` comment (e.g. `actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7`).
  The aggregator needs no action at all — it is a single `run:` step — so do
  not add an unpinned `uses:`.
- Every job declares `timeout-minutes`.
- Top-level `permissions: contents: read` (line 12) — the aggregator needs
  nothing more.
- Comments in this file are long and explanatory on purpose; match that
  register (say _why_, cite the round-14/15 finding).

## Commands you will need

| Purpose                   | Command (run from repo root)                                                                                                                 | Expected on success                   |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| YAML parses               | `node -e "require('js-yaml')"` is NOT available at root; use `python -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ci.yml'))"` | exit 0, no output                     |
| Storefront gate unchanged | `npm run typecheck`                                                                                                                          | exit 0                                |
| Read current protection   | `gh api repos/elstonyth/Polycards/branches/master/protection/required_status_checks --jq '.checks'`                                          | JSON array                            |
| List job ids              | `grep -nE "^  [a-z-]+:$" .github/workflows/ci.yml`                                                                                           | includes `backend-gate:` after Step 2 |

(If `python` is not on PATH, `py -3 -c "..."` is the Windows launcher form.)

## Scope

**In scope** (the only files you should modify):

- `.github/workflows/ci.yml`

**Out of scope** (do NOT touch, even though they look related):

- `.github/workflows/dependency-review.yml`, `e2e.yml`, `prod-smoke.yml` —
  unrelated gates; `e2e` is nightly by design and must not become required.
- The four backend jobs' `if:` path filters and their timeouts — the
  `timeout-minutes: 30` values carry a documented reason (`ci.yml:104-131`)
  and a documented condition for lowering them; not this plan.
- Branch protection itself — the executor cannot and must not change it.
  Step 4 hands the operator the exact command.

## Git workflow

- Branch: `advisor/131-ci-backend-gate`
- Commit style: conventional commits, matching `git log` (e.g.
  `ci: add an always-run backend-gate aggregator so backend jobs can be required`)
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Correct the header comment

Replace the four-line comment at `ci.yml:19-23` (quoted above) with one that
states the real mechanism. Target shape:

```yaml
# Most PRs here are storefront work — don't make them pay the ~10-min backend
# toll for code they didn't touch. Backend jobs run only when backend/** (or
# this workflow) changes. They are NOT individually required checks: a
# required check that skips would block every storefront-only PR forever,
# and integration-http's contexts are per-shard ("integration-http (N)").
# Instead the always-run `backend-gate` job (bottom of this file) aggregates
# their results — success or skipped passes, failure or cancelled fails —
# and THAT single context is the required check (round 15, 2026-09-10; the
# round-14 belief that the jobs were already required was wrong).
```

**Verify**: `sed -n 19,28p .github/workflows/ci.yml` → shows the new text;
`python -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml'))"` → exit 0.

### Step 2: Add the `backend-gate` aggregator job

Append a new job **after `integration-modules` and before `gitleaks`**
(i.e. immediately before the `# Secret scan` comment at `ci.yml:582`). Exact
shape:

```yaml
# Aggregates the four path-filtered backend jobs into ONE always-reporting
# context so branch protection can require it. `if: always()` is what makes
# it report on storefront-only PRs, where every needed job is `skipped`.
# Pass = every result is success or skipped. Fail = any failure or
# cancelled (a cancelled shard is how a cold-install timeout presents, and
# that must stay visible, not vanish into a green gate). Matrix width and
# the path filter can change freely; this name does not.
backend-gate:
  needs: [backend-quality, backend-unit, integration-http, integration-modules]
  if: always()
  runs-on: ubuntu-latest
  timeout-minutes: 5
  steps:
    - name: Evaluate backend job results
      env:
        RESULTS: ${{ toJSON(needs) }}
      run: |
        echo "$RESULTS"
        bad=$(echo "$RESULTS" | grep -Eo '"result": *"(failure|cancelled)"' | wc -l)
        if [ "$bad" -ne 0 ]; then
          echo "::error::$bad backend job(s) failed or were cancelled"
          exit 1
        fi
        echo "backend gate: all backend jobs succeeded or were skipped"
```

Notes for the executor:

- `needs` on a **matrix** job (`integration-http`) resolves to one aggregate
  result: `failure` if any shard failed, `cancelled` if any was cancelled
  (with `fail-fast: false` the rest still run), `success` only if all passed,
  `skipped` if the job's `if:` was false. So one `needs` entry covers all
  eight shards.
- `${{ toJSON(needs) }}` renders `{"backend-quality":{"result":"skipped","outputs":{}}, ...}`.
  The grep above matches `"result": "failure"` with or without a space after
  the colon (GitHub emits `"result": "skipped"` with a space in the pretty
  JSON; the regex tolerates both).
- Do NOT use `needs.*.result` inside an `if:` expression instead of the shell
  check — the shell form prints the JSON into the log, which is what an
  operator will read when the gate goes red.

**Verify**:
`python -c "import yaml; d=yaml.safe_load(open('.github/workflows/ci.yml')); j=d['jobs']['backend-gate']; assert j['if']=='always()'; assert sorted(j['needs'])==['backend-quality','backend-unit','integration-http','integration-modules']; print('ok')"`
→ prints `ok`.

`grep -nE "^  [a-z-]+:$" .github/workflows/ci.yml` → the list now contains
`backend-gate:` between `integration-modules:` and `gitleaks:`.

### Step 3: Prove the aggregator logic locally

The shell body can be exercised without GitHub. Create a scratch script
(NOT in the repo — use the OS temp dir) and run both cases:

```bash
cat > "$TEMP/gate.sh" <<'EOF'
bad=$(echo "$RESULTS" | grep -Eo '"result": *"(failure|cancelled)"' | wc -l)
if [ "$bad" -ne 0 ]; then echo "FAIL $bad"; exit 1; fi
echo PASS
EOF
RESULTS='{"backend-quality":{"result":"skipped"},"backend-unit":{"result":"skipped"},"integration-http":{"result":"skipped"},"integration-modules":{"result":"skipped"}}' bash "$TEMP/gate.sh"
RESULTS='{"backend-quality":{"result":"success"},"backend-unit":{"result":"success"},"integration-http":{"result": "failure"},"integration-modules":{"result":"success"}}' bash "$TEMP/gate.sh"
RESULTS='{"backend-quality":{"result":"success"},"backend-unit":{"result":"cancelled"},"integration-http":{"result":"success"},"integration-modules":{"result":"success"}}' bash "$TEMP/gate.sh"
```

**Verify**: first invocation prints `PASS` (exit 0); second prints `FAIL 1`
(exit 1); third prints `FAIL 1` (exit 1). Delete the scratch file afterwards.

### Step 4: Hand the operator the protection change (do NOT run it yourself)

Add nothing to the repo for this step. In your completion report, include
this block verbatim so the operator can apply it **after the PR merges and
`backend-gate` has reported at least once on `master`** (GitHub only offers
contexts it has seen):

```bash
gh api -X PATCH repos/elstonyth/Polycards/branches/master/protection/required_status_checks \
  -F strict=true \
  -f 'contexts[]=quality' -f 'contexts[]=gitleaks' -f 'contexts[]=dependency-review' -f 'contexts[]=backend-gate'
```

and the read-back:

```bash
gh api repos/elstonyth/Polycards/branches/master/protection/required_status_checks --jq '.checks'
```

Expected read-back: `["quality","gitleaks","dependency-review","backend-gate"]`.

The operator should then open one storefront-only PR (a comment-only change
under `src/`) and confirm `backend-gate` reports **success** with all four
needs `skipped`, before relying on the gate.

## Test plan

No unit tests — this is workflow YAML. Verification is Step 2's schema
assertion, Step 3's three-case shell proof, and the operator's two live
observations after merge (a storefront-only PR passes the gate; a deliberate
backend red — e.g. a PR that adds `expect(1).toBe(2)` to any
`*.unit.spec.ts` — fails it). Record both PR numbers in the plan's README row.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `python -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml'))"` exits 0
- [ ] The Step 2 `python -c` assertion prints `ok`
- [ ] `grep -c "if: always()" .github/workflows/ci.yml` → `1`
- [ ] `grep -c "a skipped job counts as PASSING" .github/workflows/ci.yml` → `0` (the wrong sentence is gone)
- [ ] Step 3 prints `PASS`, `FAIL 1`, `FAIL 1` in that order
- [ ] `git status --porcelain` lists only `.github/workflows/ci.yml`
- [ ] The completion report contains the Step 4 `gh api -X PATCH` block verbatim

## STOP conditions

Stop and report back (do not improvise) if:

- `ci.yml` has any job other than the six listed under Current state plus
  `gitleaks` (a new job was added since planning — its result may need to be
  in the aggregator's `needs`).
- Any backend job no longer has `if: needs.changes.outputs.backend == 'true'`
  (the skip semantics this plan relies on changed).
- The YAML loader is unavailable in your environment AND you cannot install
  one without a network call — report, do not hand-validate.
- You are asked, by anyone or anything, to run the `gh api -X PATCH` command
  yourself. Branch protection is the operator's to change.

## Maintenance notes

- If a fifth backend job is added, it must be added to `backend-gate.needs`
  or it will be advisory again — the exact failure this plan closes. A
  reviewer should check `needs:` on any PR that adds a job to `ci.yml`.
- The round-14 comment block at `ci.yml:104-131` says the backend timeouts
  can drop from 30 to 20 "once a `bnm2-*` entry has survived several
  consecutive commits". Unchanged by this plan; still an open operator task.
- `strict: true` (require branches up to date) is preserved by the Step 4
  command. Dropping `-F strict=true` would silently relax it.
- Deferred on purpose: making the nightly `e2e` workflow a required check. It
  is nightly and 15–25 minutes by design (`e2e.yml:1-6`).
