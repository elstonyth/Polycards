import { describe, expect, it } from 'vitest';
import { PacksPageSchema } from '@/lib/data/schemas';

// The pack tags are display-only: a value this storefront doesn't know (a type
// the admin gains later, deploy skew) must read as an untagged pack, never
// drop the pack from the catalog.
const row = (over: Record<string, unknown>) => ({
  slug: 'romance-dawn',
  title: 'Romance Dawn',
  category: 'one-piece',
  price: 30,
  image: '/romance-dawn.png',
  ...over,
});
const parse = (over: Record<string, unknown>) =>
  PacksPageSchema.parse({ packs: [row(over)] }).packs;

describe('PackRowSchema pack tags', () => {
  it('reads a pack type and language', () => {
    const [pack] = parse({ pack_type: 'original', language: 'jp' });
    expect(pack?.pack_type).toBe('original');
    expect(pack?.language).toBe('jp');
  });

  it('keeps the pack and reads an unknown tag as untagged', () => {
    const packs = parse({ pack_type: 'promo', language: 'kr' });
    expect(packs).toHaveLength(1);
    expect(packs[0]?.pack_type).toBeNull();
    expect(packs[0]?.language).toBeNull();
  });

  it('accepts null tags and a backend that sends none', () => {
    expect(parse({ pack_type: null, language: null })).toHaveLength(1);
    const [old] = parse({});
    expect(old?.pack_type).toBeUndefined();
    expect(old?.language).toBeUndefined();
  });
});
