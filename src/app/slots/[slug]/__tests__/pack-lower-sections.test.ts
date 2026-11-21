// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, createElement, type AnchorHTMLAttributes } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PackCard } from '@/lib/packs-data';
import type { RecentFeed, RecentPull } from '@/lib/data/packs';

// The pack page's lower half was rebuilt (spotlight + ranked strip, odds board,
// pull ledger). These pin the one promise of that rebuild: every figure the old
// sections stated is still stated, and the hooks the QA scripts walk still hold.

vi.mock('next/image', () => ({
  default: ({ alt }: { alt: string }) => createElement('img', { alt }),
}));
vi.mock('next/link', () => ({
  default: ({
    children,
    prefetch: _prefetch,
    ...props
  }: AnchorHTMLAttributes<HTMLAnchorElement> & { prefetch?: boolean | null }) =>
    createElement('a', props, children),
}));
vi.mock('@/lib/use-liquid-glass', () => ({
  useLiquidGlass: vi.fn(),
  GLASS_SUBTLE: {},
}));
vi.mock('@/components/cards/PokemonBadge', () => ({
  PokemonBadge: () => null,
}));
vi.mock('@/components/PullGapsChart', () => ({
  PullGapsChart: () => createElement('p', null, 'the stats chart'),
}));
const feed = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('@/lib/use-recent-pulls', () => ({
  useLiveRecentPulls: () => feed.current,
}));

const { OddsBoard } = await import('../OddsBoard');
const { PoolByRarity } = await import('../PoolByRarity');
const { PullHistory } = await import('@/components/PullHistory');

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

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
const text = () => (host.textContent ?? '').replace(/\s+/g, ' ');

describe('OddsBoard', () => {
  const odds = [
    { rarity: 'Immortal', chance: '0.2%' },
    { rarity: 'Rare', chance: '22%' },
    { rarity: 'Common', chance: '77.8%' },
  ] as const;
  const board = (over: Record<string, unknown> = {}) =>
    act(() =>
      root.render(
        createElement(OddsBoard, {
          heading: createElement('h2', null, 'Pull Odds (by rarity)'),
          odds: [...odds],
          range: { min: 10, max: 5000 },
          expectedValue: 123.45,
          tierRanges: {
            Immortal: { min: 2000, max: 5000 },
            Rare: { min: 50, max: 80 },
          },
          ...over,
        }),
      ),
    );

  test('states the expected value, then every tier with its chance and range', () => {
    board();
    expect(text()).toContain('Expected value');
    expect(text()).toContain('RM 123.45');
    for (const o of odds) {
      expect(text()).toContain(o.rarity);
      expect(text()).toContain(o.chance);
    }
    expect(text()).toContain('RM 2,000.00 – RM 5,000.00');
    expect(text()).toContain('RM 50.00 – RM 80.00');
    expect(text()).toContain('Rates for this pack.');
  });

  test('the tiers are one list, in the order given', () => {
    board();
    // tests/e2e/odds-reflection.spec.ts reads the panel as its single <ul>.
    expect(host.querySelectorAll('ul')).toHaveLength(1);
    const cells = [...host.querySelectorAll('ul > li')];
    expect(cells.map((li) => li.textContent)).toEqual([
      'Immortal0.2%RM 2,000.00 – RM 5,000.00',
      'Rare22%RM 50.00 – RM 80.00',
      'Common77.8%',
    ]);
  });

  test('a range is read out with "to", not a silent dash', () => {
    board();
    expect(
      host.querySelector('[aria-label="Card value RM 50.00 to RM 80.00"]'),
    ).not.toBeNull();
  });

  test('the bars are pictures of printed numbers, hidden from a screen reader', () => {
    board();
    for (const bar of host.querySelectorAll('[style*="background"]')) {
      expect(bar.closest('[aria-hidden]')).not.toBeNull();
    }
  });

  test('with no expected value the headline is the value range', () => {
    board({ expectedValue: null });
    expect(text()).toContain('Card value range');
    expect(text()).toContain('RM 10.00 – RM 5,000.00');
    expect(text()).not.toContain('Expected value');
  });

  test('a capsule speaks in tickets', () => {
    board({
      tickets: true,
      expectedValue: 12.34,
      tierRanges: { Immortal: { min: 500, max: 1000 } },
    });
    expect(text()).toContain('Average per pull');
    expect(text()).toContain('12.3 tickets');
    expect(text()).toContain('500 – 1,000 tickets');
    expect(text()).toContain('Rates for this capsule.');
    expect(text()).not.toContain('RM');
  });

  test('no Pull Odds and nothing priced: no board at all', () => {
    board({ odds: [], range: null });
    expect(host.innerHTML).toBe('');
  });
});

