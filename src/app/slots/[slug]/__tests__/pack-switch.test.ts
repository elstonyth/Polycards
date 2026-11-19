// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, createElement, type AnchorHTMLAttributes } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Pack, ResolvedPack } from '@/lib/packs-data';
import type { PackPageData } from '@/lib/data/pack-page';

// The picker switches packs IN PLACE: a plain click on a tile fetches the
// pack's data and moves the address, with no page load. The address still owns
// which pack is shown, and a tile is still a real link.

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  // The real hook follows history.pushState; here each render reads the address.
  usePathname: () => window.location.pathname,
}));
vi.mock('next/link', () => ({
  default: ({
    children,
    scroll: _scroll,
    prefetch: _prefetch,
    ...props
  }: AnchorHTMLAttributes<HTMLAnchorElement> & {
    scroll?: boolean;
    prefetch?: boolean;
  }) => createElement('a', props, children),
}));
vi.mock('next/image', () => ({
  default: ({ src, alt }: { src: string; alt: string }) =>
    createElement('img', { src, alt }),
}));
// The page itself is not under test: a stand-in that shows which pack it was
// given and exposes the switch.
type Stub = {
  pack: ResolvedPack;
  pendingPack: string | null;
  onPick: (id: string, href: string) => void;
  onIntent: (id: string) => void;
};
let page: Stub;
vi.mock('../PackDetailClient', () => ({
  default: (props: Stub) => {
    page = props;
    return createElement(
      'h1',
      { 'data-pending': props.pendingPack ?? '' },
      props.pack.name,
    );
  },
}));

const { default: PackPage, packSlugOf } = await import('../PackPage');
const { PackPicker } = await import('../PackPicker');

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const bronze: ResolvedPack = {
  id: 'bronze-pack',
  name: 'Bronze Pack',
  priceMyr: 300,
  image: '/bronze.png',
  categoryId: 'pokemon',
  categoryName: 'Pokémon',
  icon: '/pokemon.png',
  group: 'GRADED',
};
const silver: ResolvedPack = {
  ...bronze,
  id: 'silver-pack',
  name: 'Silver Pack',
  priceMyr: 600,
};
const data = (pack: ResolvedPack): PackPageData => ({
  pack,
  siblings: [bronze, silver],
  categoryTabs: [],
  detail: null,
  recentPulls: { pulls: [], drought: {} },
  freePackMissing: [],
});

let host: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;
const answer = (body: unknown, ok = true) =>
  Promise.resolve({ ok, status: ok ? 200 : 500, json: async () => body });

