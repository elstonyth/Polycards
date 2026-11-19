import { describe, expect, it } from 'vitest';
import type { Pack } from '@/lib/packs-data';
import type { StageCategory } from '../contract';
import {
  ALL_FILTER,
  filterLabel,
  languagesOf,
  rowPacks,
  rowStart,
  stageChips,
} from '../stage-filter';
import { withLanguage, withShelf } from '../StageSortPanel';
import {
  languageCuts,
  orderStagePacks,
  shelfCaption,
  toStageCategories,
  toStageShelves,
} from '../stage-packs';

const pack = (over: Partial<Pack> & Pick<Pack, 'id'>): Pack => ({
  name: over.id,
  priceMyr: 10,
  image: `/images/polycards/${over.id}.webp`,
  ...over,
});

/** The live Pokémon line-up as checked on 2026-11-19. */
const graded = { group: 'GRADED' as const, psa10: true };
const raw = { group: 'RAW' as const };
const LIVE: Pack[] = [
  pack({ id: 'bronze-pack', priceMyr: 300, packType: 'classic', ...graded }),
  pack({ id: 'silver-pack', priceMyr: 600, packType: 'classic', ...graded }),
  pack({ id: 'gold-pack', priceMyr: 1200, packType: 'classic', ...graded }),
  pack({ id: 'platinum-pack', priceMyr: 2500, packType: 'classic', ...graded }),
  pack({ id: 'diamond-pack', priceMyr: 5000, packType: 'classic', ...graded }),
  pack({
    id: 'cr',
    priceMyr: 15,
    packType: 'original',
    language: 'en',
    ...raw,
  }),
  pack({
    id: 'delta-reign',
    priceMyr: 18,
    packType: 'original',
    language: 'en',
    ...raw,
  }),
  pack({
    id: '151',
    priceMyr: 40,
    packType: 'original',
    language: 'en',
    ...raw,
  }),
  pack({
    id: '30th-celebration',
    priceMyr: 45,
    packType: 'original',
    language: 'en',
    ...raw,
  }),
  pack({
    id: 'ah',
    priceMyr: 50,
    packType: 'original',
    language: 'en',
    ...raw,
  }),
  pack({ id: 'poncho-pack', priceMyr: 22000, packType: 'special', ...graded }),
];

const stage = (packs: Pack[]): StageCategory => {
  const [c] = toStageCategories(
    [{ id: 'pokemon', tab: 'Pokémon', heading: '', icon: '', packs }],
    new Map(),
    () => null,
  );
  if (!c) throw new Error('no category');
  return c;
};

const ids = (c: StageCategory, f = ALL_FILTER) =>
  rowPacks(c, f).map((p) => p.id);

describe('toStageShelves: the chips projection', () => {
  it('gives today\'s Pokémon "All", Classic, Original, Special with their truth captions', () => {
    const shelves = toStageShelves(orderStagePacks(LIVE));
    expect(shelves.map((s) => [s.key, s.label, s.caption, s.count])).toEqual([
      ['all', 'All', null, 11],
      ['classic', 'Classic', 'Graded', 5],
      ['original', 'Original', 'Raw Cards', 5],
      ['special', 'Special', 'Graded', 1],
    ]);
    // Every list keeps the stage's price order.
    expect(shelves[0]?.ids.slice(0, 3)).toEqual(['cr', 'delta-reign', '151']);
    expect(shelves[1]?.ids).toEqual([
      'bronze-pack',
      'silver-pack',
      'gold-pack',
      'platinum-pack',
      'diamond-pack',
    ]);
    // One language everywhere: no language control anywhere.
    expect(shelves.every((s) => s.languages.length === 0)).toBe(true);
  });

  it('has no type chips for a single shelf (Poly capsules, or no tags at all)', () => {
    const caps = [
      pack({ id: 'a', prizeType: 'tickets' }),
      pack({ id: 'b', prizeType: 'tickets' }),
    ];
    expect(toStageShelves(caps).map((s) => s.key)).toEqual(['all']);
    expect(stageChips(stage(caps))).toEqual([]);
  });

  it('puts untagged packs last, under "Other", when a category mixes them in', () => {
    const shelves = toStageShelves([
      pack({ id: 'u', priceMyr: 1 }),
      pack({ id: 'c', priceMyr: 5, packType: 'classic', ...graded }),
    ]);
    expect(shelves.map((s) => [s.key, s.label])).toEqual([
      ['all', 'All'],
      ['classic', 'Classic'],
      ['other', 'Other'],
    ]);
  });
});

