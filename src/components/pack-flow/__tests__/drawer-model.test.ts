import { describe, expect, it } from 'vitest';
import {
  liveCount,
  nextStack,
  refillStack,
  settleStack,
  stackCards,
  startStack,
  tabsBehind,
  DRAWER_GEOMETRY,
  DRAWER_TABS,
  drawerHeight,
  emptyLine,
  feedRarity,
  showsChart,
} from '../drawer-model';

const feed = (...ids: string[]) => ids.map((id) => ({ id }));
const twelve = feed('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l');
const front = (cards: ReturnType<typeof stackCards>) =>
  cards.find((c) => c.d === 0 && !c.leave)?.item.id;

describe('the drawer at rest', () => {
  it('shows the front card and 2 tabs on a phone, 3 on desktop', () => {
    expect(tabsBehind(false)).toBe(2);
    expect(tabsBehind(true)).toBe(3);
    const cards = stackCards(startStack('all', twelve), 2);
    expect(front(cards)).toBe('a');
    expect(cards.map((c) => c.d)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
    ]);
    expect(liveCount(cards, 2)).toBe(3);
    expect(liveCount(cards, 3)).toBe(4);
  });

  it('keeps every pull in feed order, none arriving or leaving', () => {
    const cards = stackCards(startStack('all', twelve), 2);
    expect(cards.map((c) => c.item.id).join('')).toBe('abcdefghijkl');
    expect(cards.some((c) => c.arrive || c.leave)).toBe(false);
  });

  it('shows what there is when the feed is short', () => {
    expect(liveCount(stackCards(startStack('all', feed('a')), 2), 2)).toBe(1);
    expect(stackCards(startStack('all', []), 2)).toEqual([]);
  });
});

