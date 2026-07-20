# Notification Toasts — PR 2: Toast System — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface notification-feed events as stacked, accessible toasts driven by a 60s poll and a per-device watermark, and give the flows that currently confirm nothing a confirmation.

**Architecture:** Every decision lives in pure functions under `src/lib/notifications/` — `toastQueue` (a reducer) and `selectToastable` (watermark + policy + summary rule). Two nested providers consume them: `ToastProvider` is pure UI that knows nothing about notifications, and `NotificationsProvider` is a headless domain layer that polls and calls `useToast()`. This split is not stylistic — the repo has **no** `@testing-library`, so anything inside a component is untestable, and the pure core is the only way the hard logic gets covered.

**Tech Stack:** Next.js App Router (client components), React 19, TypeScript, vitest (+ jsdom per-file), Tailwind v4 (CSS-first, no config file).

**Depends on:** PR 1 (`docs/superpowers/plans/2026-07-20-notification-toasts-pr1-backend-feed.md`) must be merged. This plan imports `copyFor`, `NOTIFICATION_COPY`, `NotificationVariant` and `ToastPolicy` from `src/lib/notifications/copy.ts`, which PR 1 creates.

**Spec:** `docs/superpowers/specs/2026-07-20-notification-toasts-design.md`

## Global Constraints

- **No new dependencies.** In particular there is no `@testing-library` and none is to be added; components are verified in the browser, logic is verified in vitest.
- **All test files must be `.test.ts`.** `vitest.config.ts` sets `include: ['src/**/*.test.ts']` — a `.test.tsx` file is **silently ignored**, not an error. Never put a test in a `.tsx` file.
- **jsdom is opt-in per file** via a `// @vitest-environment jsdom` comment on line 1. `jsdom` is installed; there is no `setupFiles` and no `globals: true`, so every test imports `describe/it/expect/vi` from `'vitest'` explicitly.
- **This PR touches only `src/`.** No backend files, so the Node-script editing rule from PR 1 does not apply — use Edit/Write normally.
- **The Stop hook runs the storefront vitest suite** and blocks on failure. A red test ends the session.
- **Preserve the always-mounted `role="status"` live region.** `SuccessToast`'s header comment records why: a live region inserted together with its content is skipped by some screen-reader/browser combinations. The provider must render the region unconditionally, even with an empty queue.
- **Preserve `motion-safe:` prefixes** on toast animations — that is the repo's reduced-motion mechanism.
- **Errors stay inline.** No `role="alert"` inline error in any touched component may be converted to a toast. Several carry interactive content (a `Log in` button) or diagnostics a user needs to read at their own pace.
- **Commit messages** use Conventional Commits and end with:
  ```
  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  ```

## Scope correction — read before Task 9

Brainstorming Q7 chose "migrate the existing toast + add toasts to the money and irreversible flows," on the understanding that those flows confirmed nothing. Recon showed that is only half true:

- **`TopUpSheet`** already renders a full in-panel success screen — `CheckCircle2`, `"{rm} ADDED"`, the new balance, and an amber replay note when the charge was idempotently replayed. It does not auto-close.
- **`VaultClient`'s buyback** already sets a **persistent** inline `role="status"` (`notice`). The code comment at its call site records that the user complaint being fixed was *"sold, no money"* — it is deliberately persistent.

Replacing either with a toast that vanishes after 5 seconds is a downgrade, and for the same reason errors stay inline: a money confirmation should not time out. So this plan adopts toasts **only where nothing confirms today**, and leaves working persistent confirmations in place.

| Flow | Today | This PR |
|---|---|---|
| `VaultClient` delivery request | `SuccessToast`, local state | **Migrate** to the provider — no behavior change |
| `VaultClient` buyback | Persistent inline `notice` | **Leave alone** |
| `TopUpSheet` | In-panel success screen | **Leave alone** |
| `RequestDeliveryModal` → save address | Nothing | **Add** "Address saved." |
| `VipVouchers` → claim | Nothing (row silently vanishes) | **Add** "{voucher} claimed." |
| `WithdrawForm` | Inline panel, unmounts on a 1500 ms uncleared timer | **Add** toast + fix the timer |

Net effect is the same as Q7's intent — every money/irreversible action confirms — with two fewer regressions. **If you disagree, say so before Task 9; Tasks 1–8 are unaffected.**

---

## File Structure

**Created**
- `src/lib/notifications/toast-queue.ts` — the queue reducer. Enqueue, dismiss, suppress, release, drain. No React.
- `src/lib/notifications/__tests__/toast-queue.test.ts`
- `src/lib/notifications/select-toastable.ts` — watermark + policy + summary rule.
- `src/lib/notifications/__tests__/select-toastable.test.ts`
- `src/lib/notifications/watermark.ts` — per-customer `localStorage` read/write.
- `src/lib/notifications/__tests__/watermark.test.ts`
- `src/components/ui/Toast.tsx` — one rendered toast, generalized from `SuccessToast`.
- `src/components/notifications/ToastProvider.tsx` — queue owner + live region + `useToast` + `useSuppressToasts`.
- `src/components/notifications/NotificationsProvider.tsx` — poll, watermark, unread count, `bump()`.

**Modified**
- `src/app/layout.tsx` — mount both providers.
- `src/components/NotificationBell.tsx` — read the count from context, drop its own poll.
- `src/app/(account)/vault/VaultClient.tsx` — migrate to `useToast`, delete local toast state.
- `src/components/account/RequestDeliveryModal.tsx` — address-saved toast.
- `src/app/(account)/vip/VipVouchers.tsx` — voucher-claimed toast.
- `src/components/rewards/WithdrawForm.tsx` — toast + timer fix.
- `src/app/slots/[slug]/SlotMachineClient.tsx` — suppress toasts + `bump()` after settle.
- `src/components/rewards/PrizeReveal.tsx` — suppress toasts.
- `src/components/account/AvatarCropper.tsx` — suppress toasts.

**Deleted**
- `src/components/ui/SuccessToast.tsx` — superseded by `Toast.tsx` + provider, and it has exactly one consumer.

---

### Task 1: Toast queue reducer

The whole stacking, capping, dedupe and suppress-drain behavior as a pure reducer. This is the only way any of it gets tested — there is no component test harness in this repo.

**Files:**
- Create: `src/lib/notifications/toast-queue.ts`
- Create: `src/lib/notifications/__tests__/toast-queue.test.ts`

**Interfaces:**
- Consumes: `NotificationVariant` from `@/lib/notifications/copy` (PR 1).
- Produces:
  - `type ToastSpec = { key: string; title: string; body?: string | null; variant: NotificationVariant; href?: string | null; action?: string | null }`
  - `type ToastState = { visible: ToastSpec[]; queued: ToastSpec[]; suppressed: boolean; seen: string[] }`
  - `type ToastAction = { type: 'enqueue'; toasts: ToastSpec[] } | { type: 'dismiss'; key: string } | { type: 'suppress' } | { type: 'release' }`
  - `const MAX_VISIBLE = 3`
  - `const initialToastState: ToastState`
  - `function toastQueue(state: ToastState, action: ToastAction): ToastState`

- [ ] **Step 1: Write the failing test**

