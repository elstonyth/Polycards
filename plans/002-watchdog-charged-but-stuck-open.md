# Plan 002: Add a watchdog so a charged pack/slot open can never strand the user

> **✅ Status: DONE — implemented in PR #59.** The "Current state" / steps below
> describe the pre-implementation baseline at commit `4ca2593`, kept as the
> historical record; the live code already reflects the completed work. See
> [README.md](README.md) for status — do not re-run this as a fresh checklist.

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If any
> "STOP conditions" item occurs, stop and report — do not improvise. When done,
> update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 4ca2593..HEAD -- "src/app/slots/[slug]/SlotMachineClient.tsx" "src/app/slots/[slug]/SlotReelColumn.tsx" "src/app/claw/[slug]/PackDetailClient.tsx"`
> If any file changed since this plan was written, compare the "Current state"
> excerpts against the live code before proceeding; on a mismatch, treat it as a
> STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `4ca2593`, 2026-07-02

## Why this matters

Opening a pack/slot charges the customer's credit **server-side** the moment
`openBatch()` returns `ok`. The UI then hands control to the reel animation and
only reveals the win + sell-back offer when the reel fires its `onSettled`
callback (driven by a CSS `transitionend`). Between "charged" and "settled"
there is no safety net: `handleSpin` has no `try/catch` around the post-charge
mapping, and there is no timeout that forces the flow out of `phase='spinning'`
if the settle callback never fires (interrupted transition, an unmounted/remounted
column, a thrown cosmetic mapping, a browser that drops `transitionend`). When
that happens the user has paid, sees a reel spinning forever, and can only
recover by refreshing — at which point the win is in their vault but the moment
is lost and it reads as a lost charge. This is the highest-severity _behavioral_
bug found in the audit. The fix is a bounded watchdog that guarantees the
`onSettled` result is applied even if the animation never reports completion.

## Current state

- `src/app/slots/[slug]/SlotMachineClient.tsx` — the spin controller.
  - `spinGuarded` blocks re-entry: `phase === 'resolving' || phase === 'spinning'` (line 118).
  - `handleSpin()` (lines 120-201): sets `phase='resolving'`, awaits `openBatch()`,
    and on `!res.ok` cleanly resets to `phase='idle'` (lines 139-147). On success
    it builds offers, sets `pending.current = { balance, offers, cards }`, then
    `setSpin(...)` and `setPhase('spinning')` (lines 198-200). **There is no
    try/catch around lines 149-200 and no timeout after `setPhase('spinning')`.**
  - `handleSettled` (lines 206+) is the ONLY consumer of `pending.current`; it
    nulls the ref first so a second fire is a no-op, applies the balance, sets
    offers, and prepends recent pulls. This is the function that must run for the
    user to see their result.
- `src/app/slots/[slug]/SlotReelColumn.tsx` — a single reel column. The settle
  fires from a `transitionend` path; on reduced-motion it fires via a `setTimeout(…, 0)`
  (lines 100-113). The effect resets `settled.current = false` at its top and the
  column remounts per spin (`spinKey`), so double-fire is already guarded — the
  risk is a **missed** fire, not a double fire.
- `src/app/claw/[slug]/PackDetailClient.tsx` — the pack-detail open flow shares
  the same reel/settle pattern (the audit flagged the same `pending`/settle
  shape here). Apply the same watchdog if the structure matches; if it differs
  materially, note it and limit this plan to the slots flow (see STOP conditions).

## Commands you will need

| Purpose                | Command                                                                                    | Expected on success                      |
| ---------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------- |
| Typecheck (storefront) | `npm run typecheck`                                                                        | exit 0, no errors                        |
| Lint                   | `npm run lint`                                                                             | exit 0                                   |
| Build                  | `npm run build`                                                                            | exit 0                                   |
| Verify in browser      | see Test plan (preview tools / `pwsh scripts/serve-standalone.ps1 -Port 4000` after build) | reel resolves within the watchdog window |

## Step 1: Add a settle watchdog in the spin controller

In `SlotMachineClient.tsx`, after the flow enters `phase='spinning'` (after line
200), start a timer that force-invokes the same completion path if `onSettled`
hasn't fired. Reuse `handleSettled` — it is already idempotent (it nulls
`pending.current` on first run), so a real settle followed by the watchdog (or
vice-versa) applies the result exactly once.

Target shape (adapt names to the file's existing refs/state):

```ts
// after setPhase('spinning') in handleSpin, or in an effect keyed on `spin`/phase:
// Watchdog: guarantee the charged result is applied even if the reel never
// reports transitionend. Generous — longer than the longest reel animation.
const SETTLE_WATCHDOG_MS = 6000; // reel BASE_SPIN_MS + settle buffer
const id = window.setTimeout(() => {
  if (pending.current) handleSettled(); // idempotent; no-op if already settled
}, SETTLE_WATCHDOG_MS);
// clear on unmount / next spin
```

Prefer implementing this as a `useEffect` keyed on the spin nonce (so it resets
per spin and cleans up on unmount) rather than a bare `setTimeout` inside the
async handler, to avoid a leaked timer. Whatever form you choose, the timer MUST
be cleared on unmount and when a new spin starts.

Pick `SETTLE_WATCHDOG_MS` to comfortably exceed the reel's own animation budget
— read the reel timing constant (search `SlotReelColumn.tsx` /
`src/lib/reel*.ts` for `BASE_SPIN_MS` or similar) and add a buffer. Leave a
`// ponytail:` comment noting it's a backstop, not the primary settle path.

