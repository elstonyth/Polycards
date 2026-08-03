# Plan 075: One body-scroll lock — route `useChromeInert` through the refcounted lock

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 0f14da91..HEAD -- src/lib/use-chrome-inert.ts src/lib/use-modal-a11y.ts "src/app/slots/[slug]/SlotMachineClient.tsx"`
> On a mismatch with the "Current state" excerpts, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW — routes one more caller through existing, comment-documented helpers
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `0f14da91`, 2026-08-02

## Why this matters

Two independent body-scroll locks exist. `use-modal-a11y.ts` maintains a
module-level **refcounted** lock whose own comment explains that per-modal
`prevOverflow` capture is precisely the bug it replaced. `use-chrome-inert.ts`
does exactly that per-instance capture, writing `document.body.style.overflow`
directly. On the spin screen (`SlotMachineClient` calls `useChromeInert(true)`)
the body is locked while `scrollLockCount === 0`; when the odds sheet opens,
the refcounted lock records `preLockOverflow = 'hidden'` — capturing the
chrome-inert lock as though it were the pre-modal page state. If
chrome-inert's cleanup runs before a still-open sheet's (React destroys a
parent's effects before its children's during unmount — e.g. navigating away
with the sheet open), the sheet's later unlock writes `'hidden'` back onto a
page with no modal: the whole site becomes unscrollable until a hard reload —
the exact stranding `scripts/qa-pool-modal.mjs` guards against for the other
modal stack.

## Current state

`src/lib/use-chrome-inert.ts:12-32` (whole hook):

```ts
export function useChromeInert(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const nodes = Array.from(
      document.querySelectorAll<HTMLElement>('[data-site-chrome]'),
    );
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    for (const n of nodes) {
      n.setAttribute('inert', '');
      n.setAttribute('aria-hidden', 'true');
    }
    return () => {
      document.body.style.overflow = prevOverflow;
      ...
    };
  }, [active]);
}
```

`src/lib/use-modal-a11y.ts:13-31` — the refcounted lock (module-private today):

```ts
// Body scroll lock is reference-counted at module level so stacked modals can
// close in ANY order: the first open captures the pre-modal overflow, the last
// close restores it. Per-modal prevOverflow capture depended on strict LIFO —
// a bottom dialog closing under a still-open top overlay restored scrolling
// early, and the overlay's later cleanup then stranded body{overflow:hidden}.
let scrollLockCount = 0;
let preLockOverflow = '';

function lockBodyScroll(): void {
  if (scrollLockCount++ === 0) {
    preLockOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }
}

function unlockBodyScroll(): void {
  scrollLockCount = Math.max(0, scrollLockCount - 1);
  if (scrollLockCount === 0) document.body.style.overflow = preLockOverflow;
}
```

Call sites: `SlotMachineClient.tsx:124` → `useChromeInert(true)`; the same
component renders `OddsSheet`, which locks via `useModalA11y`
(`src/app/slots/[slug]/OddsSheet.tsx`).

## Commands you will need

| Purpose    | Command         | Expected                          |
| ---------- | --------------- | --------------------------------- |
| Check      | `npm run check` | exit 0                            |
| Unit tests | `npm test`      | all pass, incl. the new lock test |

## Scope

**In scope**:

- `src/lib/use-modal-a11y.ts` (export the two helpers — or move them to a new
  `src/lib/scroll-lock.ts` imported by both hooks; prefer the export, it's
  the smaller diff)
- `src/lib/use-chrome-inert.ts` (call the helpers instead of writing
  `body.style.overflow`; keep the `inert`/`aria-hidden` half untouched)
- New `src/lib/__tests__/scroll-lock.test.ts`

**Out of scope**:

- Any modal component; `useModalA11y`'s trap/stack/Escape logic; `OddsSheet`.
- `useChromeInert`'s inert/aria-hidden behavior and its `[data-site-chrome]`
  selector.

## Git workflow

- Branch: `advisor/075-unify-scroll-lock`
- Conventional commit, e.g. `fix(a11y): route useChromeInert through the refcounted body-scroll lock`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Export the lock helpers

In `use-modal-a11y.ts`, add `export` to `lockBodyScroll` and
`unlockBodyScroll` (leave `scrollLockCount`/`preLockOverflow` private). Add
one comment line: exported for `useChromeInert` — every body-scroll lock in
the app must go through this refcount.

**Verify**: `npm run check` → exit 0.

### Step 2: Use them in `useChromeInert`

Replace the `prevOverflow` capture/set/restore with `lockBodyScroll()` on
activate and `unlockBodyScroll()` in the cleanup. Delete the local
`prevOverflow` variable.

**Verify**: `npm run check` → exit 0;
`grep -n "body.style.overflow" src/lib/use-chrome-inert.ts` → no matches.

### Step 3: Test the interleaving that used to strand

New `src/lib/__tests__/scroll-lock.test.ts` (vitest + jsdom — jsdom provides
`document.body`; model file layout on any existing test under
`src/lib/__tests__/`). The helpers are plain functions — test them directly,
no React rendering needed. Cases:

1. lock → unlock restores the original overflow value.
2. lock (chrome) → lock (modal) → unlock (chrome) → unlock (modal) restores
   the original value — the out-of-order interleaving that previously stranded
   `'hidden'`.
3. Double-unlock does not go negative and does not clobber a later lock
   (`Math.max(0, …)` branch).
4. The pre-lock value is captured at the FIRST lock only: lock A (overflow
   `''`), lock B, unlock A, unlock B → body overflow `''`, not `'hidden'`.

Note: the module keeps state between tests — reset by unlocking down to zero
in `afterEach`, or import-fresh via `vi.resetModules()`.

**Verify**: `npm test` → all pass including 4 new cases.

## Test plan

Covered in Step 3. Manual (optional, if the stack is up): open
`/slots/bronze-pack/spin?demo=1`, open Pull Odds, navigate Back, then confirm
`document.body.style.overflow` is not `'hidden'` on the destination page —
this is the runtime repro the audit flagged as needing confirmation.

## Done criteria

- [ ] `grep -rn "body.style.overflow" src/ --include=*.ts --include=*.tsx`
      matches ONLY inside `use-modal-a11y.ts` (or the new scroll-lock module)
- [ ] 4 new lock tests pass; `npm run check` and `npm test` exit 0
- [ ] `useChromeInert`'s inert/aria-hidden behavior unchanged (diff shows no
      edits to that half)
- [ ] No files outside scope modified; `plans/README.md` row updated

## STOP conditions

- The excerpts don't match (drift).
- The grep in Done criteria reveals a THIRD direct `body.style.overflow`
  writer elsewhere in `src/` — fix is the same pattern, but report it first
  (scope grows).
- Circular-import trouble between the two hooks — then create
  `src/lib/scroll-lock.ts` and have both import it (the alternative already
  authorized in Scope).

## Maintenance notes

- Rule going forward (worth a comment at the helpers): no code outside the
  scroll-lock module writes `document.body.style.overflow`.
- Reviewer: confirm the spin screen still suppresses page scroll while
  active (the refcount now holds it), and that the demo spin path
  (`?demo=1`) — the only spinnable flow without login — behaves.
