// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { renderHook } from '@/lib/__tests__/render-hook';

// The flow's address: stage / focus / other,
// our own focus entries, Back / Forward, a reload on a focused URL and a cold
// load, and the reel seam. Next's router is a mock that reads the live URL,
// as Next's own does after a history move.

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  usePathname: () => window.location.pathname,
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const load = async () => import('../flow-address');

/** history.back / forward fire popstate asynchronously in jsdom. */
const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });

beforeEach(() => {
  push.mockReset();
  window.history.replaceState(null, '', '/');
});
afterEach(() => {
  vi.resetModules();
});

describe('flowLocationOf', () => {
  it('maps the address to stage, focus or other', async () => {
    const { flowLocationOf } = await load();
    expect(flowLocationOf('/', '/')).toEqual({ kind: 'stage' });
    expect(flowLocationOf('/home-preview/', '/home-preview')).toEqual({
      kind: 'stage',
    });
    expect(flowLocationOf('/slots/gold-pack', '/')).toEqual({
      kind: 'focus',
      id: 'gold-pack',
    });
    expect(flowLocationOf('/slots/a%20b', '/')).toEqual({
      kind: 'focus',
      id: 'a b',
    });
    expect(flowLocationOf('/slots/gold-pack/spin', '/')).toEqual({
      kind: 'other',
    });
    expect(flowLocationOf('/card/pikachu-1', '/')).toEqual({ kind: 'other' });
  });
});

describe('useFlowAddress', () => {
  it('enter pushes /slots/<id> with the flow marker; Back unfocuses, Forward refocuses', async () => {
    const { useFlowAddress, FLOW_MARK } = await load();
    const h = renderHook(() => useFlowAddress('/'), undefined);
    expect(h.current.location).toEqual({ kind: 'stage' });
    const length = window.history.length;

    act(() => h.current.enter('gold-pack'));
    expect(window.location.pathname).toBe('/slots/gold-pack');
    expect(window.location.search).toBe('');
    expect(window.history.length).toBe(length + 1);
    expect(h.current.location).toEqual({ kind: 'focus', id: 'gold-pack' });
    expect(h.current.isOurs).toBe(true);
    const id = h.current.entryId;
    expect(id).toMatch(/^f/);
    expect((window.history.state as Record<string, string>)[FLOW_MARK]).toBe(
      id,
    );

    act(() => window.history.back());
    await settle();
    expect(window.location.pathname).toBe('/');
    expect(h.current.location).toEqual({ kind: 'stage' });
    expect(h.current.entryId).toBeNull();

    act(() => window.history.forward());
    await settle();
    expect(h.current.location).toEqual({ kind: 'focus', id: 'gold-pack' });
    expect(h.current.entryId).toBe(id);
    expect(h.current.isOurs).toBe(true);
    h.unmount();
  });

  it('a quantity above 1 rides the address; count is read back from it', async () => {
    const { useFlowAddress } = await load();
    const h = renderHook(() => useFlowAddress('/'), undefined);
    act(() => h.current.enter('gold-pack', 2));
    expect(window.location.search).toBe('?count=2');
    expect(h.current.count).toBe(2);
    h.unmount();
  });

  it('leave on our entry goes Back (no new entry, no navigation)', async () => {
    const { useFlowAddress } = await load();
    const markArrival = vi.fn();
    const h = renderHook(() => useFlowAddress('/', { markArrival }), undefined);
    act(() => h.current.enter('gold-pack'));
    const length = window.history.length;
    act(() => h.current.leave());
    await settle();
    expect(window.location.pathname).toBe('/');
    expect(window.history.length).toBe(length);
    expect(push).not.toHaveBeenCalled();
    expect(markArrival).not.toHaveBeenCalled();
    h.unmount();
  });

  it('a cold load of /slots/<id>: focused, not ours; leave marks the arrival and pushes the base', async () => {
    window.history.replaceState(null, '', '/slots/gold-pack');
    const { useFlowAddress } = await load();
    const markArrival = vi.fn();
    const h = renderHook(() => useFlowAddress('/', { markArrival }), undefined);
    expect(h.current.location).toEqual({ kind: 'focus', id: 'gold-pack' });
    expect(h.current.entryId).toBeNull();
    expect(h.current.isOurs).toBe(false);
    act(() => h.current.leave());
    expect(markArrival).toHaveBeenCalledOnce();
    expect(push).toHaveBeenCalledWith('/');
    h.unmount();
  });

  it('a reload on a focused entry: the marker survives, but it is no longer ours', async () => {
    const first = await load();
    const a = renderHook(() => first.useFlowAddress('/'), undefined);
    act(() => a.current.enter('gold-pack'));
    const id = a.current.entryId;
    a.unmount();

    // A reload: a fresh document's modules, the same history entry.
    vi.resetModules();
    const second = await load();
    const markArrival = vi.fn();
    const b = renderHook(
      () => second.useFlowAddress('/', { markArrival }),
      undefined,
    );
    expect(b.current.location).toEqual({ kind: 'focus', id: 'gold-pack' });
    expect(b.current.entryId).toBe(id);
    expect(b.current.isOurs).toBe(false);
    act(() => b.current.leave());
    expect(markArrival).toHaveBeenCalledOnce();
    expect(push).toHaveBeenCalledWith('/');
    b.unmount();
  });

  it('an address naming neither (a card overlay) keeps the focus', async () => {
    const { useFlowAddress } = await load();
    const h = renderHook(() => useFlowAddress('/'), undefined);
    act(() => h.current.enter('gold-pack'));
    act(() => {
      window.history.pushState(null, '', '/card/pikachu-1');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(h.current.location).toEqual({ kind: 'focus', id: 'gold-pack' });
    h.unmount();
  });

  it('enterReel is the one reel seam: a plain navigation today', async () => {
    const { useFlowAddress } = await load();
    const h = renderHook(() => useFlowAddress('/'), undefined);
    act(() => h.current.enterReel('/slots/gold-pack/spin?count=2'));
    expect(push).toHaveBeenCalledWith('/slots/gold-pack/spin?count=2');
    h.unmount();
  });

  it('a junk count reads as none', async () => {
    window.history.replaceState(null, '', '/slots/gold-pack?count=abc');
    const { useFlowAddress } = await load();
    const h = renderHook(() => useFlowAddress('/'), undefined);
    expect(h.current.count).toBeNull();
    h.unmount();
  });
});