describe('Top Hits', () => {
  const card = (
    n: number,
    rarity: PackCard['rarity'],
    priceMyr: number,
  ): PackCard => ({
    handle: `card-${n}`,
    name: `Card ${n}`,
    image: `/c${n}.png`,
    slabImage: `/s${n}.png`,
    rarity,
    priceMyr,
    pokemonDex: null,
    spriteImage: null,
  });
  const rail = [
    card(1, 'Immortal', 9000),
    card(2, 'Legendary', 800),
    card(3, 'Mythical', 70),
  ];
  const hits = (onOpen = vi.fn(), r = rail) => {
    act(() =>
      root.render(
        createElement(PoolByRarity, {
          rail: r,
          full: [...r, card(9, 'Common', 1)],
          tierChances: { Immortal: 0.2 },
          onOpen,
        }),
      ),
    );
    return onOpen;
  };
  const cards = () => [
    ...host.querySelectorAll<HTMLButtonElement>(
      'button[aria-label^="View details for"]',
    ),
  ];

  test('every top hit is on the page once, most valuable first', () => {
    hits();
    expect(cards().map((b) => b.getAttribute('aria-label'))).toEqual([
      'View details for Card 1, Immortal, RM 9,000.00 est.',
      'View details for Card 2, Legendary, RM 800.00 est.',
      'View details for Card 3, Mythical, RM 70.00 est.',
    ]);
    for (const price of ['RM 9,000.00', 'RM 800.00', 'RM 70.00']) {
      expect(text()).toContain(price);
    }
    // The full pool's Common card is not a top hit.
    expect(text()).not.toContain('Card 9');
  });

  test('one row holds every top hit, numbered from 01', () => {
    hits();
    const [first, second, third] = cards();
    // The place number is CSS-drawn from this attribute (see cardTileLabel).
    const place = (b?: Element) =>
      b?.querySelector('[data-rank]')?.getAttribute('data-rank');
    expect([place(first), place(second), place(third)]).toEqual([
      '01',
      '02',
      '03',
    ]);
    // One row, and it keeps the hook scripts/qa-pool-modal.mjs finds it by.
    const strips = host.querySelectorAll('div.cursor-grab');
    expect(strips).toHaveLength(1);
    for (const tile of cards()) expect(strips[0]!.contains(tile)).toBe(true);
  });

  test('a row that fits the screen shows no previous / next buttons', () => {
    hits();
    expect(host.querySelector('button[aria-label^="Next"]')).toBeNull();
    expect(host.querySelector('button[aria-label^="Previous"]')).toBeNull();
  });

  test('the heading is the name alone, beside a count and the blurb', () => {
    hits();
    expect(host.querySelector('h2')?.textContent).toBe('Top Hits');
    expect(text()).toContain('3 cards');
    expect(text()).toContain('The top-tier cards available in this pack.');
  });

  test('any card opens its details', () => {
    const onOpen = hits();
    act(() => cards()[0]!.click());
    act(() => cards()[2]!.click());
    expect(onOpen.mock.calls.map(([c]) => c.handle)).toEqual([
      'card-1',
      'card-3',
    ]);
  });

  test('"By rarity" opens the same cards grouped by tier', () => {
    hits();
    const expand = host.querySelector<HTMLButtonElement>(
      'button[aria-haspopup="dialog"]',
    );
    // The visible words are inside the label, so voice control can name it.
    expect(expand?.textContent).toBe('By rarity');
    expect(expand?.getAttribute('aria-label')).toBe(
      'Show the 3 top-tier cards grouped by rarity',
    );
    act(() => expand!.click());
    const dialog = document.querySelector(
      '[role="dialog"][aria-label="Top Hits"]',
    );
    expect(dialog?.textContent).toContain('0.2% pull chance');
    expect(
      dialog?.querySelectorAll('button[aria-label^="View details for"]'),
    ).toHaveLength(3);
  });

  test('one top hit: a row of one', () => {
    hits(vi.fn(), [rail[0]!]);
    expect(cards()).toHaveLength(1);
    expect(host.querySelector('div.cursor-grab')?.contains(cards()[0]!)).toBe(
      true,
    );
    expect(text()).toContain('1 card');
  });

  test('no top-tier cards: the header alone, naming the whole pool', () => {
    hits(vi.fn(), []);
    expect(host.querySelector('h2')?.textContent).toBe('All cards');
    expect(cards()).toHaveLength(0);
    expect(text()).toContain('Every card in this pack.');
  });
});

