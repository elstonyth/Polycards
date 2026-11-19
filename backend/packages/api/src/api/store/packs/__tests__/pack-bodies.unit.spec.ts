import { catalogRows, packDetailBody } from '../pack-bodies';

// The pack tags (classic / original / special, and an original pack's language)
// are what the storefront sorts and labels its pack picker by, so both public
// bodies must carry them, and an untagged pack must read as null.

const row = (over: Record<string, unknown> = {}) =>
  ({
    slug: 'romance-dawn-jp',
    title: 'Romance Dawn',
    category: 'one-piece',
    prize_type: 'cards',
    price: 30,
    image: '/romance-dawn.png',
    display_image: null,
    boost: false,
    buyback_percent: 90,
    in_stock: true,
    rank: 0,
    status: 'active',
    pack_type: 'original',
    language: 'jp',
    published_odds: null,
    ...over,
  }) as never;

const service = {
  packPoolComposition: async () => new Map(),
  listTicketPrizes: async () => [],
} as never;

describe('catalogRows', () => {
  it('sends a pack’s type and language', async () => {
    const [sent] = await catalogRows(service, [row()]);
    expect(sent.pack_type).toBe('original');
    expect(sent.language).toBe('jp');
  });

  it('sends null for an untagged pack', async () => {
    const [sent] = await catalogRows(service, [
      row({ pack_type: null, language: null }),
    ]);
    expect(sent.pack_type).toBeNull();
    expect(sent.language).toBeNull();
  });

  it('sends null when the row has no tag columns at all', async () => {
    const [sent] = await catalogRows(service, [
      row({ pack_type: undefined, language: undefined }),
    ]);
    expect(sent.pack_type).toBeNull();
    expect(sent.language).toBeNull();
  });
});

describe('packDetailBody', () => {
  it('sends the tags on the pack of an unlisted page too', async () => {
    const body = await packDetailBody(
      service,
      row({ prize_type: 'tickets', pack_type: 'classic', language: null }),
    );
    expect(body.pack.pack_type).toBe('classic');
    expect(body.pack.language).toBeNull();
  });
});
