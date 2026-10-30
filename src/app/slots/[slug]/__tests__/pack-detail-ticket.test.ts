// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ticketCard, type ResolvedPack } from '@/lib/packs-data';
import type { PackDetail } from '@/lib/data/packs';

// A ticket pack has no card to show, value or sell, so the pack page drops
// everything that assumes one and keeps the published odds. The real odds panel
// renders here: its value rows must vanish on their own, because a ticket row
// has no price. The same page with a card pack is the control.

const mocks = vi.hoisted(() => ({
  customer: { id: 'cus_1' } as { id: string } | null,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
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
  usePackDetailPoll: (_id: string, seed: unknown) => seed,
}));
vi.mock('@/lib/use-recent-pulls', () => ({
  useLiveRecentPulls: (seed: unknown) => seed,
}));
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
  id: 'lucky-pack',
  name: 'Lucky Pack',
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

const CARD_ONLY = [
  'Top Hits',
  'Expected value',
  'Card value range',
  'Recent Pulls',
  'buyback',
  'during reveal',
];

describe('PackDetailClient — ticket pack', () => {
  test('the control: a card pack shows the card-only sections', async () => {
    const text = await render(BASE, CARD_DETAIL);
    for (const copy of ['Top Hits', 'Expected value', 'Recent Pulls']) {
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
    expect(text).toContain('Open Pack');
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
