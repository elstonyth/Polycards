// @vitest-environment jsdom
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { act, createElement, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import type { PackCard, ResolvedPack } from '@/lib/packs-data';
import type { PackDetail, RecentFeed } from '@/lib/data/packs';
import { renderHook, flush } from '@/lib/__tests__/render-hook';

// The parts the homepage flow reuses from the pack page: the tier walk, the
// sections and their card overlay, the shared rail helpers, the live tiers
// poll, and the rule that none of them reads the address through Next's
// search-params hook.

vi.mock('next/image', () => ({
  default: ({ alt }: { alt: string }) => createElement('img', { alt }),
}));
vi.mock('next/link', () => ({
  default: ({
    children,
    prefetch: _p,
    ...props
  }: Record<string, unknown> & { children?: ReactNode }) =>
    createElement('a', props, children),
}));
vi.mock('@/lib/use-liquid-glass', () => ({
  useLiquidGlass: vi.fn(),
  GLASS_SUBTLE: {},
}));
vi.mock('@/components/cards/PokemonBadge', () => ({
  PokemonBadge: () => null,
}));
vi.mock('@/components/Reveal', () => ({
  default: ({ children, as }: { children: ReactNode; as?: string }) =>
    createElement(as ?? 'div', { 'data-reveal': 1 }, children),
}));
vi.mock('@/components/PullHistory', () => ({
  PullHistory: (p: {
    packSlug: string;
    noun: string;
    onSelect?: (c: unknown) => void;
  }) =>
    createElement(
      'button',
      {
        'data-history': `${p.packSlug}|${p.noun}`,
        onClick: () => p.onSelect?.({ handle: 'pulled', name: 'Pulled' }),
      },
      'history',
    ),
}));
vi.mock('@/components/cards/CardDetailOverlay', () => ({
  CardDetailOverlay: (p: {
    seed: { handle: string } | null;
    buybackPercent: number;
    onClose: () => void;
  }) =>
    p.seed
      ? createElement(
          'button',
          {
            'data-overlay': `${p.seed.handle}|${p.buybackPercent}`,
            onClick: p.onClose,
          },
          'overlay',
        )
      : null,
}));

const { PackTierWalk, walkRows } = await import('../PackTierWalk');
const sections = await import('../PackDetailSections');
const rail = await import('../pool-rail');
const { usePackLive, packTiersUrl } = await import('../use-pack-live');
const { packTierRows, packTiersOf } = await import('@/lib/pack-tiers');
const { ticketCard } = await import('@/lib/packs-data');

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const card = (
  n: number,
  rarity: PackCard['rarity'],
  priceMyr: number,
): PackCard => ({
  handle: `card-${n}`,
  name: `Card ${n}`,
  image: `/c${n}.png`,
  slabImage: null,
  rarity,
  priceMyr,
  pokemonDex: null,
  spriteImage: null,
});
const POOL = [
  card(1, 'Immortal', 9000),
  card(2, 'Immortal', 5000),
  card(3, 'Mythical', 70),
  card(4, 'Common', 5),
];
const DETAIL: PackDetail = {
  topHits: [],
  pool: POOL,
  publishedOdds: {
    tiers: { Immortal: 0.2, Legendary: 1, Mythical: 3.8, Common: 95 },
  },
};
const GOLD: ResolvedPack = {
  id: 'gold-pack',
  name: 'Gold Pack',
  priceMyr: 1200,
  image: '/g.webp',
  categoryId: 'pokemon',
  categoryName: 'Pokemon',
  icon: '/p.webp',
  buybackPercent: 95,
};
const CAPSULE = { prizeType: 'tickets' as const, categoryId: 'poly' };

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
const show = (el: React.ReactElement) => act(() => root.render(el));
const text = () => (host.textContent ?? '').replace(/\s+/g, ' ');

describe('PackTierWalk', () => {
  it('one row per top tier the pack has, rarest first; a missing tier is left out', () => {
    show(
      createElement(PackTierWalk, {
        pack: GOLD,
        tiers: packTierRows(DETAIL, false),
        onOpenCard: vi.fn(),
      }),
    );
    expect(host.querySelector('h2')?.textContent).toBe('Top Hits');
    expect([...host.querySelectorAll('h3')].map((h) => h.textContent)).toEqual([
      'Immortal',
      'Mythical',
    ]);
    const lists = [...host.querySelectorAll('ul')];
    expect(lists.map((l) => l.getAttribute('aria-label'))).toEqual([
      'Immortal cards, 2',
      'Mythical cards, 1',
    ]);
    expect(lists[0]!.querySelectorAll('li')).toHaveLength(2);
    expect(text()).toContain('0.2% a pull');
    expect(text()).toContain('RM 5,000.00 – RM 9,000.00');
    expect(text()).toContain('2 cards');
    // Lower tiers have no row here.
    expect(text()).not.toContain('Common');
  });

  it('a tap opens the card', () => {
    const onOpenCard = vi.fn();
    show(
      createElement(PackTierWalk, {
        pack: GOLD,
        tiers: packTierRows(DETAIL, false),
        onOpenCard,
      }),
    );
    act(() =>
      host
        .querySelector<HTMLButtonElement>(
          'button[aria-label^="View details for Card 2"]',
        )!
        .click(),
    );
    expect(onOpenCard.mock.calls[0]?.[0].handle).toBe('card-2');
  });

  it('without pull odds: no chance, still the range and count', () => {
    show(
      createElement(PackTierWalk, {
        pack: GOLD,
        tiers: packTierRows({ ...DETAIL, publishedOdds: null }, false),
        onOpenCard: vi.fn(),
      }),
    );
    expect(text()).not.toContain('a pull');
    expect(text()).toContain('2 cards');
  });

  it('a capsule: prizes, ticket ranges, ticket tiles', () => {
    const tickets: PackDetail = {
      topHits: [],
      pool: [
        ticketCard(1000, 'Immortal'),
        ticketCard(300, 'Immortal'),
        ticketCard(5, 'Common'),
      ],
      publishedOdds: { tiers: { Immortal: 1, Common: 99 } },
    };
    show(
      createElement(PackTierWalk, {
        pack: CAPSULE,
        tiers: packTierRows(tickets, true),
        onOpenCard: vi.fn(),
      }),
    );
    expect(host.querySelector('ul')?.getAttribute('aria-label')).toBe(
      'Immortal prizes, 2',
    );
    expect(text()).toContain('300 – 1,000 tickets');
    expect(text()).toContain('2 prizes');
    expect(host.querySelector('button[aria-label^="View details"]')).toBeNull();
  });

  it('a capsule with no top tier: one "All prizes" row, biggest first', () => {
    const rows = walkRows(
      packTierRows(
        {
          pool: [ticketCard(5, 'Common'), ticketCard(50, 'Rare')],
          publishedOdds: null,
        },
        true,
      ).tiers,
      true,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tier).toBeNull();
    expect(rows[0]!.cards.map((c) => c.tickets)).toEqual([50, 5]);
  });

  it('a card pack with no top tier, or no tiers: nothing', () => {
    show(
      createElement(PackTierWalk, {
        pack: GOLD,
        tiers: packTierRows({ ...DETAIL, pool: [card(4, 'Common', 5)] }, false),
        onOpenCard: vi.fn(),
      }),
    );
    expect(host.innerHTML).toBe('');
    show(
      createElement(PackTierWalk, {
        pack: GOLD,
        tiers: null,
        onOpenCard: vi.fn(),
      }),
    );
    expect(host.innerHTML).toBe('');
  });
});

describe('PackDetailSections', () => {
  function Page({
    pack,
    detail,
    feed,
  }: {
    pack: ResolvedPack;
    detail: PackDetail | null;
    feed: RecentFeed;
  }) {
    const overlay = sections.usePackCardOverlay(pack.id);
    return createElement(
      'div',
      null,
      createElement(sections.PackTopHits, {
        pack,
        detail,
        onOpenCard: overlay.open,
      }),
      createElement(sections.PackPullOdds, {
        pack,
        tiers: packTiersOf(pack, detail),
      }),
      createElement(sections.PackRecentPulls, {
        pack,
        initial: feed,
        onOpenCard: overlay.open,
      }),
      createElement(sections.PackCardOverlay, { pack, overlay }),
    );
  }
  const feed: RecentFeed = { pulls: [], drought: {} };

  it("today's gates: Top Hits on a pool, odds board, history; a tap opens the overlay", () => {
    show(createElement(Page, { pack: GOLD, detail: DETAIL, feed }));
    expect(text()).toContain('Top Hits');
    expect(text()).toContain('Pull Odds (by rarity)');
    expect(
      host.querySelector('[data-history="gold-pack|pack"]'),
    ).not.toBeNull();
    act(() =>
      host
        .querySelector<HTMLButtonElement>(
          'button[aria-label^="View details for Card 1"]',
        )!
        .click(),
    );
    expect(
      host.querySelector('[data-overlay]')?.getAttribute('data-overlay'),
    ).toBe('card-1|95');
    act(() => host.querySelector<HTMLButtonElement>('[data-overlay]')!.click());
    expect(host.querySelector('[data-overlay]')).toBeNull();
    act(() => host.querySelector<HTMLButtonElement>('[data-history]')!.click());
    expect(
      host.querySelector('[data-overlay]')?.getAttribute('data-overlay'),
    ).toBe('pulled|95');
  });

  it('the overlay closes when the page moves to another pack', () => {
    function Switcher() {
      const [pack, setPack] = useState(GOLD);
      return createElement(
        'div',
        null,
        createElement('button', {
          'data-switch': 1,
          onClick: () => setPack({ ...GOLD, id: 'silver-pack' }),
        }),
        createElement(Page, { pack, detail: DETAIL, feed }),
      );
    }
    show(createElement(Switcher));
    act(() => host.querySelector<HTMLButtonElement>('[data-history]')!.click());
    expect(host.querySelector('[data-overlay]')).not.toBeNull();
    act(() => host.querySelector<HTMLButtonElement>('[data-switch]')!.click());
    expect(host.querySelector('[data-overlay]')).toBeNull();
  });

  it('no pool, no Top Hits; a Draft, no history; bare drops the reveal', () => {
    show(
      createElement(Page, {
        pack: { ...GOLD, draft: true },
        detail: null,
        feed,
      }),
    );
    expect(text()).not.toContain('Top Hits');
    expect(host.querySelector('[data-history]')).toBeNull();
    show(
      createElement(sections.PackRecentPulls, {
        pack: GOLD,
        initial: feed,
        bare: true,
      }),
    );
    expect(host.querySelector('[data-reveal]')).toBeNull();
    expect(host.querySelector('section [data-history]')).not.toBeNull();
  });

  it('a capsule history says capsule', () => {
    show(
      createElement(sections.PackRecentPulls, {
        pack: { ...GOLD, prizeType: 'tickets' },
        initial: feed,
      }),
    );
    expect(
      host.querySelector('[data-history="gold-pack|capsule"]'),
    ).not.toBeNull();
  });
});

describe('pool-rail', () => {
  it('fades only the side with more behind it', () => {
    expect(rail.edgeFade({ prev: false, next: false })).toBeUndefined();
    expect(rail.edgeFade({ prev: false, next: true })?.maskImage).toBe(
      'linear-gradient(to right, transparent, #000 0px, #000 calc(100% - min(56px, 8%)), transparent)',
    );
  });

  it('a ticket tile states its place, tier and amount', () => {
    show(
      createElement(rail.TicketTile, {
        card: ticketCard(1000, 'Immortal'),
        rank: 2,
      }),
    );
    expect(text()).toContain('02');
    expect(text()).toContain('Immortal');
    expect(text()).toContain('1,000');
    expect(text()).toContain('tickets');
  });

  it('an arrow at the end stays focusable but does nothing', () => {
    const onClick = vi.fn();
    show(
      createElement(
        rail.StripArrow as (p: {
          label: string;
          enabled: boolean;
          onClick: () => void;
          children?: ReactNode;
        }) => ReactNode,
        { label: 'Next cards', enabled: false, onClick },
        'x',
      ),
    );
    const b = host.querySelector('button')!;
    expect(b.getAttribute('aria-disabled')).toBe('true');
    act(() => b.click());
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe('usePackLive', () => {
  const seed = packTiersOf(GOLD, DETAIL)!;
  const fetchMock = vi.fn();
  beforeAll(async () => {
    // zod loads on demand in the browser; have it ready before the clock is faked.
    await (await import('@/lib/lazy-schemas')).loadSchemas();
  });
  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  const answer = (body: unknown, ok = true) =>
    fetchMock.mockResolvedValue({ ok, json: async () => body });

  it('shows the seed, then the polled view after the first tick', async () => {
    const polled = { ...seed, pack: { ...seed.pack, buybackPercent: 100 } };
    answer(JSON.parse(JSON.stringify(polled)));
    const h = renderHook(
      ({ slug }: { slug: string | null }) => usePackLive(slug, seed),
      { slug: 'gold-pack' },
    );
    expect(h.current.live?.buybackPercent).toBe(95);
    expect(fetchMock).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    await flush();
    await flush();
    expect(fetchMock).toHaveBeenCalledWith(packTiersUrl('gold-pack'), {
      cache: 'no-store',
    });
    expect(h.current.live?.buybackPercent).toBe(100);
    h.unmount();
  });

  it('no seed: fetches at once; a malformed answer keeps the last view', async () => {
    answer({ tiers: 'nope' });
    const h = renderHook(() => usePackLive('gold-pack', null), undefined);
    await flush();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(h.current.tiers).toBeNull();
    h.unmount();
  });

  it('no slug: polls nothing', async () => {
    const h = renderHook(() => usePackLive(null, null), undefined);
    await act(async () => {
      vi.advanceTimersByTime(120_000);
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.current).toEqual({ tiers: null, live: null });
    h.unmount();
  });
});

describe("the extracted parts never use Next's search-params hook", () => {
  const dir = join(process.cwd(), 'src', 'app', 'slots', '[slug]') + sep;
  it.each([
    'use-pack-buy.ts',
    'PackBuyControls.tsx',
    'PackDetailSections.tsx',
    'PackTierWalk.tsx',
    'pool-rail.tsx',
    'use-pack-live.ts',
    'PackDetailClient.tsx',
    'PoolByRarity.tsx',
    'OddsBoard.tsx',
  ])('%s', (name) => {
    const src = readFileSync(`${dir}${name}`, 'utf8');
    expect(src).not.toMatch(/\buse(Search)Params\b/);
    expect(src).not.toMatch(/['"]next\/headers['"]/);
  });
});
