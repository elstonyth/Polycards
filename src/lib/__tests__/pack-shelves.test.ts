import { describe, expect, it } from 'vitest';
import {
  packFacts,
  shelfPacks,
  shelvePacks,
  type Pack,
  type ResolvedPack,
} from '@/lib/packs-data';

const pack = (
  id: string,
  priceMyr: number,
  over: Partial<Pack> = {},
): Pack => ({
  id,
  name: id,
  priceMyr,
  image: `/${id}.png`,
  ...over,
});

/** The first shelf; a test that expects one must not pass on none. */
const only = <T>(list: T[]): T => {
  const first = list[0];
  if (first === undefined) throw new Error('expected a shelf');
  return first;
};

describe('shelvePacks', () => {
  it('shelves by pack type in Classic, Original, Special order', () => {
    const shelves = shelvePacks([
      pack('poncho', 22000, { packType: 'special' }),
      pack('151', 40, { packType: 'original', language: 'en' }),
      pack('bronze', 300, { packType: 'classic' }),
    ]);
    expect(shelves.map((s) => s.type)).toEqual([
      'classic',
      'original',
      'special',
    ]);
  });

  it('sorts each shelf cheapest first, keeping rank order on a tie', () => {
    const shelf = only(
      shelvePacks([
        pack('cr', 15, { packType: 'original', language: 'en' }),
        pack('151', 40, { packType: 'original', language: 'en' }),
        pack('delta', 18, { packType: 'original', language: 'en' }),
        pack('twin', 15, { packType: 'original', language: 'en' }),
      ]),
    );
    expect(shelf.packs.map((p) => p.id)).toEqual([
      'cr',
      'twin',
      'delta',
      '151',
    ]);
  });

  it('puts untagged packs on a last shelf of their own, so none is lost', () => {
    const shelves = shelvePacks([
      pack('mystery', 5),
      pack('bronze', 300, { packType: 'classic' }),
    ]);
    expect(shelves.map((s) => s.type)).toEqual(['classic', null]);
    expect(shelves.flatMap((s) => s.packs)).toHaveLength(2);
  });

  it('is one untagged shelf on a backend that sends no tags', () => {
    const shelves = shelvePacks([pack('gold', 1200), pack('bronze', 300)]);
    expect(shelves).toHaveLength(1);
    expect(shelves[0]?.type).toBeNull();
    expect(shelves[0]?.packs.map((p) => p.id)).toEqual(['bronze', 'gold']);
  });

  it('lists a shelf’s languages English first, only the ones it holds', () => {
    const shelf = only(
      shelvePacks([
        pack('op-jp', 30, { packType: 'original', language: 'jp' }),
        pack('op-en', 35, { packType: 'original', language: 'en' }),
      ]),
    );
    expect(shelf.languages).toEqual(['en', 'jp']);
    const classic = only(
      shelvePacks([pack('bronze', 300, { packType: 'classic' })]),
    );
    expect(classic.languages).toEqual([]);
  });
});

describe('shelfPacks', () => {
  const shelf = only(
    shelvePacks([
      pack('op-jp', 30, { packType: 'original', language: 'jp' }),
      pack('op-en', 35, { packType: 'original', language: 'en' }),
      pack('op-any', 20, { packType: 'original' }),
    ]),
  );

  it('narrows to one language, keeping packs that carry none', () => {
    expect(shelfPacks(shelf, 'jp').map((p) => p.id)).toEqual([
      'op-any',
      'op-jp',
    ]);
  });

  it('shows the whole shelf when no language is picked', () => {
    expect(shelfPacks(shelf, null)).toHaveLength(3);
  });
});

describe('packFacts', () => {
  const resolved = (over: Partial<Pack>): ResolvedPack => ({
    ...pack('x', 10, over),
    categoryId: 'pokemon',
    categoryName: 'Pokémon',
    icon: '/pokemon.webp',
  });

  it('states category, type, language and grading for a tagged pack', () => {
    expect(
      packFacts(
        resolved({ packType: 'original', language: 'jp', group: 'RAW' }),
      ),
    ).toEqual([
      { label: 'Category', value: 'Pokémon' },
      { label: 'Type', value: 'Original' },
      { label: 'Language', value: 'Japanese' },
      { label: 'Cards', value: 'Raw Cards' },
    ]);
  });

  it('says Graded only under the PSA 10 guarantee', () => {
    const graded = packFacts(resolved({ group: 'GRADED', psa10: true }));
    expect(graded).toContainEqual({ label: 'Cards', value: 'Graded' });
    // A PSA 9 pool is graded but not guaranteed, and it isn't raw either.
    const mixed = packFacts(resolved({ group: 'GRADED', psa10: false }));
    expect(mixed.map((f) => f.label)).not.toContain('Cards');
  });

  it('leaves out what an untagged pack does not say', () => {
    expect(packFacts(resolved({})).map((f) => f.label)).toEqual(['Category']);
  });

  it('never calls a ticket capsule graded or raw', () => {
    const facts = packFacts(resolved({ prizeType: 'tickets', group: 'RAW' }));
    expect(facts.map((f) => f.label)).toEqual(['Category']);
  });
});