beforeEach(() => {
  window.history.replaceState(null, '', '/slots/bronze-pack?count=2');
  document.title = 'Bronze Pack — Pokémon · Polycards';
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  push.mockReset();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const h1 = () => host.querySelector('h1');

describe('switching packs in place', () => {
  const show = () =>
    act(async () =>
      root.render(
        createElement(PackPage, { initial: data(bronze), initialQty: 2 }),
      ),
    );

  test('a pick fetches the pack, moves the address and redraws, with no navigation', async () => {
    fetchMock.mockReturnValue(answer(data(silver)));
    await show();
    const entries = window.history.length;
    await act(async () =>
      page.onPick('silver-pack', '/slots/silver-pack?count=2'),
    );
    expect(fetchMock).toHaveBeenCalledWith('/api/pack-page/silver-pack', {
      cache: 'no-store',
    });
    expect(window.location.pathname + window.location.search).toBe(
      '/slots/silver-pack?count=2',
    );
    // One Back entry per switch, so Back walks the packs.
    expect(window.history.length).toBe(entries + 1);
    await show();
    expect(h1()?.textContent).toBe('Silver Pack');
    expect(document.title).toBe('Silver Pack — Pokémon · Polycards');
    expect(push).not.toHaveBeenCalled();
  });

  test('the tapped pack reads as pending until its data lands', async () => {
    let land: (value: unknown) => void = () => {};
    fetchMock.mockReturnValue(new Promise((resolve) => (land = resolve)));
    await show();
    await act(async () =>
      page.onPick('silver-pack', '/slots/silver-pack?count=2'),
    );
    // Still Bronze, at Bronze's address: nothing is torn down while waiting.
    expect(h1()?.textContent).toBe('Bronze Pack');
    expect(h1()?.getAttribute('data-pending')).toBe('silver-pack');
    expect(window.location.pathname).toBe('/slots/bronze-pack');
    await act(async () => land(await answer(data(silver))));
    expect(h1()?.getAttribute('data-pending')).toBe('');
    expect(window.location.pathname).toBe('/slots/silver-pack');
  });

  test('the address owns the pack: Back shows the pack it names', async () => {
    fetchMock.mockReturnValue(answer(data(silver)));
    await show();
    await act(async () =>
      page.onPick('silver-pack', '/slots/silver-pack?count=2'),
    );
    await show();
    expect(h1()?.textContent).toBe('Silver Pack');
    window.history.replaceState(null, '', '/slots/bronze-pack?count=2');
    await show();
    expect(h1()?.textContent).toBe('Bronze Pack');
    expect(document.title).toBe('Bronze Pack — Pokémon · Polycards');
    // Forward again: the fetched pack is still held, no second request.
    window.history.replaceState(null, '', '/slots/silver-pack?count=2');
    await show();
    expect(h1()?.textContent).toBe('Silver Pack');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('a failed fetch falls back to an ordinary navigation', async () => {
    fetchMock.mockReturnValue(answer({ message: 'boom' }, false));
    await show();
    await act(async () =>
      page.onPick('silver-pack', '/slots/silver-pack?count=2'),
    );
    expect(push).toHaveBeenCalledWith('/slots/silver-pack?count=2', {
      scroll: false,
    });
    expect(window.location.pathname).toBe('/slots/bronze-pack');
    expect(h1()?.textContent).toBe('Bronze Pack');
  });

  test('an answer for the wrong pack is a failure, never drawn', async () => {
    fetchMock.mockReturnValue(answer(data(bronze)));
    await show();
    await act(async () =>
      page.onPick('silver-pack', '/slots/silver-pack?count=2'),
    );
    expect(push).toHaveBeenCalledTimes(1);
    expect(window.location.pathname).toBe('/slots/bronze-pack');
  });

  test('the latest pick wins when an earlier one answers late', async () => {
    const gold = { ...bronze, id: 'gold-pack', name: 'Gold Pack' };
    let landSilver: (value: unknown) => void = () => {};
    fetchMock.mockImplementation((url: string) =>
      url.endsWith('silver-pack')
        ? new Promise((resolve) => (landSilver = resolve))
        : answer(data(gold)),
    );
    await show();
    await act(async () => page.onPick('silver-pack', '/slots/silver-pack'));
    await act(async () => page.onPick('gold-pack', '/slots/gold-pack'));
    await act(async () => landSilver(await answer(data(silver))));
    expect(window.location.pathname).toBe('/slots/gold-pack');
    await show();
    expect(h1()?.textContent).toBe('Gold Pack');
  });

  test('reaching a tile fetches early, and the click after it reuses that', async () => {
    fetchMock.mockReturnValue(answer(data(silver)));
    await show();
    await act(async () => page.onIntent('silver-pack'));
    await act(async () => page.onIntent('silver-pack'));
    await act(async () =>
      page.onPick('silver-pack', '/slots/silver-pack?count=2'),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(window.location.pathname).toBe('/slots/silver-pack');
    // The pack on the page is never fetched for.
    await show();
    await act(async () => page.onIntent('silver-pack'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('a card opened over the page is not a pack to fetch', async () => {
    // CardDetailOverlay moves the address to the card while the page stays.
    await show();
    window.history.replaceState(null, '', '/card/charizard-4');
    await show();
    await act(async () => {});
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h1()?.textContent).toBe('Bronze Pack');
    expect(document.title).toBe('Bronze Pack — Pokémon · Polycards');
  });

  test('only a pack page address names a pack', () => {
    expect(packSlugOf('/slots/bronze-pack')).toBe('bronze-pack');
    expect(packSlugOf('/slots/bronze-pack/')).toBe('bronze-pack');
    expect(packSlugOf('/slots/jp%20151')).toBe('jp 151');
    expect(packSlugOf('/slots/bronze-pack/spin')).toBeNull();
    expect(packSlugOf('/card/charizard-4')).toBeNull();
    expect(packSlugOf('/slots')).toBeNull();
    expect(packSlugOf('/')).toBeNull();
  });

  test('an address whose pack is not held is fetched', async () => {
    fetchMock.mockReturnValue(answer(data(silver)));
    // The router restored an older tree: Bronze's data under Silver's address.
    window.history.replaceState(null, '', '/slots/silver-pack');
    await show();
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(h1()?.textContent).toBe('Silver Pack');
  });
});

describe('a pack tile is a link that a plain click switches in place', () => {
  const onPick = vi.fn();
  const onIntent = vi.fn();
  const picker = (over: Partial<Parameters<typeof PackPicker>[0]> = {}) =>
    act(() =>
      root.render(
        createElement(PackPicker, {
          pack: bronze,
          siblings: [bronze, silver] as Pack[],
          categoryTabs: [],
          qty: 2,
          onCategory: vi.fn(),
          onPick,
          onIntent,
          ...over,
        }),
      ),
    );
  const tile = (id: string) =>
    host.querySelector<HTMLAnchorElement>(`a[href^="/slots/${id}"]`)!;
  const click = (el: Element, init: MouseEventInit = {}) => {
    const event = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      ...init,
    });
    act(() => {
      el.dispatchEvent(event);
    });
    return event;
  };

  beforeEach(() => {
    onPick.mockReset();
    onIntent.mockReset();
  });

  test('a plain click switches and is not followed as a link', () => {
    picker();
    const event = click(tile('silver-pack'));
    expect(onPick).toHaveBeenCalledWith(
      'silver-pack',
      '/slots/silver-pack?count=2',
    );
    expect(event.defaultPrevented).toBe(true);
  });

  test.each([
    ['ctrl', { ctrlKey: true }],
    ['cmd', { metaKey: true }],
    ['shift', { shiftKey: true }],
    ['middle button', { button: 1 }],
  ])('a %s click is left to the browser', (_name, init) => {
    picker();
    const event = click(tile('silver-pack'), init);
    expect(onPick).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  test('without a switch handler it is an ordinary link', () => {
    picker({ onPick: undefined });
    expect(click(tile('silver-pack')).defaultPrevented).toBe(false);
  });

  test('the pointer resting on a tile announces the intent; a sweep does not', () => {
    vi.useFakeTimers();
    try {
      picker();
      const over = (el: Element, type: 'mouseover' | 'mouseout') =>
        act(() => {
          el.dispatchEvent(new MouseEvent(type, { bubbles: true }));
        });
      // Across the tile and off again before it rests.
      over(tile('silver-pack'), 'mouseover');
      act(() => vi.advanceTimersByTime(60));
      over(tile('silver-pack'), 'mouseout');
      act(() => vi.advanceTimersByTime(500));
      expect(onIntent).not.toHaveBeenCalled();
      // Resting on it.
      over(tile('silver-pack'), 'mouseover');
      act(() => vi.advanceTimersByTime(150));
      expect(onIntent).toHaveBeenCalledExactlyOnceWith('silver-pack');
    } finally {
      vi.useRealTimers();
    }
  });

  test('neither a finger nor keyboard focus fetches a pack early', () => {
    vi.useFakeTimers();
    try {
      picker();
      act(() => {
        tile('silver-pack').dispatchEvent(
          new Event('touchstart', { bubbles: true }),
        );
        tile('silver-pack').focus();
      });
      act(() => vi.advanceTimersByTime(500));
      expect(onIntent).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test('a pending tile wears the tick; the page pack keeps aria-current', () => {
    picker({ pendingPack: 'silver-pack' });
    expect(tile('silver-pack').getAttribute('aria-busy')).toBe('true');
    expect(tile('silver-pack').querySelector('svg')).not.toBeNull();
    expect(tile('bronze-pack').querySelector('svg')).toBeNull();
    expect(tile('bronze-pack').getAttribute('aria-current')).toBe('page');
  });

  test('it stays mounted across a switch, so the tapped tile keeps focus', () => {
    picker();
    const before = tile('silver-pack');
    before.focus();
    picker({ pack: silver });
    expect(tile('silver-pack')).toBe(before);
    expect(document.activeElement).toBe(before);
    expect(before.getAttribute('aria-current')).toBe('page');
  });

  test('it reopens the shelf of a pack that is not on screen', () => {
    const jp: Pack = {
      ...bronze,
      id: 'jp-151',
      name: '151',
      packType: 'original',
      language: 'jp',
    };
    const classic: Pack = { ...bronze, packType: 'classic' };
    const siblings = [classic, jp];
    picker({ pack: { ...bronze, packType: 'classic' }, siblings });
    // Classic's shelf is open: the Japanese original is not on screen.
    expect(host.querySelector('a[href^="/slots/jp-151"]')).toBeNull();
    // Back lands on it: its own shelf opens.
    picker({ pack: { ...bronze, ...jp }, siblings });
    expect(
      host
        .querySelector('a[href^="/slots/jp-151"]')
        ?.getAttribute('aria-current'),
    ).toBe('page');
  });
});