describe('a new pull arriving', () => {
  const at = (ids: string[], behind = 2, prev = startStack('all', twelve)) =>
    nextStack(prev, 'all', feed(...ids), behind);

  it('becomes the front card; the old front steps back; the oldest tab leaves', () => {
    const s = at(['n', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k']);
    const cards = stackCards(s, 2);
    expect(front(cards)).toBe('n');
    expect(cards.find((c) => c.item.id === 'n')?.arrive).toBe(true);
    expect(cards.find((c) => c.item.id === 'a')?.d).toBe(1);
    expect(cards.find((c) => c.item.id === 'b')?.d).toBe(2);
    const leaving = cards.filter((c) => c.leave);
    expect(leaving.map((c) => [c.item.id, c.d])).toEqual([['c', 2]]);
    expect(liveCount(cards, 2)).toBe(4);
  });

  it('on desktop the fourth card is the one that leaves', () => {
    const s = at(['n', 'a', 'b', 'c', 'd'], 3);
    const cards = stackCards(s, 3);
    expect(cards.filter((c) => c.leave).map((c) => c.item.id)).toEqual(['d']);
    expect(liveCount(cards, 3)).toBe(5);
  });

  it('draws the leaving card even when the feed has dropped it', () => {
    const prev = startStack('all', feed('a', 'b', 'c'));
    const cards = stackCards(at(['n', 'a', 'b'], 2, prev), 2);
    expect(cards.map((c) => c.item.id)).toEqual(['n', 'a', 'b', 'c']);
    expect(cards[3]).toMatchObject({ d: 2, leave: true });
  });

  it('two or more at once refill the drawer, so no shown card vanishes unseen', () => {
    const prev = startStack('all', twelve);
    const s = at(['n', 'm', 'a', 'b', 'c', 'd']);
    const cards = stackCards(s, 2);
    expect(s.gen).toBe(prev.gen + 1);
    expect(front(cards)).toBe('n');
    expect(cards.filter((c) => c.arrive).map((c) => c.item.id)).toEqual([
      'n',
      'm',
      'a',
    ]);
    expect(cards.some((c) => c.leave)).toBe(false);
    expect(liveCount(cards, 2)).toBeLessThanOrEqual(4);
  });

  it('a single arrival never drops a shown card without its leave', () => {
    for (const behind of [2, 3]) {
      const prev = startStack('all', twelve);
      const shown = stackCards(prev, behind).filter((c) => c.d <= behind);
      const next = stackCards(
        at(['n', ...'abcdefghijk'.split('')], behind),
        behind,
      );
      for (const c of shown) {
        const now = next.find((x) => x.item.id === c.item.id);
        expect(now && (now.leave || now.d <= behind), c.item.id).toBe(true);
      }
    }
  });

  it('as many new pulls as the drawer shows is a refill, not a run of drops', () => {
    const prev = startStack('all', twelve);
    const s = at(['x', 'y', 'z', 'a', 'b'], 2, prev);
    const cards = stackCards(s, 2);
    expect(s.gen).toBe(prev.gen + 1);
    expect(cards.filter((c) => c.leave)).toEqual([]);
    expect(cards.filter((c) => c.arrive).map((c) => c.item.id)).toEqual([
      'x',
      'y',
      'z',
    ]);
  });

  it('a feed without the old front card is a refill', () => {
    const s = at(['p', 'q', 'r', 's']);
    expect(s.gen).toBe(1);
    expect(stackCards(s, 2).filter((c) => c.leave)).toEqual([]);
  });

  it('a second arrival while a card is still leaving stays within the cap', () => {
    const first = at(['n', 'a', 'b', 'c', 'd']);
    const second = nextStack(first, 'all', feed('o', 'n', 'a', 'b', 'c'), 2);
    expect(second.gen).toBe(first.gen);
    const cards = stackCards(second, 2);
    expect(front(cards)).toBe('o');
    expect(cards.filter((c) => c.leave).map((c) => c.item.id)).toEqual(['b']);
    expect(liveCount(cards, 2)).toBeLessThanOrEqual(4);
  });

  it('the leaving card is let go once it has left', () => {
    const s = settleStack(at(['n', 'a', 'b', 'c', 'd']));
    expect(stackCards(s, 2).some((c) => c.leave)).toBe(false);
    expect(liveCount(stackCards(s, 2), 2)).toBe(3);
  });

  it('the same pulls again change nothing', () => {
    const prev = startStack('all', twelve);
    const s = nextStack(prev, 'all', [...twelve], 2);
    expect(stackCards(s, 2)).toEqual(stackCards(prev, 2));
    expect(s.gen).toBe(prev.gen);
  });

  it('a changed tail behind the tabs moves no visible card', () => {
    const s = at(['a', 'b', 'c', 'd', 'z']);
    expect(stackCards(s, 2).some((c) => c.arrive || c.leave)).toBe(false);
  });

  it('nothing leaves in the plain list (no limit behind the front)', () => {
    const s = at(['n', 'a', 'b', 'c'], Infinity);
    expect(stackCards(s, Infinity).some((c) => c.leave)).toBe(false);
  });
});

describe('a new scope (a tier tab, or the Poly shelf)', () => {
  it('refills the drawer: its newest pull in front, the visible cards step in', () => {
    const prev = startStack('all', twelve);
    const s = nextStack(prev, 'immortal', feed('i1', 'i2', 'i3', 'i4'), 2);
    const cards = stackCards(s, 2);
    expect(s.gen).toBe(prev.gen + 1);
    expect(front(cards)).toBe('i1');
    expect(cards.filter((c) => c.arrive).map((c) => c.item.id)).toEqual([
      'i1',
      'i2',
      'i3',
    ]);
    expect(cards.some((c) => c.leave)).toBe(false);
  });

  it('refillStack steps the same pulls in again (back from Stats)', () => {
    const prev = startStack('all', twelve);
    const s = refillStack(prev, 3);
    expect(s.gen).toBe(prev.gen + 1);
    expect(stackCards(s, 3).filter((c) => c.arrive)).toHaveLength(4);
  });
});

describe('the tier tabs and Stats', () => {
  it('runs All, the three chase tiers, then Stats', () => {
    expect(DRAWER_TABS).toEqual([
      'All',
      'Immortal',
      'Legendary',
      'Mythical',
      'Stats',
    ]);
  });

  it('reads the whole feed on All and on Stats, one tier on a tier tab', () => {
    expect(feedRarity('All')).toBeNull();
    expect(feedRarity('Stats')).toBeNull();
    expect(feedRarity('Immortal')).toBe('Immortal');
    expect(feedRarity('Mythical')).toBe('Mythical');
  });

  it('shows the chart only on Stats', () => {
    expect(showsChart('Stats')).toBe(true);
    expect(showsChart('All')).toBe(false);
    expect(showsChart('Legendary')).toBe(false);
  });

  it("keeps today's empty lines word for word", () => {
    expect(emptyLine('All', 'pack')).toBe(
      'No pulls yet — be the first to open a pack.',
    );
    expect(emptyLine('All', 'capsule')).toBe(
      'No pulls yet — be the first to open a capsule.',
    );
    expect(emptyLine('Immortal', 'pack')).toBe(
      'No Immortal pulls yet — the next rip could be the one.',
    );
  });
});

describe('the drawer box', () => {
  it('is one card plus its tabs tall, whatever the feed holds', () => {
    expect(drawerHeight(DRAWER_GEOMETRY.phone)).toBe(212 + 2 * 38);
    expect(drawerHeight(DRAWER_GEOMETRY.desktop)).toBe(316 + 3 * 50);
    expect(DRAWER_GEOMETRY.phone.behind).toBe(tabsBehind(false));
    expect(DRAWER_GEOMETRY.desktop.behind).toBe(tabsBehind(true));
  });
});
