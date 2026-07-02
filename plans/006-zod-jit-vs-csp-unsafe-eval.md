# Plan 006: Resolve Zod-JIT vs CSP `unsafe-eval` before enforcing CSP

> **✅ Status: DONE — verified in PR #59 (no code change).** Option 1
> (`z.config({ jitless: true })`) was already present in `schemas.ts`; the
> "Current state" / investigation below is kept as the historical record. See
> [README.md](README.md) for status.

> **Executor instructions**: This is an **investigate-then-decide** plan, not a
> mechanical edit. Do the investigation, then implement the option the evidence
> supports. Run verifications. Honor STOP conditions. Update `plans/README.md`
> when done.
>
> **Drift check (run first)**:
> `git diff --stat 4ca2593..HEAD -- src/lib/security/csp.ts next.config.ts src/lib/data/schemas.ts package.json`
> If any changed, re-read before proceeding.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `4ca2593`, 2026-07-02

## Why this matters

The storefront ships a Content-Security-Policy that omits `unsafe-eval` from
`script-src`. Zod 4's JIT compiles validators with `new Function()`, which
`unsafe-eval` governs. Today CSP runs in **report-only** mode
(`CSP_ENFORCE` not flipped), so validation still works and only emits violation
reports. The project's own docs state the intent to flip `CSP_ENFORCE=true` in
production. **The moment that flip happens, every client-side Zod validation
becomes a CSP violation** — at best noisy, at worst blocking validation on
personalized/money surfaces (vault, transactions, wallet). This plan makes the
CSP-enforce step safe _before_ someone flips the flag and discovers it in prod.

## Current state

The incompatibility is documented in the code itself. Confirm these before
choosing a fix:

- `src/lib/data/schemas.ts` — a comment notes Zod 4's JIT uses `new Function(...)`
  and that the CSP has no `unsafe-eval`, so validation fires a CSP report.
  (Search the file for `unsafe-eval` / `new Function` / `JIT`.)
- `src/lib/security/csp.ts` — builds the CSP (`buildCsp`). **Read it** to see the
  exact `script-src` directive and whether it uses nonces.
- `next.config.ts` — reads `CSP_ENFORCE` and applies the header (report-only vs
  enforce). Confirm the flag name and how it toggles the header.
- `package.json` — the installed Zod version (confirm it is v4.x).

## Investigation (do this before editing)

Answer these, in order — the answers pick the fix:

1. **Does current Zod expose a way to disable the JIT?** Zod 4 has a setting to
   turn off JIT compilation (validators fall back to a slower interpreted path
   that does **not** use `new Function`). Check the installed version's API
   (via Context7 / the Zod docs for the exact pinned version, and the module's
   types in `node_modules/zod`). If yes, this is the cleanest fix — no CSP
   weakening.
2. **Where does Zod run on the client?** Server-only validation wouldn't hit a
   browser CSP at all. Confirm which schemas are parsed in client components
   (the account/money surfaces parse responses via `parseOne`/`parseList` in
   server actions vs. client — determine which).
3. **Is the CSP nonce-based or hash/keyword-based?** This affects whether adding
   an exception is even coherent.

## Commands you will need

| Purpose            | Command                                                                                                                 | Expected on success                                |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Typecheck          | `npm run typecheck`                                                                                                     | exit 0                                             |
| Build              | `npm run build`                                                                                                         | exit 0                                             |
| CSP behavior check | build + `pwsh scripts/serve-standalone.ps1 -Port 4000`, then inspect response headers + browser console for CSP reports | no `unsafe-eval` violation from Zod on money pages |

## Decision & implementation

Pick the **highest** option that works, in this order (each avoids weakening CSP
more than the next):

- **Option 1 — Disable Zod JIT (preferred).** If Step 1 confirms the installed
  Zod supports disabling JIT, set it globally at app startup (a single
  configuration call in a module imported before any schema is used). This
  removes the `new Function` call entirely, so CSP needs no `unsafe-eval`.
  Verify validation still works and no CSP report fires.

- **Option 2 — Keep validation off the client.** If Zod only needs to run
  server-side (Step 2), ensure the client bundle doesn't invoke JIT-compiled
  schemas in the browser. This may be a no-op if it's already server-only —
  in which case the fix is to confirm + document that flipping `CSP_ENFORCE` is
  safe, and add a check.

- **Option 3 — Scoped `unsafe-eval` (last resort).** Only if 1 and 2 are
  infeasible. Adding `unsafe-eval` to `script-src` weakens CSP materially — do
  this only with an explicit `// SECURITY:` comment explaining why, and flag it
  loudly in your report so the operator makes the call. Do not silently weaken
  CSP.

Whichever option: **do not flip `CSP_ENFORCE=true` yourself** — that's an
operator env decision. Leave a note in your report that enforce is now safe (or
what remains before it is).

**Verify**: `npm run build` → exit 0. Then serve the standalone build and
confirm, on a money page (e.g. `/wallet` or `/transactions` while logged in),
that Zod validation works and — with CSP set to enforce locally for the test —
no `unsafe-eval` violation appears in the browser console.

## Test plan

- Primary verification is the browser-console CSP check above under a locally
  enforced CSP (temporarily set the enforce path for the test; do not commit an
  env change).
- If Option 1 is used, add/adjust a unit test confirming a representative schema
  still parses valid input and rejects invalid input (proves the interpreted
  path works). Model after the schema test found for plan 005.
- Verification: schema tests pass; no CSP `unsafe-eval` report on money pages.

## Scope

**In scope (depends on chosen option):**

- Option 1: a startup config module (new or existing app bootstrap) + possibly `src/lib/data/schemas.ts` comment update.
- Option 3: `src/lib/security/csp.ts`.
- Test file for schema parsing (shared with plan 005's file if appropriate).

**Out of scope:**

- Flipping `CSP_ENFORCE` (operator env decision).
- Upgrading/downgrading Zod major version (that's plan 007 territory / a bigger
  call) — only change Zod _configuration_, not its version, here.
- The CSP directives unrelated to `script-src`/`unsafe-eval`.

## Git workflow

- Branch: `advisor/006-zod-csp-unsafe-eval`
- Conventional commits, e.g. `fix(security): remove Zod JIT eval so CSP can enforce without unsafe-eval`
- Do NOT push or open a PR unless the operator instructed it.

## Done criteria

- [ ] Investigation questions 1-3 answered and recorded in the PR/report.
- [ ] The highest feasible option is implemented; if Option 3, it carries a `SECURITY:` comment and is flagged to the operator.
- [ ] Under a locally-enforced CSP, no `unsafe-eval` violation fires from Zod on a money page.
- [ ] Schema validation still works (tests pass).
- [ ] `npm run typecheck` and `npm run build` exit 0.
- [ ] `CSP_ENFORCE` was NOT changed in committed code.
- [ ] `plans/README.md` status row updated with which option was taken.

## STOP conditions

- None of Options 1-3 are feasible without a Zod major-version change — stop and
  report; escalate to the operator (this couples with plan 007).
- Disabling JIT measurably breaks a schema (validation behavior changes) — stop,
  report which schema.
- You cannot reproduce the CSP report locally to verify the fix — implement the
  chosen option but flag that verification is by-inspection only.

## Maintenance notes

- Record the decision (which option, why) so the next Zod upgrade doesn't
  silently reintroduce the JIT path.
- A reviewer should confirm `CSP_ENFORCE` remains an env toggle (unchanged in
  code) and that the fix doesn't weaken CSP beyond what's documented.
- This is a prerequisite for the long-standing "flip CSP to enforce in prod"
  task — note that dependency wherever that task is tracked.
