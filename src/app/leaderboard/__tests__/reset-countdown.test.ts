// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// The pure formatting/rollover math is covered by lib/__tests__/reset-countdown.
// This pins the one behaviour that only exists in the component: a tab left
// open across the reset refetches the page ONCE, so the fresh countdown never
// sits over last week's pool and standings.

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

  test('refreshes once when the deadline passes, then counts the new week', async () => {
    await mount();
    await advance(4000);
    expect(refresh).toHaveBeenCalledTimes(1);
    // Rolled forward: a hair under a full week, not a stuck zero.
    expect(container.textContent).toContain('6d 23h 59m 59s');
    // Still one refresh a minute later — the rollover must not re-fire on
    // every subsequent tick while the server response is in flight.
    await advance(60_000);
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

  test('does not refresh again when the refreshed resetAt arrives', async () => {
    await mount();
    await advance(4000);
    expect(refresh).toHaveBeenCalledTimes(1);
    // What the server sends back after the refresh: next week's deadline. The
    // remaining time jumps a full week, which must NOT read as a rollover.
    await mount(RESET_AT + WEEK_MS);
    await advance(2000);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