Create `src/lib/notifications/__tests__/toast-queue.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  toastQueue,
  initialToastState,
  MAX_VISIBLE,
  type ToastSpec,
  type ToastState,
} from '../toast-queue';

const spec = (key: string): ToastSpec => ({
  key,
  title: `Toast ${key}`,
  variant: 'info',
});

const enqueue = (state: ToastState, ...keys: string[]) =>
  toastQueue(state, { type: 'enqueue', toasts: keys.map(spec) });

describe('enqueue and visibility cap', () => {
  it('shows a single toast', () => {
    const s = enqueue(initialToastState, 'a');
    expect(s.visible.map((t) => t.key)).toEqual(['a']);
    expect(s.queued).toEqual([]);
  });

  it(`shows at most ${MAX_VISIBLE} and queues the rest in order`, () => {
    const s = enqueue(initialToastState, 'a', 'b', 'c', 'd', 'e');
    expect(s.visible.map((t) => t.key)).toEqual(['a', 'b', 'c']);
    expect(s.queued.map((t) => t.key)).toEqual(['d', 'e']);
  });

  it('promotes the oldest queued toast when one is dismissed', () => {
    let s = enqueue(initialToastState, 'a', 'b', 'c', 'd');
    s = toastQueue(s, { type: 'dismiss', key: 'b' });
    expect(s.visible.map((t) => t.key)).toEqual(['a', 'c', 'd']);
    expect(s.queued).toEqual([]);
  });

  it('dismissing an unknown key is a no-op', () => {
    const s = enqueue(initialToastState, 'a');
    expect(toastQueue(s, { type: 'dismiss', key: 'zzz' })).toEqual(s);
  });
});

describe('dedupe', () => {
  it('never shows the same key twice, even across separate enqueues', () => {
    let s = enqueue(initialToastState, 'a');
    s = enqueue(s, 'a', 'b');
    expect(s.visible.map((t) => t.key)).toEqual(['a', 'b']);
  });

  it('does not re-show a key after it was dismissed', () => {
    let s = enqueue(initialToastState, 'a');
    s = toastQueue(s, { type: 'dismiss', key: 'a' });
    s = enqueue(s, 'a');
    expect(s.visible).toEqual([]);
    expect(s.queued).toEqual([]);
  });

  it('bounds the seen set so a long session cannot grow it without limit', () => {
    let s = initialToastState;
    for (let i = 0; i < 500; i++) s = enqueue(s, `k${i}`);
    expect(s.seen.length).toBeLessThanOrEqual(200);
    // The most recent key is still remembered — trimming drops the oldest.
    expect(s.seen).toContain('k499');
  });
});

describe('suppression', () => {
  it('queues instead of showing while suppressed', () => {
    let s = toastQueue(initialToastState, { type: 'suppress' });
    s = enqueue(s, 'a', 'b');
    expect(s.visible).toEqual([]);
    expect(s.queued.map((t) => t.key)).toEqual(['a', 'b']);
  });

  it('drains on release, respecting the cap', () => {
    let s = toastQueue(initialToastState, { type: 'suppress' });
    s = enqueue(s, 'a', 'b', 'c', 'd');
    s = toastQueue(s, { type: 'release' });
    expect(s.visible.map((t) => t.key)).toEqual(['a', 'b', 'c']);
    expect(s.queued.map((t) => t.key)).toEqual(['d']);
  });

  it('pushes already-visible toasts back into the queue when suppression starts', () => {
    // An immersive surface opening must not leave a toast painted over it.
    let s = enqueue(initialToastState, 'a', 'b');
    s = toastQueue(s, { type: 'suppress' });
    expect(s.visible).toEqual([]);
    expect(s.queued.map((t) => t.key)).toEqual(['a', 'b']);
    s = toastQueue(s, { type: 'release' });
    expect(s.visible.map((t) => t.key)).toEqual(['a', 'b']);
  });

  it('never DROPS a toast raised while suppressed', () => {
    // Queue-don't-drop is what makes suppression safe; without it,
    // suppression is just a fancier way of losing notifications.
    let s = toastQueue(initialToastState, { type: 'suppress' });
    s = enqueue(s, 'a');
    s = toastQueue(s, { type: 'release' });
    expect(s.visible.map((t) => t.key)).toEqual(['a']);
  });

  it('release while not suppressed is harmless', () => {
    const s = enqueue(initialToastState, 'a');
    expect(toastQueue(s, { type: 'release' }).visible.map((t) => t.key)).toEqual(
      ['a'],
    );
  });
});

describe('purity', () => {
  it('never mutates the state it is given', () => {
    const before = enqueue(initialToastState, 'a', 'b');
    const snapshot = JSON.parse(JSON.stringify(before));
    toastQueue(before, { type: 'enqueue', toasts: [spec('c')] });
    toastQueue(before, { type: 'dismiss', key: 'a' });
    toastQueue(before, { type: 'suppress' });
    expect(JSON.parse(JSON.stringify(before))).toEqual(snapshot);
  });

  it('enqueueing nothing returns an equal state', () => {
    const s = enqueue(initialToastState, 'a');
    expect(toastQueue(s, { type: 'enqueue', toasts: [] })).toEqual(s);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm run test -- src/lib/notifications/__tests__/toast-queue.test.ts
```

Expected: FAIL — `Failed to resolve import "../toast-queue"`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/notifications/toast-queue.ts`:

```ts
import type { NotificationVariant } from '@/lib/notifications/copy';

/** One toast to render. `key` is the dedupe identity — a notification id for
 *  feed toasts, or a caller-chosen string for client confirmations. */
export type ToastSpec = {
  key: string;
  title: string;
  body?: string | null;
  variant: NotificationVariant;
  href?: string | null;
  action?: string | null;
};

export type ToastState = {
  visible: ToastSpec[];
  queued: ToastSpec[];
  suppressed: boolean;
  /** Keys already accepted once. Prevents a poll that re-returns the same
   *  notification from re-showing it, and stops a dismissed toast coming back. */
  seen: string[];
};

export type ToastAction =
  | { type: 'enqueue'; toasts: ToastSpec[] }
  | { type: 'dismiss'; key: string }
  | { type: 'suppress' }
  | { type: 'release' };

/** Three is the most that fits under the header without covering content. */
export const MAX_VISIBLE = 3;

/** The feed returns at most 50 rows, so 200 keys covers several polls' worth of
 *  history. Unbounded, this array would grow for the life of the tab. */
const MAX_SEEN = 200;

export const initialToastState: ToastState = {
  visible: [],
  queued: [],
  suppressed: false,
  seen: [],
};

/** Move queued toasts into view up to the cap. No-op while suppressed. */
function drain(state: ToastState): ToastState {
  if (state.suppressed) return state;
  const room = MAX_VISIBLE - state.visible.length;
  if (room <= 0 || state.queued.length === 0) return state;
  return {
    ...state,
    visible: [...state.visible, ...state.queued.slice(0, room)],
    queued: state.queued.slice(room),
  };
}

