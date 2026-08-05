// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement, act, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { usePackDetailPoll } from '../use-pack-detail-poll';
import type { PackDetail } from '@/lib/data/packs';

// No @testing-library/react (or any React-hook test harness) lives in this
// repo yet -- use-sound.test.ts / consent.test.ts test hooks by extracting
// pure logic, but this hook's whole bug is about behavior ACROSS renders
// (a changing `slug` prop), which a pure-logic extraction can't observe.
// Drive React directly via createRoot + act instead of adding a dependency;
// react-dom + jsdom are already installed. The result is captured in a
// layout effect (not during render) so it stays a side effect, not a render
// impurity -- act() flushes layout effects synchronously, so it's readable
// immediately after render/rerender.
function renderHook<T>(useHook: () => T) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const box: { current: T } = { current: undefined as unknown as T };
  let root!: Root;
  function Probe() {
    const result = useHook();
    useLayoutEffect(() => {
      box.current = result;
    });
    return null;
  }
  act(() => {
    root = createRoot(container);
    root.render(createElement(Probe));
  });
  return {
    get current() {
      return box.current;
    },
    rerender: () => {
      act(() => {
        root.render(createElement(Probe));
      });
    },
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

// jsdom's default document.visibilityState is "prerender", not "visible" --
// the hook's tick() would silently no-op every test without this, since it
// bails out early on a hidden/prerendering tab.
Object.defineProperty(document, 'visibilityState', {
  configurable: true,
  get: () => 'visible',
});

const detailA: PackDetail = {
  topHits: [],
  pool: [],
  publishedOdds: null,
  demoOdds: null,
};

describe('usePackDetailPoll', () => {
  beforeEach(() => {
    // Default: a fetch that never resolves, so the effect's background tick
    // can't sneak a state update into tests that aren't asserting on it.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {})),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the initial non-null seed', () => {
    const props = { slug: 'pack-a', initial: detailA as PackDetail | null };
    const hook = renderHook(() => usePackDetailPoll(props.slug, props.initial));
    expect(hook.current).toBe(detailA);
    hook.unmount();
  });

  it('a sibling switch with initial=null yields null, never the old pack data', () => {
    const props = { slug: 'pack-a', initial: detailA as PackDetail | null };
    const hook = renderHook(() => usePackDetailPoll(props.slug, props.initial));
    expect(hook.current).toBe(detailA);

    // Switch to a sibling pack -- PackDetailClient now passes null (it is
    // no longer the URL pack), so the hook must clear, not keep showing A.
    props.slug = 'pack-b';
    props.initial = null;
    hook.rerender();
    expect(hook.current).toBeNull();
    hook.unmount();
  });

  it('stays null after a switch when the corrective fetch fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('network down'))),
    );
    const props = { slug: 'pack-a', initial: detailA as PackDetail | null };
    const hook = renderHook(() => usePackDetailPoll(props.slug, props.initial));

    props.slug = 'pack-b';
    props.initial = null;
    await act(async () => {
      hook.rerender();
      // Flush the rejected fetch through the effect's try/catch.
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(hook.current).toBeNull();
    hook.unmount();
  });
});