describe('shelfCaption: a truth claim about every pack on the shelf', () => {
  it('says Graded only when every pack passes the PSA 10 gate', () => {
    expect(
      shelfCaption([
        pack({ id: 'a', ...graded }),
        pack({ id: 'b', ...graded }),
      ]),
    ).toBe('Graded');
    // All graded but one is not all PSA 10: that pack is 'more', so no caption.
    expect(
      shelfCaption([
        pack({ id: 'a', ...graded }),
        pack({ id: 'b', group: 'GRADED', psa10: false }),
      ]),
    ).toBeNull();
  });

  it('says Raw Cards only when every pack is raw', () => {
    expect(shelfCaption([pack({ id: 'a', ...raw })])).toBe('Raw Cards');
  });

  it('says nothing for a mixed shelf (graded beside raw)', () => {
    expect(
      shelfCaption([pack({ id: 'a', ...graded }), pack({ id: 'b', ...raw })]),
    ).toBeNull();
  });

  it('says nothing for a "more" shelf (MIX, or no composition from the backend)', () => {
    expect(shelfCaption([pack({ id: 'a', group: 'MIX' })])).toBeNull();
    expect(
      shelfCaption([pack({ id: 'a' }), pack({ id: 'b', group: null })]),
    ).toBeNull();
  });

  it('says nothing for capsules or an empty shelf', () => {
    expect(
      shelfCaption([pack({ id: 'a', prizeType: 'tickets', ...raw })]),
    ).toBeNull();
    expect(shelfCaption([])).toBeNull();
  });
});

describe('rowPacks and the start rule', () => {
  const c = stage(LIVE);

  it('"All" is the approved row itself: every pack, price order, opening on 151', () => {
    expect(rowPacks(c, ALL_FILTER)).toBe(c.packs);
    expect(ids(c)[rowStart(c.packs, null)]).toBe('151');
  });

  it('narrows to a shelf in the stage order', () => {
    expect(ids(c, { shelf: 'original', language: null })).toEqual([
      'cr',
      'delta-reign',
      '151',
      '30th-celebration',
      'ah',
    ]);
  });

  it('opens centred on the pack that was centred when the new row holds it', () => {
    const original = rowPacks(c, { shelf: 'original', language: null });
    expect(original[rowStart(original, '151')]?.id).toBe('151');
    const all = rowPacks(c, ALL_FILTER);
    expect(all[rowStart(all, 'gold-pack')]?.id).toBe('gold-pack');
  });

  it('otherwise opens by the first-load rule: third pack, clamped, nearest in stock', () => {
    const classic = rowPacks(c, { shelf: 'classic', language: null });
    expect(classic[rowStart(classic, '151')]?.id).toBe('gold-pack');
    const sold = stage(
      LIVE.map((p) => (p.id === 'gold-pack' ? { ...p, inStock: false } : p)),
    );
    const soldClassic = rowPacks(sold, { shelf: 'classic', language: null });
    expect(soldClassic[rowStart(soldClassic, '151')]?.id).toBe('silver-pack');
  });

  it('a one-pack row (Special) opens on its only pack', () => {
    const special = rowPacks(c, { shelf: 'special', language: null });
    expect(special.map((p) => p.id)).toEqual(['poncho-pack']);
    expect(rowStart(special, '151')).toBe(0);
    expect(rowStart(special, 'poncho-pack')).toBe(0);
  });

  it('an unknown chip falls back to every pack', () => {
    expect(ids(c, { shelf: 'nope', language: null })).toHaveLength(11);
  });
});

