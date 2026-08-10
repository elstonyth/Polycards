import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

const PASSWORD = 'cl-test-password-1';

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('GET /store/credits/latest — the money-dot signal', () => {
      let storeHeaders: Record<string, string>;
      let packs: PacksModuleService;

      beforeEach(async () => {
        const container = getContainer();
        const apiKeyModule = container.resolve(Modules.API_KEY);
        const key = await apiKeyModule.createApiKeys({
          title: 'credits-latest-test',
          type: 'publishable',
          created_by: 'credits-latest-test',
        });
        storeHeaders = { 'x-publishable-api-key': key.token };
        packs = container.resolve<PacksModuleService>(PACKS_MODULE);
      });

      const authed = (token: string): Record<string, string> => ({
        ...storeHeaders,
        authorization: `Bearer ${token}`,
      });

      // The register JWT carries actor_id: '' until POST /store/customers links
      // it, so log in AGAIN after linking — otherwise the customer id is empty
      // and every owner-scoping assertion passes vacuously.
      const registerCustomer = async (
        email: string,
      ): Promise<{ token: string; id: string }> => {
        const reg = await api.post('/auth/customer/emailpass/register', {
          email,
          password: PASSWORD,
        });
        await api.post(
          '/store/customers',
          { email },
          {
            headers: {
              ...storeHeaders,
              authorization: `Bearer ${reg.data.token}`,
            },
          },
        );
        const login = await api.post('/auth/customer/emailpass', {
          email,
          password: PASSWORD,
        });
        const token = login.data.token;
        const me = await unwrapResponse(
          api.get('/store/customers/me', { headers: authed(token) }),
        );
        const id = me.data.customer.id as string;
        expect(id).toBeTruthy();
        return { token, id };
      };

      it('rejects unauthenticated access with 401', async () => {
        const res = await unwrapResponse(
          api.get('/store/credits/latest', { headers: storeHeaders }),
        );
        expect(res.status).toBe(401);
      });

      it('answers null for an empty ledger, and marks the response no-store', async () => {
        const { token } = await registerCustomer('cl-empty@test.dev');

        const res = await api.get('/store/credits/latest', {
          headers: authed(token),
        });

        expect(res.status).toBe(200);
        expect(res.data.latest_event_at).toBeNull();
        expect(res.headers['cache-control']).toBe('no-store');
      });

      it("counts a DEBIT and never another customer's rows", async () => {
        const a = await registerCustomer('cl-a@test.dev');
        const b = await registerCustomer('cl-b@test.dev');

        // A spend, not a credit: money OUT is exactly what people open
        // /transactions to verify, so it must light the dot too.
        await packs.createCreditTransactions([
          {
            customer_id: a.id,
            amount: -25,
            reason: 'pack_open',
          },
        ]);

        // A second, later row. With take: 1 a WRONG order would return the
        // OLDER one and a non-null assertion would still pass — so pin which.
        const [newer] = await packs.createCreditTransactions([
          {
            customer_id: a.id,
            amount: 10,
            reason: 'buyback',
          },
        ]);

        const resA = await api.get('/store/credits/latest', {
          headers: authed(a.token),
        });
        expect(resA.status).toBe(200);
        expect(resA.data.latest_event_at).not.toBeNull();
        expect(new Date(resA.data.latest_event_at).getTime()).toBe(
          new Date(newer.created_at).getTime(),
        );

        // B has no rows: A's ledger must be invisible, not merely deprioritised.
        const resB = await api.get('/store/credits/latest', {
          headers: authed(b.token),
        });
        expect(resB.status).toBe(200);
        expect(resB.data.latest_event_at).toBeNull();
      });
    });
  },
});
