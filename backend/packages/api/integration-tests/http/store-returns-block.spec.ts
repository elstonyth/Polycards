import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import { unwrapResponse } from './utils';

jest.setTimeout(180 * 1000);

// Core's POST /store/returns asks for no login, only the public publishable key,
// and runs an unbounded `items` array through zod: a cheap anonymous CPU drain,
// on a site that has already been flooded. Nothing here calls it, so
// blockUnusedSurface closes it (src/api/middlewares.ts).
//
// The malformed bodies are the point of these tests. They get a 400 from zod if
// the validator runs at all, so a 404 proves the block runs ahead of it. A
// method-pinned entry would sort beside core's validator and lose that race
// while still refusing the well-formed request.
medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('/store/returns is closed', () => {
      let anon: Record<string, string>;

      const wellFormed = {
        order_id: 'order_1',
        items: [{ id: 'item_1', quantity: 1 }],
        return_shipping: { option_id: 'so_1' },
      };
      // Just under the default 100 KB body limit, so the parser lets it through
      // to whatever runs next.
      const flood = {
        order_id: 'order_1',
        items: Array.from({ length: 3000 }, (_, i) => ({
          id: `item_${i}`,
          quantity: 1,
        })),
      };

      const send = (
        method: 'get' | 'post',
        path: string,
        headers: Record<string, string>,
        body?: unknown,
      ) =>
        unwrapResponse(
          method === 'post'
            ? api.post(path, body, { headers })
            : api.get(path, { headers }),
        );

      beforeEach(async () => {
        const key = await getContainer()
          .resolve(Modules.API_KEY)
          .createApiKeys({
            title: 'returns-block-test',
            type: 'publishable',
            created_by: 'returns-block-test',
          });
        anon = { 'x-publishable-api-key': key.token };
      });

      it('refuses every request before the validator runs', async () => {
        expect(JSON.stringify(flood).length).toBeLessThan(100 * 1024);
        expect(JSON.stringify(flood).length).toBeGreaterThan(90 * 1024);

        for (const [method, path, body] of [
          ['post', '/store/returns', {}],
          ['post', '/store/returns', { items: 'not-an-array' }],
          ['post', '/store/returns', flood],
          ['post', '/store/returns', wellFormed],
          ['post', '/STORE/RETURNS', {}],
          ['post', '/store/returns/', {}],
          ['post', '/store/returns?fields=id', {}],
          ['get', '/store/returns'],
          ['post', '/store/returns/anything', {}],
        ] as const) {
          const res = await send(method, path, anon, body);
          expect({
            method,
            path,
            status: res.status,
            message: res.data?.message,
          }).toEqual({ method, path, status: 404, message: 'Not found' });
        }
      });

      // `/store/returns*` must not swallow its neighbour: return-reasons shares
      // the prefix up to "return", and is a plain GET with no body.
      it('leaves the sibling route and the storefront routes working', async () => {
        const reasons = await send('get', '/store/return-reasons', anon);
        expect(reasons.status).toBe(200);
        expect(Array.isArray(reasons.data.return_reasons)).toBe(true);

        // The storefront's public pack list (src/lib/data/packs.ts).
        const packs = await send('get', '/store/packs', anon);
        expect(packs.status).toBe(200);
        expect(Array.isArray(packs.data.packs)).toBe(true);
      });

      // Why /vendor/* needs no block of its own: an anonymous caller is turned
      // away before zod sees the body. /vendor/returns is the catch-all's case;
      // the other two are exempt from it and authenticate on their own entries.
      it('keeps /vendor routes behind a login, ahead of validation', async () => {
        for (const path of [
          '/vendor/returns',
          '/vendor/sellers/select',
          '/vendor/members/invites/accept',
        ]) {
          const res = await unwrapResponse(api.post(path, flood));
          expect({ path, status: res.status }).toEqual({ path, status: 401 });
        }
      });
    });
  },
});
