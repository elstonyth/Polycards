// integration-tests/http/store-credits.spec.ts
// TDD: RED first — GET /store/credits does not yet return a wallet block.
// Tests:
//   (wallet)  GET /store/credits returns a wallet block with the right shape.
//   (compat)  existing top-level balance/topup_total/spend_total/transactions untouched.
//   (auth)    no bearer → 401.
import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { unwrapResponse } from './utils';

jest.setTimeout(120 * 1000);

const PASSWORD = 'store-credits-test-pw-1';

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('GET /store/credits wallet block', () => {
      let storeHeaders: Record<string, string>;
      let customerToken: string;

      beforeEach(async () => {
        const container = getContainer();

        // Publishable API key required for /store/* endpoints.
        const apiKeyModule = container.resolve(Modules.API_KEY);
        const key = await apiKeyModule.createApiKeys({
          title: 'store-credits-test',
          type: 'publishable',
          created_by: 'store-credits-test',
        });
        storeHeaders = { 'x-publishable-api-key': key.token };

        // Register + login a customer.
        const reg = await api.post('/auth/customer/emailpass/register', {
          email: 'sc-wallet-a@test.dev',
          password: PASSWORD,
        });
        await api.post(
          '/store/customers',
          { email: 'sc-wallet-a@test.dev' },
          {
            headers: {
              ...storeHeaders,
              authorization: `Bearer ${reg.data.token}`,
            },
          },
        );
        const login = await api.post('/auth/customer/emailpass', {
          email: 'sc-wallet-a@test.dev',
          password: PASSWORD,
        });
        customerToken = login.data.token;
      });

      const authed = (token: string): Record<string, string> => ({
        ...storeHeaders,
        authorization: `Bearer ${token}`,
      });

      it('(auth) returns 401 when no bearer token is provided', async () => {
        const res = await unwrapResponse(
          api.get('/store/credits', { headers: storeHeaders }),
        );
        expect(res.status).toBe(401);
      });

      it('GET /store/credits returns a wallet block', async () => {
        const res = await unwrapResponse(
          api.get('/store/credits', { headers: authed(customerToken) }),
        );
        expect(res.status).toBe(200);
        // wallet block must exist with the right shape
        expect(res.data.wallet).toMatchObject({
          balance: expect.any(Number),
          available: expect.any(Number),
          locked: expect.any(Number),
          is_frozen: false,
        });
        // next_unlock is either null or { amount: Number, date: string }
        expect(
          res.data.wallet.next_unlock === null ||
            (typeof res.data.wallet.next_unlock === 'object' &&
              typeof res.data.wallet.next_unlock.amount === 'number' &&
              typeof res.data.wallet.next_unlock.date === 'string'),
        ).toBe(true);
        // backward-compat: top-level balance is unchanged and matches wallet.balance
        expect(res.data.balance).toBe(res.data.wallet.balance);
      });

      it('(compat) existing top-level fields are untouched', async () => {
        const res = await unwrapResponse(
          api.get('/store/credits', { headers: authed(customerToken) }),
        );
        expect(res.status).toBe(200);
        // All pre-existing fields must still be present
        expect(typeof res.data.balance).toBe('number');
        expect(typeof res.data.topup_total).toBe('number');
        expect(typeof res.data.spend_total).toBe('number');
        expect(Array.isArray(res.data.transactions)).toBe(true);
      });

      it('(pagination) limit/offset walk the ledger newest-first with has_more', async () => {
        // Seed 3 ledger rows directly (append-only ledger — adjustment rows).
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        const payload = JSON.parse(
          Buffer.from(customerToken.split('.')[1], 'base64').toString('utf8'),
        );
        const customerId = payload.actor_id as string;
        await packs.createCreditTransactions([
          { customer_id: customerId, amount: 1, reason: 'adjustment' },
          { customer_id: customerId, amount: 2, reason: 'adjustment' },
          { customer_id: customerId, amount: 3, reason: 'adjustment' },
        ]);

        const p1 = await unwrapResponse(
          api.get('/store/credits?limit=2&offset=0', {
            headers: authed(customerToken),
          }),
        );
        expect(p1.status).toBe(200);
        expect(p1.data.transactions.length).toBe(2);
        expect(p1.data.has_more).toBe(true);
        // Totals stay full-ledger regardless of the page.
        expect(p1.data.balance).toBe(6);

        const p2 = await unwrapResponse(
          api.get('/store/credits?limit=2&offset=2', {
            headers: authed(customerToken),
          }),
        );
        expect(p2.status).toBe(200);
        expect(p2.data.transactions.length).toBe(1);
        expect(p2.data.has_more).toBe(false);
        expect(p2.data.balance).toBe(6);

        // Pages must not overlap.
        const ids1 = p1.data.transactions.map((t: { id: string }) => t.id);
        const ids2 = p2.data.transactions.map((t: { id: string }) => t.id);
        for (const id of ids2) expect(ids1).not.toContain(id);
      });

      it('(pagination) clearly-invalid limit/offset → 400', async () => {
        const badLimit = await unwrapResponse(
          api.get('/store/credits?limit=0', {
            headers: authed(customerToken),
          }),
        );
        expect(badLimit.status).toBe(400);
        const badOffset = await unwrapResponse(
          api.get('/store/credits?offset=-1', {
            headers: authed(customerToken),
          }),
        );
        expect(badOffset.status).toBe(400);
      });

      it('(auth) GET /store/credits/balance returns 401 without a bearer token', async () => {
        const res = await unwrapResponse(
          api.get('/store/credits/balance', { headers: storeHeaders }),
        );
        expect(res.status).toBe(401);
      });

      it('GET /store/credits/balance returns the same balance as the full route', async () => {
        const lean = await unwrapResponse(
          api.get('/store/credits/balance', { headers: authed(customerToken) }),
        );
        expect(lean.status).toBe(200);
        expect(typeof lean.data.balance).toBe('number');

        const full = await unwrapResponse(
          api.get('/store/credits', { headers: authed(customerToken) }),
        );
        expect(lean.data.balance).toBe(full.data.balance);
      });
    });
  },
});
