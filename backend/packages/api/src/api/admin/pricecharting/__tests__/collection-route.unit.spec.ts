import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { GET } from '../collection/route';

// The request the route BUILDS is the pagination contract the admin scan loop
// depends on, and it is invisible to the http spec (which can only reach the
// no-token guard). Stub fetch and assert the outgoing URL directly.

const OFFER = {
  'offer-id': 'offer_1',
  id: 6910,
  'product-name': 'Pikachu ex #238',
  'console-name': 'Pokemon Surging Sparks',
  'include-string': 'PSA 10',
  value: 12500,
  'is-card': true,
  'image-url':
    'https://storage.googleapis.com/images.pricecharting.com/abc/240.jpg',
};

type Captured = { status: number; body: any };

const runGet = async (
  query: Record<string, unknown>,
  upstream: unknown,
): Promise<{ captured: Captured; url: URL }> => {
  let url!: URL;
  global.fetch = jest.fn(async (input: any) => {
    url = new URL(String(input));
    return {
      ok: true,
      status: 200,
      json: async () => upstream,
    } as Response;
  }) as unknown as typeof fetch;

  const captured: Captured = { status: 200, body: undefined };
  const res = {
    status(code: number) {
      captured.status = code;
      return this;
    },
    json(body: unknown) {
      captured.body = body;
      return this;
    },
  } as unknown as MedusaResponse;

  await GET({ query } as unknown as MedusaRequest, res);
  return { captured, url };
};

describe('GET /admin/pricecharting/collection', () => {
  const OLD_ENV = { ...process.env };

  beforeEach(() => {
    process.env.PRICECHARTING_API_TOKEN = 'test-token-0123456789';
    process.env.PRICECHARTING_SELLER_ID = 'seller_42';
  });

  afterEach(() => {
    process.env = { ...OLD_ENV };
    jest.restoreAllMocks();
  });

  it("scopes the query to the configured seller's collection", async () => {
    const { url } = await runGet({}, { status: 'success', offers: [OFFER] });

    expect(url.pathname).toBe('/api/offers');
    expect(url.searchParams.get('status')).toBe('collection');
    // The seller is what makes this OUR collection. The token only
    // authenticates: without a seller PriceCharting answers with every user's
    // offers, which would onboard strangers' cards as our stock.
    expect(url.searchParams.get('seller')).toBe('seller_42');
    expect(url.searchParams.has('cursor')).toBe(false);
    expect(url.searchParams.get('t')).toBe('test-token-0123456789');
  });

  it('refuses to call upstream at all when no seller is configured', async () => {
    delete process.env.PRICECHARTING_SELLER_ID;
    const { captured, url } = await runGet(
      {},
      { status: 'success', offers: [OFFER] },
    );

    expect(captured.status).toBe(503);
    expect(captured.body.message).toContain('PRICECHARTING_SELLER_ID');
    // Nothing was fetched — a seller-less call is not a degraded result, it is
    // the WRONG result (everybody's offers).
    expect(url).toBeUndefined();
  });

  it('forwards the cursor — page 2 of the scan depends on it', async () => {
    const { url } = await runGet(
      { cursor: 'cur/sor+abc' },
      { status: 'success', offers: [] },
    );
    expect(url.searchParams.get('cursor')).toBe('cur/sor+abc');
  });

  it('rejects a non-string cursor instead of restarting the scan', async () => {
    // Express turns a repeated ?cursor=a&cursor=b into an array; coercing it to
    // '' would silently answer page 1.
    const { captured, url } = await runGet(
      { cursor: ['a', 'b'] },
      { status: 'success', offers: [] },
    );
    expect(captured.status).toBe(400);
    expect(url).toBeUndefined();
  });

  it('rejects an absurdly long cursor instead of restarting the scan', async () => {
    // Answering page 1 would be invisible to the client: its dedupe drops every
    // row, so the scan spins to the page cap looking like a hang.
    const { captured, url } = await runGet(
      { cursor: 'x'.repeat(600) },
      { status: 'success', offers: [] },
    );
    expect(captured.status).toBe(400);
    expect(url).toBeUndefined();
  });

  it('trims a padded seller id', async () => {
    process.env.PRICECHARTING_SELLER_ID = ' seller_99 ';
    const { url } = await runGet({}, { status: 'success', offers: [] });
    expect(url.searchParams.get('seller')).toBe('seller_99');
  });

  it('returns normalized offers plus the next cursor', async () => {
    const { captured } = await runGet(
      {},
      { status: 'success', offers: [OFFER], cursor: 'next_page' },
    );

    expect(captured.body.cursor).toBe('next_page');
    expect(captured.body.offers).toHaveLength(1);
    expect(captured.body.offers[0]).toMatchObject({
      product_id: '6910',
      include: 'PSA 10',
      grade: 'PSA 10',
      value_usd: 125,
      is_card: true,
    });
  });

  it('drops rows upstream says are not ours, and says how many', async () => {
    // The seller id being SET proves configuration, not correctness — a stale
    // or typo'd id returns another account's holdings, which would import as
    // our stock. This is the flag that exposed exactly that bug.
    const { captured } = await runGet(
      {},
      {
        status: 'success',
        offers: [
          { ...OFFER, 'user-viewing-own-offers': false },
          { ...OFFER, 'offer-id': 'mine_1', 'user-viewing-own-offers': true },
          { ...OFFER, 'offer-id': 'mine_2' }, // flag absent — tolerated
        ],
      },
    );

    expect(captured.body.foreign_dropped).toBe(1);
    expect(
      captured.body.offers.map((o: { offer_id: string }) => o.offer_id),
    ).toEqual(['mine_1', 'mine_2']);
  });

  it('reports an exhausted collection as an empty cursor', async () => {
    const { captured } = await runGet({}, { status: 'success', offers: [] });
    expect(captured.body.cursor).toBe('');
  });

  it('drops junk rows instead of failing the page', async () => {
    const { captured } = await runGet(
      {},
      // null, a non-object, and a row with no product id all have to disappear
      // without taking the good row with them.
      { status: 'success', offers: [null, 'nope', { name: 'no id' }, OFFER] },
    );
    expect(captured.body.offers).toHaveLength(1);
    expect(captured.body.offers[0].product_id).toBe('6910');
  });

  it('503s with the setup message when no token is configured', async () => {
    delete process.env.PRICECHARTING_API_TOKEN;
    const { captured } = await runGet({}, { status: 'success', offers: [] });
    expect(captured.status).toBe(503);
    expect(captured.body.message).toContain('PRICECHARTING_API_TOKEN');
  });

  it('502s when PriceCharting reports an error', async () => {
    const { captured } = await runGet(
      {},
      {
        status: 'error',
        'error-message': 'user not found: me',
      },
    );
    expect(captured.status).toBe(502);
    expect(captured.body.message).toContain('user not found');
  });
});
