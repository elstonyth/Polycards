// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { renderHook } from './render-hook';
import { usePackDetailPoll } from '../use-pack-detail-poll';
import type { PackDetail } from '@/lib/data/packs';

// The rule under test is the one usePackDetailPoll owns on top of useLivePoll:
// what it renders while a slug's own data has not landed yet (the new seed —
// never the previous pack's detail under the new pack's name). The timer, the
// visibility gate and the ordering guard live in use-live-poll.test.ts.
// `renderHook`'s props argument is unused here on purpose: these cases mutate
// a fixture the hook closes over, which is what a parent re-rendering with new
// props looks like from inside.

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
    const hook = renderHook(
      () => usePackDetailPoll(props.slug, props.initial),
      undefined,
    );
    expect(hook.current).toBe(detailA);
    hook.unmount();
  });

  it('a sibling switch with initial=null yields null, never the old pack data', () => {
    const props = { slug: 'pack-a', initial: detailA as PackDetail | null };
    const hook = renderHook(
      () => usePackDetailPoll(props.slug, props.initial),
      undefined,
    );
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
    const hook = renderHook(
      () => usePackDetailPoll(props.slug, props.initial),
      undefined,
    );

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
