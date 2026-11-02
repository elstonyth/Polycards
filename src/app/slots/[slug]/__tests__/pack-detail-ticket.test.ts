// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ticketCard, type ResolvedPack } from '@/lib/packs-data';
import type { PackDetail } from '@/lib/data/packs';

// A ticket pack has no card to show, value or sell, so the pack page drops
// everything that assumes one. It keeps the published odds, with ticket amounts
// where a card pack has values, and Top Hits with ticket prizes. The real odds
// panel renders here. The same page with a card pack is the control.

const mocks = vi.hoisted(() => ({
  customer: { id: 'cus_1' } as { id: string } | null,
  // undefined: the poll answers with its seed, as a live pack's does.
  poll: undefined as null | undefined,
  trackPixel: vi.fn(),
  push: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.push }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) =>
    createElement('a', { href }, children),
}));
vi.mock('next/image', () => ({
  default: ({ alt }: { alt: string }) => createElement('img', { alt }),
}));
vi.mock('@/components/auth/AuthProvider', () => ({
  useAuth: () => ({ customer: mocks.customer }),
}));
vi.mock('@/components/app-shell/TopUpProvider', () => ({
  useTopUp: () => ({ balance: 500, openTopUp: vi.fn() }),
}));
vi.mock('@/components/AuthButton', () => ({ openAuth: vi.fn() }));
vi.mock('@/lib/actions/pack-gifts', () => ({ getPackGifts: async () => null }));
vi.mock('@/components/Reveal', () => ({
  default: ({ children }: { children: React.ReactNode }) =>
    createElement('div', null, children),
}));
vi.mock('@/lib/use-pack-detail-poll', () => ({
  usePackDetailPoll: (_id: string, seed: unknown) =>
    mocks.poll === undefined ? seed : mocks.poll,
}));
vi.mock('@/lib/use-recent-pulls', () => ({
  useLiveRecentPulls: (seed: unknown) => seed,
}));
vi.mock('@/lib/pixel', () => ({ trackPixel: mocks.trackPixel }));
vi.mock('@/components/AmbientVideo', () => ({
  AmbientVideo: () => createElement('div'),
}));
vi.mock('@/components/SlabImage', () => ({
  SlabImage: () => createElement('div'),
}));
vi.mock('@/components/cards/CardTile', () => ({
  CardTile: () => createElement('div'),
}));
vi.mock('@/components/cards/CardDetailOverlay', () => ({
  CardDetailOverlay: () => createElement('div'),
}));
vi.mock('../PoolByRarity', () => ({
  PoolByRarity: () => createElement('div', null, 'Top Hits'),
}));

const PackDetailClient = (await import('../PackDetailClient')).default;

const BASE: ResolvedPack = {
  id: 'gold-capsule',
  name: 'Gold Capsule',
  priceMyr: 10,
  image: '/images/polycards/lucky-pack.webp',
  categoryId: 'poly',
  categoryName: 'Poly',
  icon: '/pack-index-icons/poly.webp',
};

const TICKET_DETAIL: PackDetail = {
  topHits: [],
  pool: [ticketCard(10, 'Common'), ticketCard(1000, 'Immortal')],
  publishedOdds: { tiers: { Immortal: 0.1, Common: 99.9 } },
  demoOdds: null,
};

const CARD_DETAIL: PackDetail = {
  topHits: [],
  pool: [
    {
      handle: 'charizard',
      name: 'Charizard',
      image: '/c.webp',
      slabImage: null,
      rarity: 'Immortal',
      priceMyr: 400,
      pokemonDex: 6,
      spriteImage: null,
    },
  ],
  publishedOdds: { tiers: { Immortal: 100 } },
  demoOdds: null,
};

let container: HTMLDivElement;
let root: Root;

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  mocks.customer = { id: 'cus_1' };
  mocks.poll = undefined;
  mocks.trackPixel.mockClear();
  mocks.push.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(pack: ResolvedPack, detail: PackDetail): Promise<string> {
  await act(async () => {
    root.render(
      createElement(PackDetailClient, {
        pack,
        siblings: [],
        detail,
        recentPulls: { pulls: [], drought: {} },
      }),
    );
  });
  return container.textContent ?? '';
}

/** The first "pack" on the page with the words around it, so a failure names it. */
const packWord = (text: string) => /.{0,30}\bpacks?\b.{0,30}/i.exec(text)?.[0];

const CARD_ONLY = [
  'Expected value',
  'Card value range',
  'buyback',
  'during reveal',
];

