// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { RecentFeed } from '@/lib/data/packs';
import { POLY_CATEGORY } from '@/lib/packs-data';

// The drawer follows the shelf's tab (Poly or not) as today's panel does:
// the first render reads the server feed's scope (the whole store), the
// shelf's category applies after mount.

const shelf = vi.hoisted(() => ({ active: '' }));
const feedCalls = vi.hoisted(() => [] as (string | undefined)[]);
const pausedCalls = vi.hoisted(() => [] as (boolean | undefined)[]);
/** What the drawer last handed its view. */
const view = vi.hoisted(() => ({
  props: null as null | { tab: string; onTab?: (tab: string) => void },
}));

vi.mock('@/components/home/ShelfCategory', () => ({
  useShelfCategory: () => ({ active: shelf.active }),
}));
vi.mock('@/lib/use-recent-pulls', () => ({
  useLiveRecentPulls: (
    initial: RecentFeed,
    _a: unknown,
    _b: unknown,
    category: string | undefined,
    opts?: { paused?: boolean },
  ) => {
    feedCalls.push(category);
    pausedCalls.push(opts?.paused);
    return {
      pulls: initial.pulls,
      drought: initial.drought,
      pending: false,
      shownScope: 'all',
      shownCategory: category,
    };
  },
}));
vi.mock('@/lib/use-reveal', () => ({ usePrefersReducedMotion: () => false }));
vi.mock('@/components/PullGapsChart', () => ({ PullGapsChart: () => null }));
vi.mock('../JustPulledView', () => ({
  JustPulledView: (props: NonNullable<typeof view.props>) => {
    view.props = props;
    return null;
  },
}));

const { JustPulledDrawer } = await import('../JustPulledDrawer');

const initial = { pulls: [], drought: {} } as unknown as RecentFeed;

let frames: FrameRequestCallback[] = [];
let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  feedCalls.length = 0;
  pausedCalls.length = 0;
  frames = [];
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    frames.push(cb);
    return frames.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: false,
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

function mount() {
  act(() => {
    root = createRoot(host);
    root.render(createElement(JustPulledDrawer, { initial }));
  });
}

function nextFrame() {
  const due = frames;
  frames = [];
  act(() => due.forEach((cb) => cb(0)));
}

describe('JustPulledDrawer follows the shelf tab', () => {
  it('reads the whole store on its first render, on the Poly tab too', () => {
    shelf.active = POLY_CATEGORY;
    mount();
    expect(feedCalls[0]).toBeUndefined();
  });

  it('asks for the Poly feed after mount on the Poly tab', () => {
    shelf.active = POLY_CATEGORY;
    mount();
    nextFrame();
    expect(feedCalls.at(-1)).toBe(POLY_CATEGORY);
  });

  it('keeps the whole store after mount on any other tab', () => {
    shelf.active = 'pokemon';
    mount();
    nextFrame();
    expect(feedCalls.length).toBeGreaterThan(1);
    expect(feedCalls.every((c) => c === undefined)).toBe(true);
  });
});

// The section's height is what the flow's scroll is measured by, so the
// chart (several screens tall) never stands in the drawer's place.
describe('JustPulledDrawer opens Stats in a sheet', () => {
  it('keeps the filter and the drawer under a dialog, and closes it', () => {
    shelf.active = 'pokemon';
    mount();
    nextFrame();
    act(() => view.props?.onTab?.('Stats'));
    expect(view.props?.tab).toBe('All');
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    act(() =>
      document
        .querySelector<HTMLElement>('[aria-label="Close stats"]')
        ?.click(),
    );
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});

describe('JustPulledDrawer pauses while a pack is focused', () => {
  it('pauses on a focused pack before its details, resumes past them or on leave', async () => {
    shelf.active = '';
    const wrap = document.createElement('div');
    const flow = document.createElement('div');
    flow.append(wrap);
    document.body.append(flow);
    mount();
    expect(pausedCalls.at(-1)).toBe(false);
    const settle = () => act(async () => {});
    wrap.setAttribute('data-focus-on', '');
    await settle();
    expect(pausedCalls.at(-1)).toBe(true);
    flow.setAttribute('data-flow-past', '');
    await settle();
    expect(pausedCalls.at(-1)).toBe(false);
    flow.removeAttribute('data-flow-past');
    await settle();
    expect(pausedCalls.at(-1)).toBe(true);
    wrap.removeAttribute('data-focus-on');
    await settle();
    expect(pausedCalls.at(-1)).toBe(false);
    flow.remove();
  });
});
