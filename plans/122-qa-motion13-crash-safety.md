# Plan 122: Make qa-motion13 report a failed demo-spin instead of crashing out of the gate

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat a981061e..HEAD -- scripts/qa-motion13.mjs`
> If the file changed since this plan was written, compare the "Current
> state" excerpts against the live code before proceeding; on a mismatch,
> treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (plan 120 already merged — this closes a follow-up it deliberately left out of scope)
- **Category**: tests / dx
- **Planned at**: commit `a981061e`, 2026-08-22

## Why this matters

Plan 120 wired `qa:motion13` into the nightly `e2e.yml` as an `if: always()`
gate. The demo-spin block at the end of the script runs at module top level
with **no** try/catch, and `spinBtn.waitFor({ state: 'visible', timeout: 30000 })`
can legitimately throw — the demo route failing to mount, or the button's
accessible name drifting away from `/spin|open pack|demo/i`.

When it throws:

1. `await browser.close()` never runs — the Chromium process leaks.
2. The summary line (`=== motion 13 QA: x/y surfaces clean ===`) and the
   deliberate exit-code line never execute. Node dies on the uncaught
   exception and dumps a raw stack trace.

So the nightly goes red with an opaque stack instead of the structured
`FAIL demo-spin …` line every other check in this script produces — which
undercuts the exact "no vacuous or opaque gate" goal plan 120 was written
for. Every other failure in this script is already treated as _data_
(a FAIL line plus `results.push(false)`), not as an exception; this one
block is the outlier.

## Current state

File: `scripts/qa-motion13.mjs`. Structure today:

- `:22` — `const browser = await chromium.launch();`
- `:23` — `const ctx = await browser.newContext({ … });`
- No `try` anywhere at top level.
- The demo-spin block runs inside `if (href) { … }`; the throwing line is
  the `spinBtn.waitFor(...)`:

```js
  await spinPage.goto(BASE + href + '/spin?demo=1', {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
  await spinPage
    .getByRole('button', { name: /reject|accept/i })
    .first()
    .click({ timeout: 3000 })
    .catch(() => {});
  const spinBtn = spinPage
    .getByRole('button', { name: /spin|open pack|demo/i })
    .first();
  await spinBtn.waitFor({ state: 'visible', timeout: 30000 });   // <-- throws
  await spinBtn.click();
  … busy-poll loop … screenshot …
  const spinOk = sawBusy && cleared && spinErrors.length === 0;
  console.log(
    `${spinOk ? 'PASS' : 'FAIL'} demo-spin sawBusy=${sawBusy} ` +
      `cleared=${cleared} errors=${spinErrors.length}`,
  );
  spinErrors.slice(0, 3).forEach((e) => console.log('   ' + e));
  results.push(spinOk);
} else {
  console.log(
    'FAIL pack-detail/card-overlay/spin — no pack link on /slots (backend down?)',
  );
  results.push(false, false, false);
}

await browser.close();
const failed = results.filter((r) => !r).length;
console.log(
  `\n=== motion 13 QA: ${results.length - failed}/${results.length} surfaces clean ===`,
);
process.exit(failed ? 1 : 0);
```

**The repo already has the convention to copy — match it, don't invent one.**
Two sibling QA scripts wrap their whole body and close the browser in a
`finally`, then set the exit code _after_ the finally so the summary always
prints:

- `scripts/qa-reset-countdown.mjs:13` `try {` … `:30` `} finally {` …
  `:33 await browser.close();` … `:36 process.exitCode = … ? 0 : 1;`
- `scripts/qa-free-pack.mjs:151` `try {` … `:682` `} finally {` …
  `:683 if (browser) await browser.close();`; its `fail()` helper sets
  `process.exitCode = 1` (`:44`) rather than calling `process.exit()`.

Note both siblings use **`process.exitCode`**, not `process.exit()`.
`process.exit()` truncates pending stdout writes; `process.exitCode` lets
node exit naturally with the right status. `qa-motion13.mjs` is the odd one
out here.

## Commands you will need

| Purpose       | Command                                   | Expected on success          |
| ------------- | ----------------------------------------- | ---------------------------- |
| Syntax        | `node --check scripts/qa-motion13.mjs`    | exit 0                       |
| Format        | `npm run format:check`                    | exit 0                       |
| Lint (scoped) | `npx eslint scripts/qa-motion13.mjs`      | exit 0                       |
| Live run      | `node scripts/qa-motion13.mjs` (stack up) | `6/6 surfaces clean`, exit 0 |

`npm run lint` (unscoped) exits 1 on this machine from two pre-existing
`require()` errors in the UNTRACKED, git-excluded
`.agents/skills/security-audit/validate-findings.cjs`. CI never checks that
file out. It is not yours — do not fix it; use the scoped eslint above.

**Getting the exit code right**: read it with `$?` immediately after the
`node` call. Do NOT pipe into `tail`/`head` first — that reports the pipe's
last command status and will mislead you.

**The local stack**: the reviewer will have backend `:9000` + prod
storefront `:4000` up before dispatching you. Confirm with
`curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:4000/healthz` → 200
and the same for `http://127.0.0.1:9000/health`. Do NOT boot or restart
servers yourself. Note `qa-motion13.mjs` reads its base from
`process.argv[2]`, NOT `PW_BASE`, and already defaults to
`http://127.0.0.1:4000`.

## Scope

**In scope**: `scripts/qa-motion13.mjs` — and nothing else.

**Out of scope**:

- Every other `scripts/qa-*.mjs` — they already have the finally.
- `.github/workflows/e2e.yml` — the gate wiring is correct as merged.
- The `visit()` helper and the surfaces it checks — no assertion changes.
- Re-adding any `motionNodes` assertion. It is diagnostics-only on purpose:
  `[style*="opacity"]` reads 0 on `/` and `/slots` at every sampled point
  (100ms–3.7s), so a `nodes > 0` check makes the gate permanently red. The
  comment in the file records this. Leave it alone.

## Git workflow

- Branch: already created by the reviewer — commit directly onto the branch
  you are told to use. Do NOT create a branch or worktree.
- Conventional commit, e.g.
  `fix(qa): report a failed demo-spin instead of crashing qa-motion13`
- Body ends with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Do NOT push or open a PR.

## Steps

### Step 1: Put the browser teardown in a `finally`, matching the siblings

Wrap the script body from just after `const browser = await chromium.launch();`
down to the end of the `if (href) { … } else { … }` block in a
`try { … } finally { await browser.close(); }`. Keep the summary `console.log`
and the exit-code line **after** the `finally`, so they run whether or not
the body threw.

Change the final line from `process.exit(failed ? 1 : 0);` to
`process.exitCode = failed ? 1 : 0;` — matching both siblings and avoiding
truncated stdout.

This is a mechanical re-indent of the body; let prettier settle the
formatting (`npm run format` if needed, then `npm run format:check`).

**Verify**: `node --check scripts/qa-motion13.mjs` → exit 0.

### Step 2: Turn a thrown demo-spin into a FAIL line

Wrap the demo-spin block — from `await spinPage.goto(...)` through
`results.push(spinOk);` — in its own `try`/`catch`. On catch, emit a FAIL
line in the same shape as the block's own, including the error's first line,
and push `false`:

```js
  } catch (e) {
    // Treated as data, like every other failure in this script: the demo
    // route can fail to mount, or the button's accessible name can drift
    // off /spin|open pack|demo/i, and a raw stack trace in the nightly is
    // strictly worse than a FAIL line (this gate runs `if: always()`).
    console.log(
      `FAIL demo-spin — ${String(e && e.message ? e.message : e).split('\n')[0]}`,
    );
    results.push(false);
  }
```

Requirements the catch must satisfy:

- Exactly ONE `results.push(false)` on the throw path — the block pushes one
  result on success, so a throw must not push two or zero (the summary's
  `x/y` arithmetic depends on it).
- The `spinPage` is created before the block (`const spinPage = await ctx.newPage();`).
  Leaving it open is fine — the `finally` from Step 1 closes the whole
  browser. Do not add per-page teardown.
- Do not swallow the error silently; the message must appear in the log.

**Verify**: `node --check scripts/qa-motion13.mjs` → exit 0;
`npx eslint scripts/qa-motion13.mjs` → exit 0; `npm run format:check` → exit 0.

### Step 3: Live-prove BOTH paths

1. **Happy path** — with the stack up:
   `node scripts/qa-motion13.mjs` then read `$?` directly.
   Expected: `=== motion 13 QA: 6/6 surfaces clean ===` and exit `0`.

2. **Failure path** — force the throw and confirm it now degrades cleanly
   instead of crashing. Do this WITHOUT committing a mutation: temporarily
   edit the spin-button locator's regex in your working copy to something
   that cannot match (e.g. `/zzz-no-such-button/`), run the script, then
   **revert the edit** (`git checkout -- scripts/qa-motion13.mjs` would
   revert your real work too — instead re-edit by hand, or stash only that
   hunk, and confirm with `git diff` that the regex is back).
   Expected on the mutated run:
   - a `FAIL demo-spin — …` line naming the timeout,
   - the summary line still printed, reading `5/6`,
   - exit code `1`,
   - **no** raw stack trace,
   - and no leaked Chromium (`@(Get-Process chrome*).Count` before/after, or
     confirm the run terminated normally).

Report the actual captured output of both runs. If you cannot perform the
mutation run, say so plainly rather than implying it passed.

**Verify**: both runs produce exactly the output described.

## Done criteria

- [ ] `node --check scripts/qa-motion13.mjs` exits 0
- [ ] `npx eslint scripts/qa-motion13.mjs` exits 0; `npm run format:check` exits 0
- [ ] `grep -c "process.exit(" scripts/qa-motion13.mjs` → 0 (replaced by `process.exitCode`)
- [ ] `grep -c "finally" scripts/qa-motion13.mjs` → ≥1
- [ ] Happy-path live run: `6/6 surfaces clean`, exit 0 — output pasted in the report
- [ ] Mutation run: `FAIL demo-spin …` + summary `5/6` + exit 1 + no stack trace — output pasted, mutation reverted (`git diff` proves the regex is back)
- [ ] Only `scripts/qa-motion13.mjs` modified (`git status`)
- [ ] `plans/README.md` not touched (the reviewer maintains it)

## STOP conditions

Stop and report back (do not improvise) if:

- The file has drifted from the "Current state" excerpts.
- The happy-path run does not produce `6/6` BEFORE your change (that would
  mean something else is broken and your change would mask it) — check this
  first, and report the actual result.
- The local stack is not answering on `:4000`/`:9000` (do not boot it
  yourself — report it).
- Re-indenting for the `try`/`finally` produces a diff that touches
  assertion logic rather than pure indentation — the body's behavior must be
  byte-identical apart from indentation.

## Maintenance notes

- `qa-motion13.mjs` now matches `qa-free-pack.mjs` and
  `qa-reset-countdown.mjs`: body in a `try`, browser closed in a `finally`,
  status via `process.exitCode`. Any new `qa-*.mjs` should follow the same
  shape.
- Reviewer: confirm the throw path pushes exactly one `false`, and that the
  summary's `x/y` still adds up on the mutated run (that is what proves it).