describe('PackDetailClient — ticket pack', () => {
  test('the control: a card pack shows the card-only sections', async () => {
    const text = await render(BASE, CARD_DETAIL);
    for (const copy of [
      'Top Hits',
      'Expected value',
      'Recent Pulls',
      'All packs',
      'Open Pack',
      '1 Pack',
    ]) {
      expect(text).toContain(copy);
    }
    expect(text).toMatch(/buyback/);
    expect(text).toContain('during reveal');
  });

  test('hides every card-only section', async () => {
    const text = await render({ ...BASE, prizeType: 'tickets' }, TICKET_DETAIL);
    for (const copy of CARD_ONLY) {
      expect(text.toLowerCase()).not.toContain(copy.toLowerCase());
    }
  });

  test('keeps the published odds panel and the open', async () => {
    const text = await render({ ...BASE, prizeType: 'tickets' }, TICKET_DETAIL);
    expect(text).toContain('Pull Odds');
    expect(text).toContain('Immortal');
    expect(text).toContain('0.1%');
    expect(text).toContain('Open Capsule');
  });

  test('calls itself a capsule, everywhere on the page', async () => {
    mocks.customer = null; // a guest sees the longer "costs the capsule price" line
    const pack: ResolvedPack = { ...BASE, prizeType: 'tickets' };
    await act(async () => {
      root.render(
        createElement(PackDetailClient, {
          pack,
          siblings: [
            pack,
            { ...pack, id: 'diamond-capsule', name: 'Diamond Capsule' },
          ],
          detail: TICKET_DETAIL,
          recentPulls: { pulls: [], drought: {} },
        }),
      );
    });
    const text = container.textContent ?? '';
    for (const copy of [
      'All capsules',
      'More Capsules',
      '2 capsules',
      '1 Capsule',
      'the capsule price',
      'one capsule per open',
    ]) {
      expect(text).toContain(copy);
    }
    expect(packWord(text)).toBeUndefined();
  });

  test('shows its own pull history, a win as its ticket amount', async () => {
    await act(async () => {
      root.render(
        createElement(PackDetailClient, {
          pack: { ...BASE, prizeType: 'tickets' },
          siblings: [],
          detail: TICKET_DETAIL,
          recentPulls: {
            pulls: [
              {
                ...ticketCard(300, 'Immortal'),
                id: 'tksp_1',
                packName: 'Gold Capsule',
                packIcon: '/i.webp',
                who: 'Ann',
                profileHandle: null,
                avatar: null,
                frame: null,
                rolledAt: '2026-11-02T00:00:00Z',
                agoLabel: 'just now',
              },
            ],
            drought: { Immortal: 6 },
          },
        }),
      );
    });
    const text = container.textContent ?? '';
    expect(text).toContain('Recent Pulls');
    expect(text).toContain('capsules without');
    expect(text).toContain('Ann');
    expect(text).toContain('300tickets');
    expect(packWord(text)).toBeUndefined();
    // An amount has no card page and no overlay: the row is not a control.
    expect(container.querySelector('a[href^="/card/"]')).toBeNull();
    expect(container.querySelector('button[aria-label*="Ann"]')).toBeNull();
  });

  test('an empty history invites a capsule open', async () => {
    const text = await render({ ...BASE, prizeType: 'tickets' }, TICKET_DETAIL);
    expect(text).toContain('be the first to open a capsule');
  });

  // Its ledger isn't public, and the proxy answers an unlisted slug with the
  // global feed: card pulls under a pack that never paid them.
  test('a Draft shows no pull history', async () => {
    const capsule = await render(
      { ...BASE, prizeType: 'tickets', draft: true },
      TICKET_DETAIL,
    );
    expect(capsule).not.toContain('Recent Pulls');
    const cards = await render({ ...BASE, draft: true }, CARD_DETAIL);
    expect(cards).not.toContain('Recent Pulls');
  });

  test('a sold out capsule says so in the same word', async () => {
    const text = await render(
      { ...BASE, prizeType: 'tickets', inStock: false },
      TICKET_DETAIL,
    );
    expect(text).toContain('This capsule is sold out');
    expect(packWord(text)).toBeUndefined();
  });

  test('shows Top Hits', async () => {
    const text = await render({ ...BASE, prizeType: 'tickets' }, TICKET_DETAIL);
    expect(text).toContain('Top Hits');
  });

  test('the odds panel states the tickets each tier pays', async () => {
    const text = await render({ ...BASE, prizeType: 'tickets' }, TICKET_DETAIL);
    expect(text).toContain('10 tickets');
    expect(text).toContain('1,000 tickets');
  });

  test('a tier with several amounts reads as a range', async () => {
    const text = await render(
      { ...BASE, prizeType: 'tickets' },
      {
        ...TICKET_DETAIL,
        pool: [ticketCard(10, 'Common'), ticketCard(50, 'Common')],
        publishedOdds: { tiers: { Common: 100 } },
      },
    );
    expect(text).toContain('10 – 50 tickets');
  });

  // 1000 x 0.001 + 10 x 0.999 = 10.99, shown to one decimal.
  test('the odds panel states the average from the published odds', async () => {
    const text = await render({ ...BASE, prizeType: 'tickets' }, TICKET_DETAIL);
    expect(text).toContain('Average per pull');
    expect(text).toContain('11 tickets');
  });

  test('published odds that do not add up show no average', async () => {
    const text = await render(
      { ...BASE, prizeType: 'tickets' },
      { ...TICKET_DETAIL, publishedOdds: { tiers: { Common: 50 } } },
    );
    expect(text).not.toContain('Average per pull');
    expect(text).toContain('Tickets per pull');
  });

  // The mobile dock's second line must not go empty, or the pill drifts.
  test('the dock states what the pack pays', async () => {
    const text = await render({ ...BASE, prizeType: 'tickets' }, TICKET_DETAIL);
    expect(text).toContain('Lucky Draw tickets');
  });

  test('a guest still gets the demo spin', async () => {
    mocks.customer = null;
    const text = await render({ ...BASE, prizeType: 'tickets' }, TICKET_DETAIL);
    expect(text).toContain('Try a free demo spin');
  });
});