export function toastQueue(state: ToastState, action: ToastAction): ToastState {
  switch (action.type) {
    case 'enqueue': {
      const seen = new Set(state.seen);
      const fresh = action.toasts.filter((t) => !seen.has(t.key));
      if (fresh.length === 0) return state;
      const nextSeen = [...state.seen, ...fresh.map((t) => t.key)];
      return drain({
        ...state,
        queued: [...state.queued, ...fresh],
        // Trim from the front: the oldest keys are the least likely to come
        // back, and keeping the newest is what prevents an immediate re-show.
        seen:
          nextSeen.length > MAX_SEEN
            ? nextSeen.slice(nextSeen.length - MAX_SEEN)
            : nextSeen,
      });
    }

    case 'dismiss': {
      if (!state.visible.some((t) => t.key === action.key)) return state;
      return drain({
        ...state,
        visible: state.visible.filter((t) => t.key !== action.key),
      });
    }

    case 'suppress': {
      if (state.suppressed) return state;
      // Anything on screen goes BACK to the queue rather than staying painted
      // over the immersive surface that just opened. It is not lost — release
      // drains it in the same order.
      return {
        ...state,
        suppressed: true,
        visible: [],
        queued: [...state.visible, ...state.queued],
      };
    }

    case 'release': {
      if (!state.suppressed) return state;
      return drain({ ...state, suppressed: false });
    }

    default:
      return state;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npm run test -- src/lib/notifications/__tests__/toast-queue.test.ts
```

Expected: PASS — 4 suites, 13 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/notifications/toast-queue.ts \
        src/lib/notifications/__tests__/toast-queue.test.ts
git commit -m "$(cat <<'EOF'
feat(notifications): toast queue reducer

Stacking cap, dedupe by key, and suppress/release as a pure reducer.

Suppression pushes visible toasts back into the queue rather than
dropping them — queue-don't-drop is what makes suppression safe, since
otherwise it is just a fancier way of losing notifications.

Pure because it has to be: the repo has no component test harness, so a
reducer is the only form this logic can be covered in.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Watermark storage

**Files:**
- Create: `src/lib/notifications/watermark.ts`
- Create: `src/lib/notifications/__tests__/watermark.test.ts`

**Interfaces:**
- Produces:
  - `function watermarkKey(customerId: string): string`
  - `function readWatermark(customerId: string): string | null`
  - `function writeWatermark(customerId: string, iso: string): void`

Keyed per customer so logging out and back in as someone else cannot inherit the previous account's watermark.

- [ ] **Step 1: Write the failing test**

Create `src/lib/notifications/__tests__/watermark.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { watermarkKey, readWatermark, writeWatermark } from '../watermark';

describe('watermark storage', () => {
  beforeEach(() => localStorage.clear());

  it('is null before anything has been shown on this device', () => {
    expect(readWatermark('cus_1')).toBeNull();
  });

  it('round-trips a timestamp', () => {
    writeWatermark('cus_1', '2026-07-20T10:00:00.000Z');
    expect(readWatermark('cus_1')).toBe('2026-07-20T10:00:00.000Z');
  });

  it('scopes by customer so a different account never inherits it', () => {
    writeWatermark('cus_1', '2026-07-20T10:00:00.000Z');
    expect(readWatermark('cus_2')).toBeNull();
    expect(watermarkKey('cus_1')).not.toBe(watermarkKey('cus_2'));
  });

  it('ignores a stored value that is not a usable timestamp', () => {
    localStorage.setItem(watermarkKey('cus_1'), 'garbage');
    expect(readWatermark('cus_1')).toBeNull();
  });

  it('survives storage being unavailable', () => {
    // Safari private mode throws on setItem; a dead watermark must degrade to
    // "seed again", never crash the provider that calls it on every poll.
    const setItem = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new Error('QuotaExceededError');
      });
    expect(() => writeWatermark('cus_1', '2026-07-20T10:00:00.000Z')).not.toThrow();
    setItem.mockRestore();

    const getItem = vi
      .spyOn(Storage.prototype, 'getItem')
      .mockImplementation(() => {
        throw new Error('SecurityError');
      });
    expect(readWatermark('cus_1')).toBeNull();
    getItem.mockRestore();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm run test -- src/lib/notifications/__tests__/watermark.test.ts
```

Expected: FAIL — `Failed to resolve import "../watermark"`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/notifications/watermark.ts`:

```ts
// Per-device record of how far the toast layer has already announced.
//
// Deliberately separate from `read_at`: the bell badge answers "what haven't
// you dealt with", the watermark answers "what has this device already shown
// you". Coupling them breaks both — a toast that marks read guts the badge,
// and one that doesn't re-pops forever.
//
// Keyed by customer id so logging out and back in as a different account
// cannot inherit the previous account's position.

const PREFIX = 'polycards:notif-seen:';

export function watermarkKey(customerId: string): string {
  return `${PREFIX}${customerId}`;
}

/** The newest created_at already announced on this device, or null. */
export function readWatermark(customerId: string): string | null {
  try {
    const raw = localStorage.getItem(watermarkKey(customerId));
    if (!raw) return null;
    // A value we cannot compare is worse than none: it would make every
    // comparison fall through and re-announce the whole feed.
    return Number.isFinite(new Date(raw).getTime()) ? raw : null;
  } catch {
    // Storage disabled or unavailable — behave like a fresh device.
    return null;
  }
}

export function writeWatermark(customerId: string, iso: string): void {
  try {
    localStorage.setItem(watermarkKey(customerId), iso);
  } catch {
    // Quota or private-mode failure. The cost is re-announcing next session,
    // which is strictly better than throwing inside a poll.
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npm run test -- src/lib/notifications/__tests__/watermark.test.ts
```

Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/notifications/watermark.ts \
        src/lib/notifications/__tests__/watermark.test.ts
git commit -m "$(cat <<'EOF'
feat(notifications): per-device watermark storage

Customer-scoped localStorage position for the toast layer, kept separate
from read_at so the bell badge and the toast keep answering different
questions. Degrades to "fresh device" when storage is unavailable rather
than throwing inside a poll.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Toastable selection

The rule set from the spec — silent seed, 1–3 individual pops, 4+ summary, `never`-policy filtering — in one function.

**Files:**
- Create: `src/lib/notifications/select-toastable.ts`
- Create: `src/lib/notifications/__tests__/select-toastable.test.ts`

**Interfaces:**
- Consumes: `ToastPolicy` from `@/lib/notifications/copy` (PR 1).
- Produces:
  - `type FeedItem = { id: string; template: string; createdAt: string; data: Record<string, unknown> | null }`
  - `const SUMMARY_THRESHOLD = 4`
  - `type SelectResult = { pops: FeedItem[]; summaryCount: number; nextWatermark: string | null }`
  - `function selectToastable(items: FeedItem[], watermark: string | null, policyFor: (template: string) => ToastPolicy): SelectResult`

- [ ] **Step 1: Write the failing test**

Create `src/lib/notifications/__tests__/select-toastable.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  selectToastable,
  SUMMARY_THRESHOLD,
  type FeedItem,
} from '../select-toastable';
import type { ToastPolicy } from '../copy';

// 'never' templates stand in for voucher_claimed / topup_credited / reward_won.
const policyFor = (template: string): ToastPolicy =>
  template === 'quiet' ? 'never' : 'always';

const item = (id: string, minute: number, template = 'loud'): FeedItem => ({
  id,
  template,
  createdAt: `2026-07-20T10:${String(minute).padStart(2, '0')}:00.000Z`,
  data: null,
});

describe('first run', () => {
  it('seeds silently — a device that has shown you nothing has no backlog', () => {
    const r = selectToastable([item('a', 1), item('b', 2)], null, policyFor);
    expect(r.pops).toEqual([]);
    expect(r.summaryCount).toBe(0);
    expect(r.nextWatermark).toBe('2026-07-20T10:02:00.000Z');
  });

  it('seeds to null when there is nothing at all', () => {
    const r = selectToastable([], null, policyFor);
    expect(r.pops).toEqual([]);
    expect(r.nextWatermark).toBeNull();
  });
});

describe('watermark comparison', () => {
  it('pops only what is strictly newer', () => {
    const r = selectToastable(
      [item('a', 1), item('b', 2), item('c', 3)],
      '2026-07-20T10:02:00.000Z',
      policyFor,
    );
    expect(r.pops.map((p) => p.id)).toEqual(['c']);
  });

  it('pops nothing when everything has been seen', () => {
    const r = selectToastable(
      [item('a', 1), item('b', 2)],
      '2026-07-20T10:02:00.000Z',
      policyFor,
    );
    expect(r.pops).toEqual([]);
    expect(r.summaryCount).toBe(0);
  });

  it('advances the watermark past NEVER items too', () => {
    // Otherwise a quiet notification newer than everything would hold the
    // watermark back and the same loud ones would re-pop on every poll.
    const r = selectToastable(
      [item('a', 1), item('q', 5, 'quiet')],
      '2026-07-20T10:00:00.000Z',
      policyFor,
    );
    expect(r.pops.map((p) => p.id)).toEqual(['a']);
    expect(r.nextWatermark).toBe('2026-07-20T10:05:00.000Z');
  });

  it('never moves the watermark backwards', () => {
    const r = selectToastable(
      [item('a', 1)],
      '2026-07-20T10:09:00.000Z',
      policyFor,
    );
    expect(r.nextWatermark).toBe('2026-07-20T10:09:00.000Z');
  });
});

describe('policy filtering', () => {
  it('never pops a template whose own UI already announced it', () => {
    const r = selectToastable(
      [item('q1', 1, 'quiet'), item('q2', 2, 'quiet')],
      '2026-07-20T10:00:00.000Z',
      policyFor,
    );
    expect(r.pops).toEqual([]);
    expect(r.summaryCount).toBe(0);
  });

  it('counts only always-policy items toward the summary threshold', () => {
    const items = [
      ...Array.from({ length: 6 }, (_, i) => item(`q${i}`, i + 1, 'quiet')),
      item('a', 8),
    ];
    const r = selectToastable(items, '2026-07-20T10:00:00.000Z', policyFor);
    expect(r.pops.map((p) => p.id)).toEqual(['a']);
    expect(r.summaryCount).toBe(0);
  });
});

describe('summary threshold', () => {
  it('pops up to 3 individually, oldest first so they read in order', () => {
    const items = [item('c', 3), item('a', 1), item('b', 2)];
    const r = selectToastable(items, '2026-07-20T10:00:00.000Z', policyFor);
    expect(r.pops.map((p) => p.id)).toEqual(['a', 'b', 'c']);
    expect(r.summaryCount).toBe(0);
  });

  it(`collapses to a summary at ${SUMMARY_THRESHOLD} or more`, () => {
    const items = Array.from({ length: SUMMARY_THRESHOLD }, (_, i) =>
      item(`a${i}`, i + 1),
    );
    const r = selectToastable(items, '2026-07-20T10:00:00.000Z', policyFor);
    expect(r.pops).toEqual([]);
    expect(r.summaryCount).toBe(SUMMARY_THRESHOLD);
  });

  it('reports the real count in the summary', () => {
    const items = Array.from({ length: 9 }, (_, i) => item(`a${i}`, i + 1));
    const r = selectToastable(items, '2026-07-20T10:00:00.000Z', policyFor);
    expect(r.summaryCount).toBe(9);
  });
});

describe('malformed input', () => {
  it('ignores items with an unparsable created_at', () => {
    const bad: FeedItem = {
      id: 'bad',
      template: 'loud',
      createdAt: 'not-a-date',
      data: null,
    };
    const r = selectToastable(
      [bad, item('a', 5)],
      '2026-07-20T10:00:00.000Z',
      policyFor,
    );
    expect(r.pops.map((p) => p.id)).toEqual(['a']);
    expect(r.nextWatermark).toBe('2026-07-20T10:05:00.000Z');
  });

  it('handles an empty feed against an existing watermark', () => {
    const r = selectToastable([], '2026-07-20T10:00:00.000Z', policyFor);
    expect(r.pops).toEqual([]);
    expect(r.nextWatermark).toBe('2026-07-20T10:00:00.000Z');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm run test -- src/lib/notifications/__tests__/select-toastable.test.ts
```

Expected: FAIL — `Failed to resolve import "../select-toastable"`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/notifications/select-toastable.ts`:

```ts
import type { ToastPolicy } from '@/lib/notifications/copy';

export type FeedItem = {
  id: string;
  template: string;
  createdAt: string;
  data: Record<string, unknown> | null;
};

/** At or above this many fresh toastable items, collapse to one summary
 *  rather than stacking. Three individual toasts is a glance; four is a wall. */
export const SUMMARY_THRESHOLD = 4;

export type SelectResult = {
  /** Individual toasts to raise, oldest first. Empty when summarising. */
  pops: FeedItem[];
  /** >0 means raise a single "N new notifications" toast instead of `pops`. */
  summaryCount: number;
  /** Where the device watermark should move to. */
  nextWatermark: string | null;
};

function timeOf(iso: string): number {
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : NaN;
}

/**
 * Decides what the toast layer should announce.
 *
 * The whole spec's behavior lives here so it can be tested without rendering:
 * silent seed on a fresh device, strictly-newer comparison, policy filtering,
 * and the 1–3 / 4+ summary split.
 */
export function selectToastable(
  items: FeedItem[],
  watermark: string | null,
  policyFor: (template: string) => ToastPolicy,
): SelectResult {
  const dated = items.filter((i) => !Number.isNaN(timeOf(i.createdAt)));

  // The watermark advances past EVERY item, including 'never' ones. If it only
  // tracked what popped, a quiet notification newer than the rest would hold it
  // back and the same loud ones would re-announce on every poll.
  const newest = dated.reduce<string | null>(
    (max, i) => (max === null || timeOf(i.createdAt) > timeOf(max) ? i.createdAt : max),
    null,
  );

  const nextWatermark =
    watermark === null
      ? newest
      : newest !== null && timeOf(newest) > timeOf(watermark)
        ? newest
        : watermark;

  // First run on this device: seed and stay quiet. A device that has shown you
  // nothing has no backlog to report — the bell badge still carries the count.
  if (watermark === null) {
    return { pops: [], summaryCount: 0, nextWatermark };
  }

  const mark = timeOf(watermark);
  const fresh = dated
    .filter((i) => timeOf(i.createdAt) > mark)
    .filter((i) => policyFor(i.template) === 'always')
    .sort((a, b) => timeOf(a.createdAt) - timeOf(b.createdAt));

  if (fresh.length === 0) {
    return { pops: [], summaryCount: 0, nextWatermark };
  }
  if (fresh.length >= SUMMARY_THRESHOLD) {
    return { pops: [], summaryCount: fresh.length, nextWatermark };
  }
  return { pops: fresh, summaryCount: 0, nextWatermark };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npm run test -- src/lib/notifications/__tests__/select-toastable.test.ts
```

Expected: PASS — 5 suites, 13 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/notifications/select-toastable.ts \
        src/lib/notifications/__tests__/select-toastable.test.ts
git commit -m "$(cat <<'EOF'
feat(notifications): toastable selection rules

Silent seed, strictly-newer comparison, per-template policy filtering,
and the 1-3 individual / 4+ summary split — all in one pure function.

The watermark advances past 'never' items too. If it only tracked what
popped, a quiet notification newer than the rest would hold it back and
the same loud ones would re-announce on every poll.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Toast component

`SuccessToast` generalized: variants, an optional body line, an optional action link, hover/focus pause. Everything load-bearing about the original is preserved.

**Files:**
- Create: `src/components/ui/Toast.tsx`

**Interfaces:**
- Consumes: `ToastSpec` (Task 1); `useLiquidGlass`, `GLASS_ACCENT`.
- Produces: `function Toast({ spec, onDismiss }: { spec: ToastSpec; onDismiss: (key: string) => void })` and `const TOAST_MS = 5000`.

- [ ] **Step 1: Write the component**

Create `src/components/ui/Toast.tsx`:

```tsx
'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { CheckCircle2, Info, Sparkles, X } from 'lucide-react';
import { useLiquidGlass, GLASS_ACCENT } from '@/lib/use-liquid-glass';
import type { ToastSpec } from '@/lib/notifications/toast-queue';

// One source of truth for the dismiss timer AND the progress bar's
// animation-duration (the inline style below overrides the class fallback).
// 5s rather than SuccessToast's 4s: these carry a body line and sometimes an
// action, so there is more to read before it goes.
export const TOAST_MS = 5000;

const VARIANT_ICON = {
  success: CheckCircle2,
  info: Info,
  reward: Sparkles,
} as const;

const VARIANT_TINT = {
  success: 'text-buyback-fg',
  info: 'text-white/70',
  reward: 'text-chase',
} as const;

const VARIANT_BAR = {
  success: 'bg-buyback-fg',
  info: 'bg-white/40',
  reward: 'bg-chase',
} as const;

/**
 * One rendered toast. The queue, the cap and the suppression live in
 * toast-queue.ts; this only renders a spec and reports its own dismissal.
 *
 * Pausing on hover and on keyboard focus is not decoration — an auto-dismissing
 * element carrying an action link has to be pausable (WCAG 2.2.1), and it turns
 * "I missed it" from a permanent loss into a recoverable one.
 */
export function Toast({
  spec,
  onDismiss,
}: {
  spec: ToastSpec;
  onDismiss: (key: string) => void;
}) {
  const [paused, setPaused] = useState(false);

  // Latest-ref so an unstable onDismiss (an inline arrow in the parent) cannot
  // restart the dismiss timer on re-render — the CSS progress bar would not
  // restart with it, and the two would desync.
  const onDismissRef = useRef(onDismiss);
  useEffect(() => {
    onDismissRef.current = onDismiss;
  });

  useEffect(() => {
    if (paused) return;
    const t = setTimeout(() => onDismissRef.current(spec.key), TOAST_MS);
    return () => clearTimeout(t);
  }, [spec.key, paused]);

  const ref = useRef<HTMLDivElement>(null);
  useLiquidGlass(ref, true, GLASS_ACCENT);

  const Icon = VARIANT_ICON[spec.variant];

  const inner = (
    <>
      <Icon
        aria-hidden="true"
        className={`h-5 w-5 shrink-0 ${VARIANT_TINT[spec.variant]}`}
      />
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-semibold text-white">{spec.title}</p>
        {spec.body && (
          <p className="mt-0.5 text-[12px] leading-snug text-white/60">
            {spec.body}
          </p>
        )}
        {spec.action && (
          <span className="mt-1 inline-block text-[12px] font-semibold text-white/75">
            {spec.action} →
          </span>
        )}
      </div>
    </>
  );

  return (
    <div
      ref={ref}
      className="glass-panel pointer-events-auto relative flex w-full items-start gap-3 overflow-hidden rounded-2xl border px-4 py-3 motion-safe:animate-[toastIn_0.25s_ease-out]"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={() => setPaused(false)}
    >
      {spec.href ? (
        // Whole surface is the target: a text link inside a toast that is
        // dismissing in 5s is a genuinely hard tap on a phone. The action
        // label above supplies the affordance.
        <Link
          href={spec.href}
          onClick={() => onDismiss(spec.key)}
          className="flex min-w-0 flex-1 items-start gap-3"
        >
          {inner}
        </Link>
      ) : (
        <div className="flex min-w-0 flex-1 items-start gap-3">{inner}</div>
      )}

      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => onDismiss(spec.key)}
        className="shrink-0 rounded p-0.5 text-white/50 hover:text-white focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:outline-none"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>

      <span
        aria-hidden="true"
        className={`absolute inset-x-0 bottom-0 h-0.5 origin-left ${VARIANT_BAR[spec.variant]} motion-safe:animate-[toastBar_5s_linear_forwards]`}
        style={{
          animationDuration: `${TOAST_MS}ms`,
          animationPlayState: paused ? 'paused' : 'running',
        }}
      />
    </div>
  );
}
```

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit
```

Expected: no errors. If `text-chase` is not a known utility, confirm it against `src/app/globals.css` (`PrizeReveal` uses `text-chase`, so it exists).

- [ ] **Step 3: Commit**

```bash
git add src/components/ui/Toast.tsx
git commit -m "$(cat <<'EOF'
feat(notifications): generalized Toast component

Variants, optional body and action label, whole-surface tap target when
there is a destination, and pause on hover/focus.

The pause closes a WCAG 2.2.1 gap the old 4s toast already had, and which
gets much more visible now that toasts carry actions. 5s rather than 4s
because there is a body line to read.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: ToastProvider

Pure UI. Owns the queue, renders the stack, hosts the live region. Knows nothing about notifications.

**Files:**
- Create: `src/components/notifications/ToastProvider.tsx`

**Interfaces:**
- Consumes: `toastQueue`, `initialToastState`, `ToastSpec` (Task 1); `Toast` (Task 4).
- Produces:
  - `function ToastProvider({ children }: { children: ReactNode })`
  - `function useToast(): { show: (spec: ToastSpec) => void; showMany: (specs: ToastSpec[]) => void }`
  - `function useSuppressToasts(active: boolean): void`

Matches the provider conventions both existing providers share: `'use client'` first line, non-exported `XContextValue` type with JSDoc per member, `createContext<T | null>(null)`, a `useX` hook that throws outside the provider, the value object passed inline, and global UI rendered as a sibling after `{children}` (exactly `TopUpProvider`'s precedent with `<TopUpSheet />`).

- [ ] **Step 1: Write the provider**

Create `src/components/notifications/ToastProvider.tsx`:

```tsx
'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useReducer,
  useRef,
  type ReactNode,
} from 'react';
import { Toast } from '@/components/ui/Toast';
import {
  toastQueue,
  initialToastState,
  type ToastSpec,
} from '@/lib/notifications/toast-queue';

type ToastContextValue = {
  /** Raise one toast. Ignored if its key was already shown. */
  show: (spec: ToastSpec) => void;
  /** Raise several at once — one state update, so the cap applies correctly. */
  showMany: (specs: ToastSpec[]) => void;
  /** Ref-counted suppression; use the useSuppressToasts hook instead. */
  pushSuppress: () => void;
  popSuppress: () => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): Pick<ToastContextValue, 'show' | 'showMany'> {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return { show: ctx.show, showMany: ctx.showMany };
}

/**
 * Suppress toasts while an immersive surface is on screen. Toasts raised
 * during suppression QUEUE and drain when it lifts — they are never dropped.
 *
 * Ref-counted: AvatarCropper (z-130) can be mounted at the same time as its
 * parent modal, so two surfaces may suppress concurrently.
 */
export function useSuppressToasts(active: boolean): void {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useSuppressToasts must be used within ToastProvider');
  const { pushSuppress, popSuppress } = ctx;
  useEffect(() => {
    if (!active) return;
    pushSuppress();
    return () => popSuppress();
  }, [active, pushSuppress, popSuppress]);
}

/**
 * Holds the toast queue and renders the stack. Deliberately knows nothing
 * about notifications: NotificationsProvider sits inside it and feeds it, and
 * client flows call useToast().show() for their own confirmations. That split
 * is what lets the queue logic be tested as a plain reducer.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(toastQueue, initialToastState);

  const show = useCallback((spec: ToastSpec) => {
    dispatch({ type: 'enqueue', toasts: [spec] });
  }, []);

  const showMany = useCallback((specs: ToastSpec[]) => {
    dispatch({ type: 'enqueue', toasts: specs });
  }, []);

  // Ref count lives in a module-free closure over the reducer: 'suppress' is
  // idempotent and 'release' only fires when the last surface unmounts.
  const depth = useSuppressDepth(dispatch);

  const dismiss = useCallback((key: string) => {
    dispatch({ type: 'dismiss', key });
  }, []);

  return (
    <ToastContext.Provider
      value={{
        show,
        showMany,
        pushSuppress: depth.push,
        popSuppress: depth.pop,
      }}
    >
      {children}

      {/*
        Always mounted, even when empty. A role="status" region inserted
        together with its content is skipped by some screen-reader/browser
        combinations, so the region has to pre-exist the message. This is the
        same invariant SuccessToast documented and it must not regress.

        pointer-events-none on the stack so the empty region never eats clicks;
        each Toast re-enables them on itself.
      */}
      <div
        role="status"
        aria-live="polite"
        className={
          state.visible.length > 0
            ? 'pointer-events-none fixed inset-x-4 top-[4.25rem] z-[140] mx-auto flex max-w-md flex-col gap-2'
            : 'sr-only'
        }
      >
        {state.visible.map((spec) => (
          <Toast key={spec.key} spec={spec} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/** Ref-counted suppress/release around the reducer's boolean. */
function useSuppressDepth(dispatch: (a: { type: 'suppress' | 'release' }) => void) {
  const ref = useRef(0);
  const push = useCallback(() => {
    ref.current += 1;
    if (ref.current === 1) dispatch({ type: 'suppress' });
  }, [dispatch]);
  const pop = useCallback(() => {
    ref.current = Math.max(0, ref.current - 1);
    if (ref.current === 0) dispatch({ type: 'release' });
  }, [dispatch]);
  return { push, pop };
}
```

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit
```

Expected: no errors. `useSuppressDepth` is declared after `ToastProvider` — function declarations hoist, so this is fine, but if the linter objects to use-before-define, move it above `ToastProvider`.

- [ ] **Step 3: Commit**

```bash
git add src/components/notifications/ToastProvider.tsx
git commit -m "$(cat <<'EOF'
feat(notifications): ToastProvider

Owns the queue and renders the stack at z-[140] — above every overlay in
the app, which matters because today's z-[70] toast renders BELOW the
slot machine, so a level-up toast would be invisible at exactly the
moment it fires.

Suppression is ref-counted: the avatar cropper can be mounted at the same
time as its parent modal.

The live region stays mounted when empty. A role="status" inserted with
its content is skipped by some screen readers — SuccessToast documented
this and it must not regress.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: NotificationsProvider

Headless. Polls, applies the watermark, raises toasts, exposes the unread count and `bump()`.

**Files:**
- Create: `src/components/notifications/NotificationsProvider.tsx`

**Interfaces:**
- Consumes: `useAuth`; `getNotifications` (existing server action); `selectToastable`, `SUMMARY_THRESHOLD` (Task 3); `readWatermark`, `writeWatermark` (Task 2); `copyFor` (PR 1); `useToast` (Task 5).
- Produces:
  - `function NotificationsProvider({ children }: { children: ReactNode })`
  - `function useNotifications(): { unreadCount: number; refresh: () => Promise<void>; bump: () => void }`

- [ ] **Step 1: Write the provider**

Create `src/components/notifications/NotificationsProvider.tsx`:

```tsx
'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { usePathname } from 'next/navigation';
import { useAuth } from '@/components/auth/AuthProvider';
import { getNotifications } from '@/lib/actions/notifications';
import { copyFor } from '@/lib/notifications/copy';
import { selectToastable } from '@/lib/notifications/select-toastable';
import { readWatermark, writeWatermark } from '@/lib/notifications/watermark';
import { useToast } from './ToastProvider';

/** How often to re-read the feed while the tab is visible. Its only job is the
 *  sit-idle case: you are on the app doing nothing and an admin ships your
 *  order or the cron matures a commission. 30s vs 60s is indistinguishable for
 *  those, so take the cheaper one. */
const POLL_MS = 60_000;

/** VIP settles in a worker subscriber, so the row usually does not exist when
 *  the pull response returns. Two bounded retries cover a slow worker without
 *  polling in a loop. */
const BUMP_DELAYS_MS = [2_000, 6_000];

type NotificationsContextValue = {
  /** Unread count from the server (page-scoped over the newest 50). */
  unreadCount: number;
  /** Re-read the feed now. */
  refresh: () => Promise<void>;
  /** Chase a notification an action just caused (currently: after a pull). */
  bump: () => void;
};

const NotificationsContext = createContext<NotificationsContextValue | null>(
  null,
);

export function useNotifications(): NotificationsContextValue {
  const ctx = useContext(NotificationsContext);
  if (!ctx) {
    throw new Error('useNotifications must be used within NotificationsProvider');
  }
  return ctx;
}

/**
 * Headless owner of the notification feed: polling, the per-device watermark,
 * the unread count, and the toast policy. Renders nothing — it calls
 * useToast() to raise anything the selection rules pick out.
 *
 * Fully inert when logged out: no polling for visitors.
 */
export function NotificationsProvider({ children }: { children: ReactNode }) {
  const { customer } = useAuth();
  const { showMany } = useToast();
  const [unreadCount, setUnreadCount] = useState(0);

  const customerId = customer?.id ?? null;
  // Latest-ref so refresh stays stable across renders — it is a dependency of
  // the poll effect and of bump's timers.
  const showManyRef = useRef(showMany);
  useEffect(() => {
    showManyRef.current = showMany;
  });

  const refresh = useCallback(async (): Promise<void> => {
    if (!customerId) return;
    const res = await getNotifications();
    if (!res.ok) return;

    setUnreadCount(res.unreadCount);

    const watermark = readWatermark(customerId);
    const { pops, summaryCount, nextWatermark } = selectToastable(
      res.notifications.map((n) => ({
        id: n.id,
        template: n.template,
        createdAt: n.createdAt,
        data: n.data,
      })),
      watermark,
      (template) => copyFor(template).policy,
    );

    if (summaryCount > 0) {
      showManyRef.current([
        {
          // Keyed on the watermark it clears, so re-running the same poll
          // cannot raise a second identical summary.
          key: `summary:${nextWatermark ?? 'none'}`,
          title: `${summaryCount} new notifications`,
          body: null,
          variant: 'info',
          href: '/notifications',
          action: 'View all',
        },
      ]);
    } else if (pops.length > 0) {
      showManyRef.current(
        pops.map((n) => {
          const copy = copyFor(n.template);
          return {
            key: n.id,
            title: copy.title,
            body: copy.body(n.data),
            variant: copy.variant,
            href: copy.href,
            action: copy.action,
          };
        }),
      );
    }

    if (nextWatermark) writeWatermark(customerId, nextWatermark);
  }, [customerId]);

  // Poll while visible; on focus; on becoming visible. Paused entirely while
  // the tab is hidden — a background tab has nobody to show a toast to.
  useEffect(() => {
    if (!customerId) {
      setUnreadCount(0);
      return;
    }

    let timer: number | null = null;
    const tick = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    const start = () => {
      if (timer === null) timer = window.setInterval(tick, POLL_MS);
    };
    const stop = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        void refresh();
        start();
      } else {
        stop();
      }
    };

    void refresh();
    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', tick);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', tick);
    };
  }, [customerId, refresh]);

  // Client-side navigation fires no focus or visibility event, so a route
  // change would otherwise wait out the full interval. The bell used to do
  // exactly this before it stopped polling. Skips the first run — the effect
  // above already fetched on mount.
  const pathname = usePathname();
  const firstPath = useRef(true);
  useEffect(() => {
    if (firstPath.current) {
      firstPath.current = false;
      return;
    }
    if (customerId) void refresh();
  }, [pathname, customerId, refresh]);

  // Timers are tracked so an unmount (logout, navigation away) cannot fire a
  // refresh against a torn-down provider.
  const bumpTimers = useRef<number[]>([]);
  useEffect(
    () => () => {
      bumpTimers.current.forEach((id) => clearTimeout(id));
      bumpTimers.current = [];
    },
    [],
  );

  const bump = useCallback(() => {
    bumpTimers.current.forEach((id) => clearTimeout(id));
    bumpTimers.current = BUMP_DELAYS_MS.map((ms) =>
      window.setTimeout(() => void refresh(), ms),
    );
  }, [refresh]);

  return (
    <NotificationsContext.Provider value={{ unreadCount, refresh, bump }}>
      {children}
    </NotificationsContext.Provider>
  );
}
```

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/notifications/NotificationsProvider.tsx
git commit -m "$(cat <<'EOF'
feat(notifications): NotificationsProvider

60s poll while visible, refetch on focus and on becoming visible, paused
entirely while hidden. Applies the watermark and the per-template policy,
raises toasts, and exposes the unread count.

bump() chases the one always-toasting template that follows a user action:
VIP settles in a worker subscriber, so the row usually does not exist yet
when the pull response returns. Two bounded retries, cleared on unmount.

Inert when logged out — no polling for visitors.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Mount the providers and simplify the bell

**Files:**
- Modify: `src/app/layout.tsx`
- Modify: `src/components/NotificationBell.tsx`

**Interfaces:**
- Consumes: `ToastProvider` (Task 5), `NotificationsProvider` (Task 6), `useNotifications`.
- Produces: nothing new.

- [ ] **Step 1: Wire the layout**

Edit `src/app/layout.tsx`. Add the imports next to the existing provider imports:

```tsx
import { ToastProvider } from '@/components/notifications/ToastProvider';
import { NotificationsProvider } from '@/components/notifications/NotificationsProvider';
```

Replace the provider nesting (currently `<AuthProvider><TopUpProvider>…`):

```tsx
          <AuthProvider>
            <ToastProvider>
              <NotificationsProvider>
                <TopUpProvider>
                  <SkipLink />
                  <AppHeader />
                  <main id="main" className="flex-1 pb-12 lg:pb-8">
                    {children}
                  </main>
                  {/* Footer carries the TabBar clearance (pb-28) on phones. */}
                  <SiteFooter />
                  <TabBar />
                  <CookieConsent />
                </TopUpProvider>
              </NotificationsProvider>
            </ToastProvider>
          </AuthProvider>
```

Order is load-bearing: `NotificationsProvider` calls `useToast()`, so it must be inside `ToastProvider`; both need `useAuth()`, so both go inside `AuthProvider`.

- [ ] **Step 2: Simplify the bell**

Replace `src/components/NotificationBell.tsx` entirely:

```tsx
'use client';

import Link from 'next/link';
import { Bell } from 'lucide-react';
import { useNotifications } from '@/components/notifications/NotificationsProvider';

export default function NotificationBell() {
  // The count comes from NotificationsProvider, which already polls for the
  // toast layer. The bell used to run its own fetch on mount / pathname change
  // / focus — that was a second poll of the same endpoint for the same number.
  const { unreadCount } = useNotifications();

  return (
    <Link
      href="/notifications"
      aria-label={`Notifications${unreadCount ? `, ${unreadCount} unread` : ''}`}
      className="relative flex h-11 w-11 items-center justify-center rounded-full text-white/70 hover:bg-white/10 hover:text-white"
    >
      <Bell className="h-5 w-5" aria-hidden />
      {unreadCount > 0 && (
        <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-neutral-50 px-1 text-[10px] font-bold text-neutral-950">
          {unreadCount > 9 ? '9+' : unreadCount}
        </span>
      )}
    </Link>
  );
}
```

- [ ] **Step 3: Type-check and run the suite**

```bash
npx tsc --noEmit && npm run test
```

Expected: no type errors, all tests pass.

- [ ] **Step 4: Verify in the browser**

```bash
npm run dev
```

Log in and confirm: the bell badge still shows the unread count; the Network tab shows **one** `/store/notifications` request per minute, not two; nothing polls at all when logged out.

- [ ] **Step 5: Commit**

```bash
git add src/app/layout.tsx src/components/NotificationBell.tsx
git commit -m "$(cat <<'EOF'
feat(notifications): mount the providers, drop the bell's own poll

AuthProvider > ToastProvider > NotificationsProvider > TopUpProvider.
Order matters: NotificationsProvider calls useToast, both need useAuth.

The bell now reads its count from context. It used to fetch the whole
feed itself on mount, pathname change and focus — a second poll of the
same endpoint for the same number.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Immersive-surface suppression and the post-pull bump

**Files:**
- Modify: `src/app/slots/[slug]/SlotMachineClient.tsx`
- Modify: `src/components/rewards/PrizeReveal.tsx`
- Modify: `src/components/account/AvatarCropper.tsx`

**Interfaces:**
- Consumes: `useSuppressToasts` (Task 5), `useNotifications` (Task 6).
- Produces: nothing new.

All three surfaces are mounted *only* while active, so `useSuppressToasts(true)` unconditional is exactly right in each — the same reasoning `PrizeReveal` already documents for `useModalA11y(dialogRef, true, onClose)`.

- [ ] **Step 1: Suppress in the slot machine and bump after a pull**

Edit `src/app/slots/[slug]/SlotMachineClient.tsx`.

Add the imports:

```tsx
import { useSuppressToasts } from '@/components/notifications/ToastProvider';
import { useNotifications } from '@/components/notifications/NotificationsProvider';
```

Next to the existing `useChromeInert(true);` call (line ~113), add:

```tsx
  // Immersive surface: chrome inert + body scroll locked the whole time mounted.
  useChromeInert(true);
  // Same reasoning for toasts. The whole room is a fixed z-[100] takeover, so
  // anything raised while it is up would paint over the reveal — including the
  // vip_level_up toast this very screen causes. Toasts QUEUE and drain the
  // moment the player leaves, which reads as "the game told me as I finished".
  useSuppressToasts(true);
  const { bump: bumpNotifications } = useNotifications();
```

In `handleSettled`, immediately after `setPhase('flood');` (line ~522), add:

```tsx
    // The open committed. VIP settles in a worker subscriber, so the
    // vip_level_up row usually is not there yet — bump chases it. Suppression
    // above means the toast waits for the player to leave the room.
    bumpNotifications();
```

Add `bumpNotifications` to `handleSettled`'s dependency array (line ~549):

```tsx
  }, [pack.name, pack.image, sfx, play, applyBalance, reduced, isDemo, bumpNotifications]);
```

- [ ] **Step 2: Suppress in PrizeReveal**

Edit `src/components/rewards/PrizeReveal.tsx`. Add the import:

```tsx
import { useSuppressToasts } from '@/components/notifications/ToastProvider';
```

Next to the existing `useModalA11y(dialogRef, true, onClose);`:

```tsx
  useModalA11y(dialogRef, true, onClose);
  // Only mounted while a prize is on screen, so `true` is exact — same
  // reasoning as the hook above. A toast over the reveal would compete with
  // the announcement the reveal IS.
  useSuppressToasts(true);
```

- [ ] **Step 3: Suppress in AvatarCropper**

Edit `src/components/account/AvatarCropper.tsx`. Add the import:

```tsx
import { useSuppressToasts } from '@/components/notifications/ToastProvider';
```

Next to the existing `useModalA11y(panelRef, true, () => { … });` (line ~55), before the object-URL effect:

```tsx
  // Mounted only while a file is being cropped. Ref-counted in the provider,
  // because the parent EditProfileModal can be open at the same time.
  useSuppressToasts(true);
```

- [ ] **Step 4: Type-check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Verify in the browser**

```bash
npm run dev
```

Open `/slots/bronze-pack` (the only spinnable pack) logged in with credit, and spin. Expected: no toast appears over the reveal; if the spin crosses a VIP level, the level-up toast appears **after** leaving the slot room. Confirm the two bump requests in the Network tab at roughly +2s and +6s from the settle.

- [ ] **Step 6: Commit**

```bash
git add src/app/slots/ src/components/rewards/PrizeReveal.tsx \
        src/components/account/AvatarCropper.tsx
git commit -m "$(cat <<'EOF'
feat(notifications): suppress toasts on immersive surfaces + post-pull bump

The slot room, the prize reveal and the avatar cropper queue toasts while
they own the screen and drain on exit. Without this, the vip_level_up
toast would slide across the reveal animation that the same pull started.

bump() fires after the open commits, chasing the worker-settled VIP row.
Suppression means it waits for the player to leave the room.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Client-flow adoption

Read the **Scope correction** section above before starting. `TopUpSheet` and `VaultClient`'s buyback `notice` are deliberately **not** touched.

**Files:**
- Modify: `src/app/(account)/vault/VaultClient.tsx`
- Modify: `src/components/account/RequestDeliveryModal.tsx`
- Modify: `src/app/(account)/vip/VipVouchers.tsx`
- Modify: `src/components/rewards/WithdrawForm.tsx`
- Delete: `src/components/ui/SuccessToast.tsx`

**Interfaces:**
- Consumes: `useToast` (Task 5).
- Produces: nothing new.

- [ ] **Step 1: Migrate VaultClient to the provider**

Edit `src/app/(account)/vault/VaultClient.tsx`:

1. Remove the import `import { SuccessToast } from '@/components/ui/SuccessToast';` (line ~17) and add:
   ```tsx
   import { useToast } from '@/components/notifications/ToastProvider';
   ```
2. Delete the toast state declaration (line ~56):
   ```tsx
   // Transient top-of-screen confirmation for shipping orders (auto-dismisses).
   const [toast, setToast] = useState<string | null>(null);
   ```
   and add, next to the existing `useTopUp()` call:
   ```tsx
   const { show: showToast } = useToast();
   ```
3. In the `RequestDeliveryModal` `onSubmitted` handler, replace `setToast('Shipping order created successfully!');` with:
   ```tsx
             showToast({
               key: `delivery-requested:${pullIds.join(',')}`,
               title: 'Shipping order created successfully!',
               variant: 'success',
               href: '/orders',
               action: 'View orders',
             });
   ```
4. Delete the render site and its comment (lines ~606–608):
   ```tsx
   {/* Always mounted: the live region must pre-exist its message so screen
       readers announce it (see SuccessToast). */}
   <SuccessToast message={toast} onClose={() => setToast(null)} />
   ```
   The provider now owns the always-mounted live region.

**Leave `notice`, `error`, and the `!quotesFirm` banner exactly as they are.**

- [ ] **Step 2: Confirm the address save**

Edit `src/components/account/RequestDeliveryModal.tsx`. Add:

```tsx
import { useToast } from '@/components/notifications/ToastProvider';
```

In the component body:

```tsx
  const { show: showToast } = useToast();
```

In `saveAddress`, inside the `if (res.ok)` branch after the list is updated and `adding` is cleared:

```tsx
      // The only feedback until now was a new radio row appearing.
      showToast({
        key: `address-saved:${Date.now()}`,
        title: 'Address saved.',
        variant: 'success',
      });
```

**Leave `error` untouched** — it carries a client-side guard message (`'Choose a shipping address.'`) that fires with no network call, and the dialog is `aria-modal`, so the inline `role="alert"` is the right home for it.

- [ ] **Step 3: Confirm the voucher claim**

Edit `src/app/(account)/vip/VipVouchers.tsx`. Add:

```tsx
import { useToast } from '@/components/notifications/ToastProvider';
```

In the component body:

```tsx
  const { show: showToast } = useToast();
```

In `handleClaim`, in the success branch where the grant moves from `claimable` to `claimed`:

```tsx
      // Until now the row silently vanished into a collapsed <details>, so on
      // a single-voucher page there was no feedback at all.
      showToast({
        key: `voucher-claimed:${grant.id}`,
        title: `${voucherLabel(grant)} claimed.`,
        body: 'Find it under Claimed.',
        variant: 'success',
        href: '/vip',
        action: 'View VIP',
      });
```

`voucherLabel` is already imported in this file. **Leave `errors` and `notice` untouched.**

- [ ] **Step 4: Confirm the withdrawal and fix the leaked timer**

Edit `src/components/rewards/WithdrawForm.tsx`. Add:

```tsx
import { useToast } from '@/components/notifications/ToastProvider';
```

In the component body:

```tsx
  const { show: showToast } = useToast();
```

In the success branch (`res.ok && res.status === 'requested'`), replace the `setDone(true)` + `setTimeout(onDone, 1500)` pair with:

```tsx
      // The inline done panel used to be revealed for 1500ms by a setTimeout
      // that was never cleared — it fired even after unmount. The toast
      // outlives this component (the provider is above it in the tree), so
      // hand off immediately instead.
      showToast({
        key: `withdraw-requested:${pullId}`,
        title: 'Shipping requested!',
        body: 'Check your Orders for status.',
        variant: 'success',
        href: '/orders',
        action: 'View orders',
      });
      onDone();
```

Then delete the now-unused `done` state and the inline green panel it rendered.

**Leave `error` and `needsAuth` untouched** — that block conditionally renders a `Log in` button inside its `role="alert"`, which a string-only toast cannot carry.

- [ ] **Step 5: Delete the superseded component**

```bash
git rm src/components/ui/SuccessToast.tsx
```

- [ ] **Step 6: Confirm nothing still references it**

```bash
grep -rn "SuccessToast" src/ || echo "clean"
```

Expected: `clean`.

- [ ] **Step 7: Type-check and run the suite**

```bash
npx tsc --noEmit && npm run test
```

Expected: no type errors, all tests pass.

- [ ] **Step 8: Verify in the browser**

```bash
npm run dev
```

Walk each flow and confirm a toast appears with the right copy and that every inline error still renders inline:

1. `/vault` → select a card → request delivery → toast + "View orders".
2. Inside that modal → add a new address → "Address saved."
3. `/vip` → claim a voucher → toast naming the voucher.
4. `/daily` → withdraw a prize → toast, and the form hands off immediately.
5. `/vault` → sell a card → the **inline** green notice still appears and does **not** time out.
6. Top up → the in-panel success screen still appears, unchanged.

- [ ] **Step 9: Commit**

```bash
git add -A src/
git commit -m "$(cat <<'EOF'
feat(notifications): route client confirmations through the toast provider

Adds confirmations where there were none: saving a delivery address,
claiming a voucher (the row used to vanish silently into a collapsed
<details>), and requesting a withdrawal. Migrates the vault's delivery
toast onto the provider and deletes SuccessToast, its only consumer.

Deliberately NOT converted, against the original scope: TopUpSheet's
in-panel success screen and the vault's persistent buyback notice. Both
already confirm, and both are money messages — the same reasoning that
keeps errors inline keeps these from becoming 5s toasts.

Also drops WithdrawForm's uncleared 1500ms setTimeout, which fired after
unmount; the toast outlives the component, so it hands off immediately.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Done criteria for PR 2

- [ ] `npm run test` green — `toast-queue`, `select-toastable`, `watermark`, plus PR 1's `copy` suite.
- [ ] `npx tsc --noEmit` clean.
- [ ] Exactly one `/store/notifications` request per minute while logged in and visible; **zero** while the tab is hidden or logged out.
- [ ] A fresh browser profile pops **nothing** on first load (silent seed), and the bell badge still shows the true count.
- [ ] A level-up from a pull toasts **after** leaving the slot room, not over the reveal.
- [ ] Every inline `role="alert"` error still renders inline in all four touched flows.
- [ ] `grep -rn "SuccessToast" src/` returns nothing.

Open the PR against `master`. Branch: `claude/notification-popup-coverage-79825a`.
