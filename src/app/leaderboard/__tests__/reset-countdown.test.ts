// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// The pure formatting/rollover math is covered by lib/__tests__/reset-countdown.
// This pins the one behaviour that only exists in the component: a tab left
// open across the reset refetches the page, retrying every 20s (bounded by
// MAX_REFRESHES) while the server keeps returning the same deadline, so the
// fresh countdown never sits indefinitely over last week's pool and standings.

const refresh = vi.fn();
// ONE object for every render, like the real App Router — a fresh object each
// call would re-run the component's effect and re-arm the rollover every render.
const router = { refresh };
vi.mock('next/navigation', () => ({ useRouter: () => router }));

const { ResetCountdown } = await import('../ResetCountdown');

const RESET_AT = Date.parse('2026-08-24T00:00:00Z');
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

let container: HTMLDivElement;
let root: Root;

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  refresh.mockClear();
  vi.useFakeTimers();
  vi.setSystemTime(RESET_AT - 3000);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

async function mount(resetAt = RESET_AT) {
  await act(async () => {
    root.render(
      createElement(ResetCountdown, {
        resetAt,
        label: 'Resets Mondays 00:00 (MYT)',
      }),
    );
  });
}

/** Advances the wall clock AND the tick interval together — the component reads
 *  Date.now() on every tick rather than decrementing, so both must move. */
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('ResetCountdown', () => {
  test('ticks down without refreshing while the week is still running', async () => {
    await mount();
    expect(container.textContent).toContain('00h 00m 03s');
    await advance(2000);
    expect(container.textContent).toContain('00h 00m 01s');
    expect(refresh).not.toHaveBeenCalled();
  });

  test('refreshes at the deadline, then retries every 20s while the server returns the same deadline', async () => {
    await mount();
    await advance(4000);
    expect(refresh).toHaveBeenCalledTimes(1);
    // Rolled forward: a hair under a full week, not a stuck zero.
    expect(container.textContent).toContain('6d 23h 59m 59s');
    // A minute later: retries at +20s/+40s/+60s (1 initial + 3 retries) — the
    // rollover must not re-fire on EVERY tick, only on the 20s cadence.
    await advance(60_000);
    expect(refresh).toHaveBeenCalledTimes(4);
  });

  test('stops retrying once MAX_REFRESHES is spent against a server that never rolls', async () => {
    await mount();
    // A wedged backend / disabled challenge: resetAt never changes. Advancing
    // ten minutes covers many 20s retry windows — the ladder must still cap
    // at MAX_REFRESHES (5) rather than polling forever.
    await advance(10 * 60_000);
    expect(refresh).toHaveBeenCalledTimes(5);
  });

  test('refreshes on mount when hydration starts after the deadline', async () => {
    // A tab that hydrates late (slow device, restored session) would otherwise
    // sit on last week's pool and standings for the whole next week.
    vi.setSystemTime(RESET_AT + 5000);
    await mount();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('6d 23h 59m 55s');
    await advance(3000);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  test('treats a clock that steps backwards as skew, not a rollover', async () => {
    await mount();
    // An NTP correction / waking from sleep: remaining time GROWS without the
    // deadline having passed. That must not refetch.
    vi.setSystemTime(RESET_AT - 60_000);
    await advance(2000);
    expect(refresh).not.toHaveBeenCalled();
    expect(container.textContent).toContain('00h 00m 58s');
  });

  test('a new resetAt stops the retry ladder', async () => {
    await mount();
    await advance(4000);
    expect(refresh).toHaveBeenCalledTimes(1);
    // What the server sends back after the refresh: next week's deadline. The
    // remaining time jumps a full week, which must NOT read as a rollover —
    // and, since resetAt changed, the ladder for the old deadline is gone.
    await mount(RESET_AT + WEEK_MS);
    await advance(2000);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  test('a new resetAt stops the retry ladder mid-flight, after a retry has already fired', async () => {
    await mount();
    await advance(4000); // past the deadline: 1st refresh
    expect(refresh).toHaveBeenCalledTimes(1);
    await advance(20_000); // 20s retry cadence: 2nd refresh
    expect(refresh).toHaveBeenCalledTimes(2);
    // The server finally rolls mid-ladder (2 of 5 refreshes spent). The new
    // deadline is a week out, so no further refresh — for either the old
    // budget or the new one.
    await mount(RESET_AT + WEEK_MS);
    await advance(60_000);
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