describe('PackDetailClient — category dropdown', () => {
  const tab = (id: string, tabName: string, firstPackId?: string) => ({
    id,
    tab: tabName,
    icon: `/${id}.webp`,
    soon: !firstPackId,
    firstPackId,
  });
  const TABS = [
    tab('pokemon', 'Pokémon', '151'),
    tab('one-piece', 'One Piece'),
    tab('poly', 'Poly', 'gold-capsule'),
  ];

  async function renderTabs(categoryTabs: typeof TABS) {
    await act(async () => {
      root.render(
        createElement(PackDetailClient, {
          pack: { ...BASE, prizeType: 'tickets' },
          siblings: [],
          categoryTabs,
          detail: TICKET_DETAIL,
          recentPulls: { pulls: [], drought: {} },
        }),
      );
    });
  }
  const dropdown = () =>
    container.querySelector<HTMLSelectElement>('select[aria-label="Category"]');

  test("picking another franchise opens its first pack, keeping the page's scroll", async () => {
    await renderTabs(TABS);
    await act(async () => {
      const select = dropdown()!;
      select.value = 'pokemon';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(mocks.push).toHaveBeenCalledWith('/slots/151?count=1', {
      scroll: false,
    });
  });

  test('it opens on the franchise on screen', async () => {
    await renderTabs(TABS);
    expect(dropdown()!.value).toBe('poly');
    expect(mocks.push).not.toHaveBeenCalled();
  });

  test('a franchise with nothing on sale is listed but cannot be picked', async () => {
    await renderTabs(TABS);
    const onePiece = dropdown()!.querySelector<HTMLOptionElement>(
      'option[value="one-piece"]',
    )!;
    expect(onePiece.disabled).toBe(true);
    expect(onePiece.textContent).toBe('One Piece (Coming soon)');
  });

  test('nothing to switch to: the category stays a plain label', async () => {
    await renderTabs([]);
    expect(dropdown()).toBeNull();
    expect(container.textContent).toContain('Poly');
  });
});

describe('PackDetailClient — a Draft, for a staff member', () => {
  const capsule: ResolvedPack = { ...BASE, prizeType: 'tickets', draft: true };
  const cards: ResolvedPack = { ...BASE, name: 'Draft Cards', draft: true };

  test('a Draft capsule says so and can still be opened', async () => {
    const text = await render(capsule, TICKET_DETAIL);
    expect(text).toContain('Draft');
    expect(text).toContain('Open Capsule');
    expect(text).not.toContain('Preview only');
  });

  test('a Draft card pack can be looked at but not opened', async () => {
    const text = await render(cards, CARD_DETAIL);
    expect(text).toContain('Draft');
    expect(text).toContain('Preview only');
    expect(text).toContain('can be viewed but not opened');
    expect(text).not.toContain('Open Pack');
    expect(text).not.toContain('Sold out');
  });

  // The poll reads the public route, which answers null for a draft, and that
  // must not blank the page a minute after it loads.
  test('keeps its details when the public poll finds nothing', async () => {
    mocks.poll = null;
    const text = await render(capsule, TICKET_DETAIL);
    expect(text).toContain('Pull Odds');
    expect(text).toContain('Top Hits');
  });

  test('a live pack still takes the poll', async () => {
    mocks.poll = null;
    const text = await render({ ...BASE, prizeType: 'tickets' }, TICKET_DETAIL);
    expect(text).not.toContain('Pull Odds');
  });

  // A pack nobody can buy yet has no business in the ads funnel.
  test('is not reported to the ads pixel', async () => {
    await render(capsule, TICKET_DETAIL);
    expect(mocks.trackPixel).not.toHaveBeenCalled();
    await render({ ...BASE, prizeType: 'tickets' }, TICKET_DETAIL);
    expect(mocks.trackPixel).toHaveBeenCalledTimes(1);
  });

  test('no Draft label on a live pack', async () => {
    const text = await render({ ...BASE, prizeType: 'tickets' }, TICKET_DETAIL);
    expect(text).not.toContain('Draft');
  });
});
