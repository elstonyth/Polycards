// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// The dot the customer actually sees is this provider's output, so these pin
// the two behaviours that broke in production: a spin could not light the dot
// because nothing could ask for a re-read, and the focus path re-read too
// eagerly. Everything else (the comparison, the storage key) is covered by
// lib/__tests__/unread-dot.test.ts.

const customer = { id: 'cus_1' };
vi.mock('@/components/auth/AuthProvider', () => ({
  useAuth: () => ({ customer, isLoading: false }),
}));

const { createUnreadDot } = await import('../create-unread-dot');

let container: HTMLDivElement;
let root: Root;

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  window.localStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** Mounts the provider and hands the live context out through a ref object. */
async function mount(fetchLatest: () => Promise<string | null>) {
  const { Provider, useDot } = createUnreadDot('vault', fetchLatest);
  const seen: { current: ReturnType<typeof useDot> | null } = { current: null };

  function Probe() {
    const dot = useDot();
    // Captured in an effect, not during render: react-hooks/immutability
    // rejects writing an outer binding while rendering. act() flushes effects,
    // so `seen.current` is current by the time each assertion runs.
    useEffect(() => {
      seen.current = dot;
    });
    return createElement('span', null, dot.show ? 'lit' : 'dark');
  }

  await act(async () => {
    root.render(createElement(Provider, null, createElement(Probe)));
  });
  return seen;
}

describe('createUnreadDot', () => {
  test('reads once on mount and lights when there is an unseen event', async () => {
    const fetchLatest = vi.fn().mockResolvedValue('2026-08-04T00:00:00.000Z');

    const dot = await mount(fetchLatest);

    expect(fetchLatest).toHaveBeenCalledTimes(1);
    expect(dot.current?.show).toBe(true);
    expect(container.textContent).toBe('lit');
  });

  test('the MOUNT path honours a stamp already in storage', async () => {
    // The file's own stated risk is its two fetch copies drifting; every other
    // case here exercises the refresh() copy. This one pins the mount copy —
    // and re-asserts the storage-key back-compat in the same breath, since a
    // key change would show up here as a spuriously lit dot.
    window.localStorage.setItem(
      'polycards.vault_seen_at:cus_1',
      '2026-08-04T00:00:00.000Z',
    );
    const fetchLatest = vi.fn().mockResolvedValue('2026-08-04T00:00:00.000Z');

    const dot = await mount(fetchLatest);

    expect(dot.current?.show).toBe(false);
    expect(container.textContent).toBe('dark');
  });

  test('a burst coalesces into at most two reads, the last one final', async () => {
    // Selling back N cards fires N applyBalance calls. Skipping outright could
    // miss the final write, so a request arriving mid-flight must trigger
    // exactly one trailing read once the in-flight one lands.
    let release: (v: string | null) => void = () => {};
    const first = new Promise<string | null>((r) => {
      release = r;
    });
    const fetchLatest = vi
      .fn()
      .mockResolvedValueOnce(null) // mount
      .mockReturnValueOnce(first) // the burst's first read, held open
      .mockResolvedValue('2026-08-04T00:00:00.000Z'); // the trailing read

    const dot = await mount(fetchLatest);
    expect(fetchLatest).toHaveBeenCalledTimes(1);

    await act(async () => {
      dot.current?.refresh(); // starts the held read
      dot.current?.refresh(); // coalesced
      dot.current?.refresh(); // coalesced
      dot.current?.refresh(); // coalesced
    });
    // Still just the one in flight — the three others did not each fetch.
    expect(fetchLatest).toHaveBeenCalledTimes(2);

    await act(async () => {
      release(null);
      await first;
    });

    // Exactly one trailing read, and its answer is what sticks.
    expect(fetchLatest).toHaveBeenCalledTimes(3);
    expect(dot.current?.show).toBe(true);
  });

  test('refresh() re-reads immediately — the spin fix', async () => {
    // The bug: opening a pack put a card in the vault, but the provider only
    // re-read on login and on window focus, so the dot could not light in that
    // session at all. refresh() is what SlotMachineClient calls once the open
    // resolves, and it must NOT be subject to the focus throttle.
    const fetchLatest = vi.fn().mockResolvedValue(null);
    const dot = await mount(fetchLatest);
    expect(fetchLatest).toHaveBeenCalledTimes(1);
    expect(dot.current?.show).toBe(false);

    fetchLatest.mockResolvedValue('2026-08-04T00:00:00.000Z');
    await act(async () => {
      dot.current?.refresh();
    });

    expect(fetchLatest).toHaveBeenCalledTimes(2);
    expect(dot.current?.show).toBe(true);
    expect(container.textContent).toBe('lit');
  });

  test('markSeen stamps the fetched value and darkens the dot', async () => {
    const fetchLatest = vi.fn().mockResolvedValue('2026-08-04T00:00:00.000Z');
    const dot = await mount(fetchLatest);
    expect(dot.current?.show).toBe(true);

    await act(async () => {
      dot.current?.markSeen();
    });

    expect(dot.current?.show).toBe(false);
    // The FETCHED stamp, never Date.now() — otherwise an event landing between
    // the read and the click would be swallowed.
    expect(window.localStorage.getItem('polycards.vault_seen_at:cus_1')).toBe(
      '2026-08-04T00:00:00.000Z',
    );
  });

  test('a refresh after markSeen does not resurrect the cleared dot', async () => {
    const fetchLatest = vi.fn().mockResolvedValue('2026-08-04T00:00:00.000Z');
    const dot = await mount(fetchLatest);
    await act(async () => {
      dot.current?.markSeen();
    });
    expect(dot.current?.show).toBe(false);

    await act(async () => {
      dot.current?.refresh();
    });

    expect(dot.current?.show).toBe(false);
  });

  test('a superseded in-flight read is dropped, not applied', async () => {
    // Two reads overlap and the OLDER resolves last; without the generation
    // guard it would win and show a stale answer.
    //
    // The overlap comes from the MOUNT read, not two refreshes: the mount copy
    // is inlined in the effect and does not take the in-flight lock, so it is
    // the one path that can still run alongside a refresh. (Two refreshes can
    // no longer overlap — they coalesce; see the burst case above.)
    let releaseMount: (v: string | null) => void = () => {};
    const mountRead = new Promise<string | null>((r) => {
      releaseMount = r;
    });
    const fetchLatest = vi
      .fn()
      .mockReturnValueOnce(mountRead) // gen 1, held open
      .mockResolvedValue('2026-08-04T00:00:00.000Z'); // gen 2, lands first

    const dot = await mount(fetchLatest);
    expect(dot.current?.show).toBe(false); // mount has not answered yet

    await act(async () => {
      dot.current?.refresh();
    });
    expect(dot.current?.show).toBe(true);

    await act(async () => {
      releaseMount('2026-07-01T00:00:00.000Z'); // older answer lands late
      await mountRead;
    });

    expect(dot.current?.show).toBe(true);
  });
});
