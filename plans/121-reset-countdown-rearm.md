# Plan 121: Let ResetCountdown retry a rollover refresh instead of pinning for the week

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 30eded61..HEAD -- src/app/leaderboard/ResetCountdown.tsx src/app/leaderboard/__tests__/reset-countdown.test.ts src/lib/reset-countdown.ts`
> On any in-scope change since `30eded61`, compare the "Current state"
> excerpts before proceeding; on a mismatch, treat as STOP.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: MED — the fix must not reintroduce a refresh-per-tick loop;
  the existing tests that pin "no loop" are deliberately REVISED here, so
  the reviewer must check the new bounds, not just green tests
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `30eded61`, 2026-08-22

## Why this matters

`ResetCountdown` (PR #467) refreshes the `/leaderboard` server components
exactly once when the weekly deadline passes, keyed on the deadline value:
`refetchedFor.current = resetAt` is set before `router.refresh()`, and the
effect re-arms only when a **different** `resetAt` arrives. If the
client's clock runs ahead of the server's (minutes of skew is routine),
the refresh fires early, the server — still before the reset — recomputes
the **same** `resetAt`, the effect deps don't change, and the guard stays
pinned: no further refresh fires for the rest of the week. The user sees
a healthy ticking countdown (the display math rolls forward by design)
sitting over last week's pool, stages and standings — precisely the state
the component exists to prevent. The component's own docblock states the
assumption without guarding it: "the new `resetAt` re-runs this effect
and arms the next one."

## Current state

- `src/app/leaderboard/ResetCountdown.tsx` — the component (client). The
  guard as of `30eded61` (lines 34–55):

  ```tsx
  const refetchedFor = useRef<number | null>(null);

  useEffect(() => {
    const tick = () => {
      const now = Date.now();
      // … Testing the instant (not a jump in remaining time) keeps a clock
      // that steps BACKWARDS — an NTP correction, waking from sleep — from
      // reading as a rollover.
      if (refetchedFor.current !== resetAt && now >= resetAt) {
        refetchedFor.current = resetAt;
        router.refresh();
      }
      const ms = resetMsLeft(resetAt, now);
      setLeft(formatResetLeft(ms));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [resetAt, router]);
  ```

- `src/lib/reset-countdown.ts` — pure math; `resetMsLeft` rolls a stale
  deadline forward whole weeks (`:128-131`), which is why the DISPLAY
  stays healthy while the data is stale. Untouched by this plan.
- `src/app/leaderboard/__tests__/reset-countdown.test.ts` — component
  tests (vitest + fake timers + a mocked `router.refresh`; `mount()` /
  `advance()` helpers at the top). Two cases pin the CURRENT
  single-refresh behavior and must be revised (quoted so you recognize
  them):
  - "refreshes once when the deadline passes, then counts the new week" —
    `await advance(60_000); expect(refresh).toHaveBeenCalledTimes(1);`
  - "does not refresh again when the refreshed resetAt arrives" — ends
    with `expect(refresh).toHaveBeenCalledTimes(1);` after remounting
    with `RESET_AT + WEEK_MS`.
    The other three cases (tick-down, refresh-on-late-mount,
    backwards-clock-is-skew) must keep passing UNCHANGED.

Design constraints the fix must honor:

- The instant test (`now >= resetAt`) stays — the backwards-clock case
  depends on it (an NTP step back must not refetch).
- React Strict Mode double-mount must not double-refresh beyond what the
  existing behavior allows (the ref is per-mount; the existing
  "refreshes on mount when hydration starts after the deadline" test
  documents one refresh per mount as acceptable).
- Bounded: a server that NEVER rolls (challenge disabled mid-week,
  backend wedged) must not be polled forever.

## Commands you will need

| Purpose                     | Command                                                                | Expected           |
| --------------------------- | ---------------------------------------------------------------------- | ------------------ |
| Typecheck                   | `npm run typecheck`                                                    | exit 0             |
| Component tests             | `npx vitest run src/app/leaderboard/__tests__/reset-countdown.test.ts` | all pass           |
| Lib tests (must not change) | `npx vitest run src/lib/__tests__/reset-countdown.test.ts`             | all pass, no edits |
| Full suite / lint / format  | `npm test` / `npm run lint` / `npm run format:check`                   | green              |

## Scope

**In scope**:

- `src/app/leaderboard/ResetCountdown.tsx`
- `src/app/leaderboard/__tests__/reset-countdown.test.ts`

**Out of scope**:

- `src/lib/reset-countdown.ts` and its test file — the pure math is
  correct.
- `WeeklyChallenge.tsx` / the server components — the fix is client-side
  retry policy only.
- Any server-time-sync scheme (sending server `now` and offsetting) —
  heavier than the problem; recorded as the escalation path if skew ever
  proves larger than the retry window.

## Git workflow

- Branch: `advisor/121-reset-countdown-rearm`
- Conventional commit, e.g. `fix(challenge): retry the rollover refresh while the server still returns the old deadline`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Replace the pin with a bounded retry ladder

In `ResetCountdown.tsx`, replace the single-shot guard with per-deadline
retry state:

```tsx
// One refresh when the deadline passes — and, because a client clock a few
// minutes AHEAD reaches the instant while the server still computes the
// SAME resetAt (so the effect never re-arms), a bounded retry ladder: up to
// MAX_REFRESHES refreshes, RETRY_MS apart, per deadline value. The ladder
// stops the moment the server hands back a new resetAt (new deadline = new
// effect run = fresh state) or the budget is spent, so a wedged backend is
// polled at most MAX_REFRESHES times, never per-tick.
const RETRY_MS = 20_000;
const MAX_REFRESHES = 5;

const refetchState = useRef<{ for: number; count: number; at: number } | null>(
  null,
);

useEffect(() => {
  const tick = () => {
    const now = Date.now();
    if (now >= resetAt) {
      const s =
        refetchState.current?.for === resetAt ? refetchState.current : null;
      if (!s) {
        refetchState.current = { for: resetAt, count: 1, at: now };
        router.refresh();
      } else if (s.count < MAX_REFRESHES && now - s.at >= RETRY_MS) {
        s.count += 1;
        s.at = now;
        router.refresh();
      }
    }
    const ms = resetMsLeft(resetAt, now);
    setLeft(formatResetLeft(ms));
  };
  tick();
  const id = setInterval(tick, 1000);
  return () => clearInterval(id);
}, [resetAt, router]);
```

Keep (adapt) the existing comment about testing the instant so a
backwards-stepping clock never reads as a rollover — that property is
preserved (`now >= resetAt` still gates everything). Update the docblock
sentence "the new `resetAt` re-runs this effect and arms the next one" to
also state the same-`resetAt` retry ladder and its bounds.

**Verify**: `npm run typecheck` → exit 0.

### Step 2: Revise the two pinned tests, add the skew case

In `src/app/leaderboard/__tests__/reset-countdown.test.ts`:

1. Revise "refreshes once when the deadline passes, then counts the new
   week": the immediate behavior is unchanged (1 refresh at the instant);
   the 60s follow-up now expects the ladder:
   `await advance(60_000); expect(refresh).toHaveBeenCalledTimes(4);`
   (1 at t=0 + retries at 20/40/60s). Rename it to state the new
   contract, e.g. "refreshes at the deadline, then retries every 20s
   while the server returns the same deadline".
2. Add the bound case: continue advancing well past the budget —
   `await advance(10 * 60_000); expect(refresh).toHaveBeenCalledTimes(5);`
   (MAX_REFRESHES) — a wedged server is polled exactly 5 times, then
   silence.
3. Revise "does not refresh again when the refreshed resetAt arrives":
   keep its structure; after remounting with `RESET_AT + WEEK_MS` and
   advancing 2s, the count stays at whatever it was before the remount
   (the new deadline is in the future — no further refresh). If the
   remount happens after only `advance(4000)`, that count is 1 — the
   assertion stays `toHaveBeenCalledTimes(1)` and now proves the ladder
   STOPS on a new deadline. Rename to say so ("a new resetAt stops the
   retry ladder").
4. Add the skew scenario this plan exists for: mount with `RESET_AT`,
   advance past the deadline (1 refresh), advance 20s (2nd refresh — the
   retry), then remount with `RESET_AT + WEEK_MS` (the server finally
   rolled) and advance 60s → no further calls. Assert the total.
5. The three untouched cases (tick-down without refresh before the
   deadline, refresh-on-late-mount, backwards-clock-is-skew) must pass
   WITHOUT edits — if any fails, your Step 1 broke a preserved property;
   fix the component, not the test.

**Verify**:
`npx vitest run src/app/leaderboard/__tests__/reset-countdown.test.ts` →
all pass (≥7 cases). `npx vitest run src/lib/__tests__/reset-countdown.test.ts`
→ all pass with zero edits (`git diff --stat src/lib/__tests__/` empty).

### Step 3: Full gates

**Verify**: `npm test` → full suite green. `npm run lint`,
`npm run format:check` → exit 0.

## Test plan

Step 2 is the test plan; exemplar = the file's own existing
`mount()`/`advance()` fake-timer harness. The critical assertions: the
20s cadence (not per-tick), the MAX_REFRESHES ceiling, and ladder-stop on
a new `resetAt`.

## Done criteria

- [ ] `npm run typecheck`, `npm run lint`, `npm run format:check` exit 0
- [ ] Component test file: all pass, ≥7 cases, including the cadence, the
      ceiling, and the ladder-stop cases
- [ ] `src/lib/__tests__/reset-countdown.test.ts` and
      `src/lib/reset-countdown.ts` untouched (`git diff --stat` on both empty)
- [ ] `grep -n "MAX_REFRESHES" src/app/leaderboard/ResetCountdown.tsx` → ≥2 (const + use)
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

- Excerpt mismatch (drift).
- The backwards-clock test fails after Step 1 — the instant-gate property
  was broken; report rather than weakening that test.
- You find yourself adding state outside the ref (a `useState` for retry
  count would re-render per retry for no UI benefit) or a second
  interval — the single 1s interval is the only clock here.

## Maintenance notes

- If real-world skew ever exceeds the ~100s window this ladder covers
  (5 × 20s), the escalation path is server-time sync: render the server's
  `now` alongside `resetAt` and compute the offset once at mount. Not
  worth it until observed.
- `router.refresh()` on an unwedged server ends the ladder naturally by
  delivering a new `resetAt`; the ladder's cost ceiling on a wedged one is
  5 refreshes/week/tab.
- Reviewer: check the revised tests' renamed titles actually describe the
  ladder — green tests with stale names are how the last pin survived.
