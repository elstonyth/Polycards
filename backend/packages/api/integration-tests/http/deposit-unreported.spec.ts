import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

// /store/credits/deposit/unreported against a REAL database — the Meta Pixel's
// source of settled deposits and its ack. The unit spec only sees the filter
// object handed to a mock; this proves what the rows do: `pixel_reported_at:
// null` is IS NULL, the reference array is IN, every read and write is scoped
// to the caller, and "first" is decided once and never handed on.
const PASSWORD = 'deposit-unreported-password-1'; // gitleaks:allow

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('/store/credits/deposit/unreported', () => {
      let storeHeaders: Record<string, string>;
      let packs: PacksModuleService;

      beforeEach(async () => {
        const container = getContainer();
        const key = await container.resolve(Modules.API_KEY).createApiKeys({
          title: 'deposit-unreported-test',
          type: 'publishable',
          created_by: 'deposit-unreported-test',
        });
        storeHeaders = { 'x-publishable-api-key': key.token };
        packs = container.resolve<PacksModuleService>(PACKS_MODULE);
      });

      const authed = (token: string): Record<string, string> => ({
        ...storeHeaders,
        authorization: `Bearer ${token}`,
      });

      // The register JWT carries actor_id: '' until POST /store/customers links
      // it, so log in again after linking — otherwise every owner-scoping
      // assertion passes vacuously.
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
        const token = login.data.token as string;
        const me = await unwrapResponse(
          api.get('/store/customers/me', { headers: authed(token) }),
        );
        const id = me.data.customer.id as string;
        expect(id).toBeTruthy();
        return { token, id };
      };

      const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);
      const deposit = (
        customerId: string,
        ref: string,
        amount: number,
        status: 'settled' | 'pending',
        settledAt?: Date,
      ) =>
        packs.createGatewayDeposits([
          {
            merchant_transaction_id: ref,
            customer_id: customerId,
            amount_requested: amount,
            ...(status === 'settled'
              ? { amount_settled: amount, settled_at: settledAt }
              : {}),
            payment_method_code: 'FPX',
            status,
          },
        ]);

      const unreported = async (token: string) => {
        const res = await unwrapResponse(
          api.get('/store/credits/deposit/unreported', {
            headers: authed(token),
          }),
        );
        expect(res.status).toBe(200);
        return res.data.deposits as {
          merchant_transaction_id: string;
          amount: number;
          first: boolean;
        }[];
      };
      const ack = (token: string, references: string[]) =>
        unwrapResponse(
          api.post(
            '/store/credits/deposit/unreported',
            { references },
            { headers: authed(token) },
          ),
        );

      it('refuses unauthenticated reads and acks with 401', async () => {
        const read = await unwrapResponse(
          api.get('/store/credits/deposit/unreported', {
            headers: storeHeaders,
          }),
        );
        expect(read.status).toBe(401);
        const write = await unwrapResponse(
          api.post(
            '/store/credits/deposit/unreported',
            { references: ['PC-x'] },
            { headers: storeHeaders },
          ),
        );
        expect(write.status).toBe(401);
      });

      it('lists only the caller’s settled, unreported deposits, oldest settlement first', async () => {
        const a = await registerCustomer('du-a@test.dev');
        const b = await registerCustomer('du-b@test.dev');
        // Created in the opposite order to settlement, so creation order and
        // settlement order DISAGREE on which is first.
        await deposit(a.id, 'PC-du-a-late', 100, 'settled', minutesAgo(10));
        await deposit(a.id, 'PC-du-a-early', 50, 'settled', minutesAgo(20));
        await deposit(a.id, 'PC-du-a-pending', 30, 'pending');
        await deposit(b.id, 'PC-du-b', 70, 'settled', minutesAgo(5));

        expect(await unreported(a.token)).toEqual([
          { merchant_transaction_id: 'PC-du-a-early', amount: 50, first: true },
          {
            merchant_transaction_id: 'PC-du-a-late',
            amount: 100,
            first: false,
          },
        ]);
      });

      it('acks only the caller’s own rows, which then stop being offered', async () => {
        const a = await registerCustomer('du-ack-a@test.dev');
        const b = await registerCustomer('du-ack-b@test.dev');
        await deposit(a.id, 'PC-du-ack-a', 50, 'settled', minutesAgo(10));
        await deposit(b.id, 'PC-du-ack-b', 70, 'settled', minutesAgo(10));

        const res = await ack(a.token, [
          'PC-du-ack-a',
          'PC-du-ack-b',
          'PC-du-unknown',
        ]);
        expect(res.status).toBe(200);
        expect(res.data.acknowledged).toBe(1);

        expect(await unreported(a.token)).toEqual([]);
        // B's deposit was not A's to ack.
        expect(await unreported(b.token)).toEqual([
          { merchant_transaction_id: 'PC-du-ack-b', amount: 70, first: true },
        ]);
        // Idempotent: acking again matches nothing and changes nothing.
        expect((await ack(a.token, ['PC-du-ack-a'])).data.acknowledged).toBe(0);
      });

      // The sweep stamps its START instant on every deposit it settles, so a
      // deposit can become visible after another was already reported as
      // first, yet carry an earlier settled_at. It must not be a second first.
      it('never hands "first" on once a deposit has been reported', async () => {
        const c = await registerCustomer('du-first@test.dev');
        await deposit(c.id, 'PC-du-first-2', 80, 'settled', minutesAgo(5));
        expect(await unreported(c.token)).toEqual([
          { merchant_transaction_id: 'PC-du-first-2', amount: 80, first: true },
        ]);
        await ack(c.token, ['PC-du-first-2']);

        await deposit(c.id, 'PC-du-first-1', 60, 'settled', minutesAgo(15));
        expect(await unreported(c.token)).toEqual([
          {
            merchant_transaction_id: 'PC-du-first-1',
            amount: 60,
            first: false,
          },
        ]);
      });

      it('rejects a malformed ack without touching anything', async () => {
        const a = await registerCustomer('du-bad@test.dev');
        await deposit(a.id, 'PC-du-bad', 50, 'settled', minutesAgo(10));
        const res = await ack(a.token, []);
        expect(res.status).toBe(400);
        expect(await unreported(a.token)).toHaveLength(1);
      });
    });
  },
});