describe('Recent Pulls as a board', () => {
  const pull = (id: string, over: Partial<RecentPull> = {}): RecentPull => ({
    id,
    handle: `card-${id}`,
    name: `Card ${id}`,
    image: '/c.png',
    slabImage: null,
    profileHandle: null,
    priceMyr: 1234.5,
    rarity: 'Common',
    pokemonDex: null,
    spriteImage: null,
    packName: 'Diamond Pack',
    packIcon: '/p.webp',
    who: `Collector${id}`,
    avatar: null,
    frame: null,
    rolledAt: '2026-09-02T13:38:44.000Z',
    agoLabel: 'just now',
    ...over,
  });
  const seed: RecentFeed = {
    pulls: [pull('a', { rarity: 'Immortal', profileHandle: 'ann' }), pull('b')],
    drought: { Immortal: 541, Legendary: 10 },
  };
  const history = (onSelect = vi.fn(), pulls = seed.pulls) => {
    feed.current = {
      pulls,
      drought: seed.drought,
      pending: false,
      shownScope: 'all',
      shownCategory: undefined,
    };
    act(() =>
      root.render(
        createElement(PullHistory, {
          variant: 'board',
          heading: createElement('h2', null, 'Recent Pulls'),
          initial: seed,
          packSlug: 'diamond-pack',
          onSelect,
        }),
      ),
    );
    return onSelect;
  };
  const filter = () =>
    host.querySelector('[aria-label="Filter pulls by tier"]')!;

  test('the counters say how long each tier has been dry', () => {
    history();
    expect(text()).toContain('541');
    expect(text()).toContain('packs without Immortal');
    expect(text()).toContain('10');
    expect(text()).toContain('packs without Legendary');
  });

  test('a row states the card, its value and tier, who pulled it and when', () => {
    history();
    const row = host.querySelector('ol > li')!;
    for (const part of ['Card a', 'RM 1,234.50', 'Immortal', 'Collectora']) {
      expect(row.textContent).toContain(part);
    }
    expect(row.querySelector('time')?.getAttribute('dateTime')).toBe(
      '2026-09-02T13:38:44.000Z',
    );
    // Named by its own text, so what is read out is what is printed.
    const control = row.querySelector('button');
    expect(control?.hasAttribute('aria-label')).toBe(false);
    expect(control?.textContent).toContain('pulled by Collectora');
  });

  test('the puller links to their activity, outside the card control', () => {
    history();
    const link = host.querySelector('a[href="/profile/ann?tab=activity"]');
    expect(link).not.toBeNull();
    expect(link?.closest('button')).toBeNull();
    // No public profile: no link, and the face stays inside the control.
    expect(host.querySelectorAll('a[href^="/profile/"]')).toHaveLength(1);
  });

  test('tapping a row opens that pull', () => {
    const onSelect = history();
    act(() =>
      host.querySelectorAll<HTMLButtonElement>('ol > li button')[1]!.click(),
    );
    expect(onSelect.mock.calls[0]?.[0].id).toBe('b');
  });

  test('the filter keeps its five tabs, and the list stays its next sibling', () => {
    history();
    const tabs = [...filter().querySelectorAll('button')];
    expect(
      tabs.map((t) => t.getAttribute('aria-label') ?? t.textContent),
    ).toEqual(['All', 'Immortal', 'Legendary', 'Mythical', 'Stats']);
    expect(tabs[0]?.getAttribute('aria-pressed')).toBe('true');
    // scripts/qa-pull-history.mjs walks exactly these two relations.
    expect(filter().parentElement?.querySelectorAll('ol > li')).toHaveLength(2);
    expect(filter().nextElementSibling?.tagName).toBe('DIV');
    expect(filter().nextElementSibling?.querySelector('ol')).not.toBeNull();
  });

  test('Stats swaps the list for the chart, in the same place', () => {
    history();
    act(() =>
      filter()
        .querySelector<HTMLButtonElement>('button[aria-label="Stats"]')!
        .click(),
    );
    expect(filter().nextElementSibling?.textContent).toBe('the stats chart');
    expect(host.querySelector('ol')).toBeNull();
  });

  test('no pulls yet says so', () => {
    history(vi.fn(), []);
    expect(text()).toContain('No pulls yet — be the first to open a pack.');
  });

  test('an unseeded list says nothing until the first answer lands', () => {
    const render = (pending: boolean) => {
      feed.current = {
        pulls: [],
        drought: {},
        pending,
        shownScope: 'all',
        shownCategory: undefined,
      };
      act(() =>
        root.render(
          createElement(PullHistory, {
            variant: 'board',
            initial: { pulls: [], drought: {} },
            packSlug: 'diamond-pack',
            limit: 4,
            unseeded: true,
          }),
        ),
      );
    };
    render(true);
    expect(text()).not.toContain('No pulls yet');
    render(false);
    expect(text()).toContain('No pulls yet — be the first to open a pack.');
  });

  test('a ticket win prints its amount once and opens nothing', () => {
    history(vi.fn(), [pull('t', { tickets: 1000, priceMyr: null })]);
    const row = host.querySelector('ol > li')!;
    expect(row.textContent).toContain('1,000 tickets');
    expect(row.textContent?.match(/1,000/g)).toHaveLength(1);
    expect(row.querySelector('button')).toBeNull();
  });
});