**Verify**: `npm run typecheck` → exit 0. `npm run lint` → exit 0.

## Step 2: Guard the post-charge mapping so a thrown cosmetic step can't strand the user

Wrap the offer/winner/tier mapping in `handleSpin` (lines ~149-200, the block
that runs _after_ `openBatch` returned `ok`) so that if anything there throws,
the flow still surfaces the result the user paid for rather than dying in
`phase='resolving'`/`'spinning'`. On a caught error, at minimum: log via the
repo logger, set `pending.current` with whatever was successfully built (or
trigger `handleSettled` if offers were already assembled), and move `phase` to a
terminal state (`'spinning'` so the watchdog from Step 1 resolves it, or a
direct `handleSettled()`), never leaving it in `'resolving'`.

Keep the existing `!res.ok` path (lines 139-147) exactly as-is — that path is
correct.

**Verify**: `npm run typecheck` → exit 0.

## Step 3: Apply the same watchdog to the claw pack-detail flow (if structurally identical)

Open `src/app/claw/[slug]/PackDetailClient.tsx`. If it uses the same
`pending`-ref + `handleSettled` + `phase='spinning'` pattern, apply the
identical watchdog from Step 1. If its structure differs materially (different
state machine), do NOT force-fit — note the difference in your report and leave
it for a follow-up (see STOP conditions).

**Verify**: `npm run typecheck` → exit 0. `npm run build` → exit 0.

## Test plan

This is presentational/interaction code — the repo's convention is Playwright
capture/compare, not unit tests (see `.claude/rules/common/testing.md`). Two
acceptable verifications:

1. **Manual behavioral proof (required)**: build (`npm run build`) and serve
   (`pwsh scripts/serve-standalone.ps1 -Port 4000`), or use the preview tools.
   Trigger a spin and confirm the win + sell-back panel appears normally
   (watchdog does not fire early). Then simulate a missed settle — e.g. via the
   preview `preview_eval` tool, stop the reel transition or navigate the column
   mid-spin — and confirm the result still appears within the watchdog window
   and the balance/offers are correct.
2. **Optional unit-ish guard**: if a small pure helper is extracted for the
   watchdog decision, add a `*.spec` for it. Do not add brittle DOM assertions.

Verification: reel resolves (win shown, sell panel enabled, balance updated)
within `SETTLE_WATCHDOG_MS` even when the settle callback is prevented.

## Scope

**In scope:**

- `src/app/slots/[slug]/SlotMachineClient.tsx`
- `src/app/claw/[slug]/PackDetailClient.tsx` (only if structurally identical)
- optionally a tiny helper + its `*.spec.ts`

**Out of scope:**

- `src/app/slots/[slug]/SlotReelColumn.tsx` / `SlotReelStack.tsx` — the reel
  animation itself is correct; do not change the settle mechanism, only add a
  backstop in the controller.
- `src/lib/actions/packs.ts` (`openBatch`) — the server call and its parse are
  correct (it fails the whole batch on a bad card and returns `ok:false`).
- Any change to the charge/credit logic on the backend.

## Git workflow

- Branch: `advisor/002-open-settle-watchdog`
- Conventional commits, e.g. `fix(slots): watchdog so a charged open always resolves the reveal`
- Do NOT push or open a PR unless the operator instructed it.

## Done criteria

- [ ] `handleSpin`'s post-charge mapping is inside a try/catch that never leaves `phase` in `'resolving'`.
- [ ] A per-spin watchdog force-runs `handleSettled` (idempotently) if the reel never settles, and is cleared on unmount/next spin.
- [ ] The same watchdog is applied to the claw flow, OR its structural difference is documented and deferred.
- [ ] `npm run typecheck` exits 0, `npm run lint` exits 0, `npm run build` exits 0.
- [ ] Manual behavioral proof recorded (normal spin resolves; a prevented settle still resolves within the window).
- [ ] No files outside the in-scope list are modified (`git status`).
- [ ] `plans/README.md` status row updated.

## STOP conditions

- The `pending`/`handleSettled` pattern in "Current state" doesn't match the
  live `SlotMachineClient.tsx` (drift) — stop and report.
- `PackDetailClient.tsx` uses a different state machine — apply the fix only to
  slots, note the divergence, and leave claw for a follow-up rather than
  guessing.
- You cannot reproduce a "stuck" state to verify the watchdog even after trying
  the preview-eval interruption — report that the watchdog is added but the
  behavioral proof is by-inspection only.
- The fix appears to require changing the reel settle mechanism itself
  (out of scope) — stop and report.

## Maintenance notes

- If the reel animation duration changes, revisit `SETTLE_WATCHDOG_MS` — it must
  always exceed the real animation budget so it never pre-empts a normal spin.
- A reviewer should confirm `handleSettled` remains idempotent (nulls
  `pending.current` first) — the watchdog's safety depends on it.
- Deeper fix (deferred): the truly robust design is server-authoritative — the
  client re-fetches the pull result on reconnect/refresh so no client timer is
  load-bearing. Out of scope here; the watchdog is the pragmatic fix.