describe('filterLabel: what the collapsed trigger says', () => {
  const c = stage(LIVE);
  it('"All packs" by default, the type with its caption once chosen', () => {
    expect(filterLabel(c, ALL_FILTER)).toBe('All packs');
    expect(filterLabel(c, { shelf: 'classic', language: null })).toBe(
      'Classic · Graded',
    );
    expect(filterLabel(c, { shelf: 'original', language: null })).toBe(
      'Original · Raw Cards',
    );
  });

  it('adds the language when one is set, and no caption where none is true', () => {
    const jp = stage(
      LIVE.map((p) => (p.id === 'ah' ? { ...p, language: 'jp' as const } : p)),
    );
    expect(filterLabel(jp, { shelf: 'original', language: 'jp' })).toBe(
      'Original · Raw Cards · Japanese',
    );
    expect(filterLabel(jp, { shelf: 'all', language: 'en' })).toBe(
      'All packs · English',
    );
    const mixed = stage([
      pack({ id: 'a', priceMyr: 1, packType: 'classic', ...graded }),
      pack({ id: 'b', priceMyr: 2, packType: 'classic', ...raw }),
      pack({ id: 'c', priceMyr: 3, packType: 'special', ...graded }),
    ]);
    expect(filterLabel(mixed, { shelf: 'classic', language: null })).toBe(
      'Classic',
    );
  });
});

describe('languages', () => {
  /** Two originals marked Japanese, as the preview's ?jp=delta-reign,ah. */
  const JP = LIVE.map((p) =>
    p.id === 'delta-reign' || p.id === 'ah'
      ? { ...p, language: 'jp' as const }
      : p,
  );
  const c = stage(JP);

  it('has no control with one language (today) or none', () => {
    const live = stage(LIVE);
    expect(languagesOf(live, ALL_FILTER)).toEqual([]);
    expect(languagesOf(live, { shelf: 'original', language: null })).toEqual(
      [],
    );
    expect(languageCuts([pack({ id: 'a' }), pack({ id: 'b' })])).toEqual([]);
  });

  it('offers English then Japanese once a selection carries both', () => {
    expect(
      languagesOf(c, ALL_FILTER).map((l) => [l.key, l.label, l.short]),
    ).toEqual([
      ['en', 'English', 'EN'],
      ['jp', 'Japanese', 'JP'],
    ]);
    expect(languagesOf(c, { shelf: 'original', language: null })).toHaveLength(
      2,
    );
    // Classic carries no language: no control there.
    expect(languagesOf(c, { shelf: 'classic', language: null })).toEqual([]);
  });

  it('narrowing keeps the packs with no language, in the stage order', () => {
    expect(ids(c, { shelf: 'all', language: 'jp' })).toEqual([
      'delta-reign',
      'ah',
      'bronze-pack',
      'silver-pack',
      'gold-pack',
      'platinum-pack',
      'diamond-pack',
      'poncho-pack',
    ]);
    expect(ids(c, { shelf: 'original', language: 'jp' })).toEqual([
      'delta-reign',
      'ah',
    ]);
    expect(ids(c, { shelf: 'original', language: 'en' })).toEqual([
      'cr',
      '151',
      '30th-celebration',
    ]);
  });

  it('pressing a language narrows; pressing it again clears it; no "All" for languages', () => {
    const on = withLanguage(c, ALL_FILTER, 'jp');
    expect(on).toEqual({ shelf: 'all', language: 'jp' });
    expect(withLanguage(c, on, 'jp')).toEqual(ALL_FILTER);
    expect(withLanguage(c, on, 'en')).toEqual({ shelf: 'all', language: 'en' });
    // A language the selection does not offer changes nothing.
    expect(withLanguage(c, { shelf: 'classic', language: null }, 'jp')).toEqual(
      {
        shelf: 'classic',
        language: null,
      },
    );
  });

  it('a type change keeps the language while the new selection still offers it, else drops it', () => {
    const jp = { shelf: 'all', language: 'jp' };
    expect(withShelf(c, jp, 'original')).toEqual({
      shelf: 'original',
      language: 'jp',
    });
    expect(withShelf(c, jp, 'classic')).toEqual({
      shelf: 'classic',
      language: null,
    });
    expect(withShelf(c, { shelf: 'classic', language: null }, 'all')).toEqual(
      ALL_FILTER,
    );
  });

  it('a language that narrows to one pack behaves like the one-pack row', () => {
    const one = stage(
      LIVE.map((p) => (p.id === 'ah' ? { ...p, language: 'jp' as const } : p)),
    );
    const row = rowPacks(one, { shelf: 'original', language: 'jp' });
    expect(row.map((p) => p.id)).toEqual(['ah']);
    expect(rowStart(row, '151')).toBe(0);
  });
});
