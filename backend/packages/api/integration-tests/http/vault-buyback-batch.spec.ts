import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { postStoreCustomer } from './utils';

jest.setTimeout(240 * 1000);

const PASSWORD = 'vbb-test-password-1';

// Same deterministic economics as vault-buyback.spec: FMV $50 × FX 4.0 × markup
// 1.2 = RM 240; fresh pulls sell at the pack's INSTANT rate (96%) = RM 230.40.
const PACK_SLUG = 'vbb-pack';
const CARD_HANDLE = 'vbb-card';
const FMV = 50;
const MULTIPLIER = 1.2;
const MANUAL_RATE = 4.0;
const INSTANT_PERCENT = 96;
const INSTANT_AMOUNT = 230.4; // 96% × (50 × 4.0 × 1.2)
const PACK_PRICE = 10;

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('vault → bulk buyback (POST /store/vault/buyback-batch)', () => {
      let storeHeaders: Record<string, string>;

      beforeEach(async () => {
        const container = getContainer();

        const apiKeyModule = container.resolve(Modules.API_KEY);
        const key = await apiKeyModule.createApiKeys({
          title: 'vault-buyback-batch-test',
          type: 'publishable',
          created_by: 'vault-buyback-batch-test',
        });
        storeHeaders = { 'x-publishable-api-key': key.token };

        // A single-card pool → the weighted roll is deterministic (always wins).
        const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
        await packs.createPacks([
          {
            slug: PACK_SLUG,
            title: 'VBB Test Pack',
            category: 'pokemon',
            price: PACK_PRICE,
            image: '/cdn/test-pack.webp',
            buyback_percent: INSTANT_PERCENT,
          },
        ]);
        await packs.createCards([
          {
            handle: CARD_HANDLE,
            name: 'VBB Test Card PSA 10',
            set: 'Test Set',
            grader: 'PSA',
            grade: '10',
            market_value: FMV,
            market_multiplier: MULTIPLIER,
            image: '/cdn/test-card.webp',
          },
        ]);
        await packs.createPackOdds([
          {
            pack_id: PACK_SLUG,
            card_id: CARD_HANDLE,
            weight: 100,
            locked: false,
            rarity: 'Rare' as const,
          },
        ]);
        await packs.createFxRates([
          {
            pair: 'USD_MYR',
            rate: MANUAL_RATE,
            source: 'test',
            manual_override: true,
            manual_rate: MANUAL_RATE,
          },
        ]);
      });

      const authed = (token: string): Record<string, string> => ({
        ...storeHeaders,
        authorization: `Bearer ${token}`,
      });

      const registerCustomer = async (email: string): Promise<string> => {
        const reg = await api.post('/auth/customer/emailpass/register', {
          email,
          password: PASSWORD,
        });
        await postStoreCustomer(
          api,
          getContainer(),
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
        return login.data.token;
      };

      const fund = (token: string, amount: number, keySuffix: string) =>
        api.post(
          '/store/credits/topup',
          { amount },
          {
            headers: {
              ...authed(token),
              'idempotency-key': `vbb-${keySuffix}`,
            },
          },
        );

      const openPull = async (token: string): Promise<string> => {
        const open = await api
          .post(
            `/store/packs/${PACK_SLUG}/open`,
            {},
            { headers: authed(token) },
          )
          .catch((e) => e.response);
        expect(open.status).toBe(200);
        return open.data.pull.id as string;
      };

      const batch = (token: string, pullIds: unknown) =>
        api
          .post(
            '/store/vault/buyback-batch',
            { pull_ids: pullIds },
            { headers: authed(token) },
          )
          .catch((e) => e.response);

      it('rejects an unauthenticated batch with 401', async () => {
        const res = await api
          .post(
            '/store/vault/buyback-batch',
            { pull_ids: ['x'] },
            { headers: storeHeaders },
          )
          .catch((e) => e.response);
        expect(res.status).toBe(401);
      });

      it('validates the body: empty / non-array / over-cap → 400', async () => {
        const token = await registerCustomer('vbb-validate@test.dev');
        expect((await batch(token, [])).status).toBe(400);
        expect((await batch(token, 'nope')).status).toBe(400);
        expect(
          (
            await batch(
              token,
              Array.from({ length: 501 }, (_, i) => `p${i}`),
            )
          ).status,
        ).toBe(400);
      });

      it('sells the sellable pulls, skips already-sold + foreign + unknown, and never double-credits', async () => {
        const tokenA = await registerCustomer('vbb-a@test.dev');
        const tokenB = await registerCustomer('vbb-b@test.dev');
        await fund(tokenA, 3 * PACK_PRICE, 'a-topup'); // 3 opens
        await fund(tokenB, PACK_PRICE, 'b-topup'); // 1 open

        const a1 = await openPull(tokenA);
        const a2 = await openPull(tokenA);
        const a3 = await openPull(tokenA);
        const b1 = await openPull(tokenB);

        // Pre-sell a1 individually so the batch must SKIP it (already sold),
        // not credit it twice.
        const pre = await api
          .post(`/store/vault/${a1}/buyback`, {}, { headers: authed(tokenA) })
          .catch((e) => e.response);
        expect(pre.status).toBe(200);
        expect(pre.data.amount).toBe(INSTANT_AMOUNT);

        // Batch: a1 (already sold), a2 + a3 (fresh, sellable), b1 (foreign),
        // and an unknown id. Also duplicate a2 to prove dedupe.
        const res = await batch(tokenA, [
          a1,
          a2,
          a3,
          a2,
          b1,
          'vbb_unknown_zzz',
        ]);
        expect(res.status).toBe(200);

        // Two sold (a2, a3), three failed (a1 already-sold, b1 foreign→404,
        // unknown→404). The duplicate a2 was deduped, so it's not a 6th entry.
        expect(res.data.sold).toBe(2);
        expect(res.data.failed).toBe(3);
        expect(res.data.credited).toBeCloseTo(2 * INSTANT_AMOUNT, 2);
        expect(res.data.results).toHaveLength(5);

        const byId = new Map<string, { ok: boolean; error?: string }>(
          res.data.results.map(
            (r: { pull_id: string; ok: boolean; error?: string }) => [
              r.pull_id,
              r,
            ],
          ),
        );
        expect(byId.get(a2)?.ok).toBe(true);
        expect(byId.get(a3)?.ok).toBe(true);
        expect(byId.get(a1)?.ok).toBe(false);
        expect(byId.get(a1)?.error).toMatch(/already sold back/i);
        expect(byId.get(b1)?.ok).toBe(false); // foreign pull → not found (no leak)
        expect(byId.get('vbb_unknown_zzz')?.ok).toBe(false);

        // Balance: 30 topup − 30 opens + 3 × 230.40 (a1 individual + a2 + a3).
        expect(res.data.balance).toBeCloseTo(3 * INSTANT_AMOUNT, 2);

        // MONEY-SAFETY: A has exactly 3 buyback credits (a1, a2, a3) — the batch
        // did NOT double-credit a1 and did NOT credit the foreign/unknown ids.
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        const [a] = await packs.listPulls({ id: a2 }, { take: 1 });
        const aBuybacks = await packs.listCreditTransactions(
          { customer_id: a.customer_id, reason: 'buyback' },
          { take: 100 },
        );
        expect(aBuybacks).toHaveLength(3);

        // B was never charged: b1 stays vaulted, B has zero buyback credits.
        const bVault = await api.get('/store/vault', {
          headers: authed(tokenB),
        });
        expect(bVault.data.items).toHaveLength(1);
        expect(bVault.data.items[0].pull_id).toBe(b1);
        const [bPull] = await packs.listPulls({ id: b1 }, { take: 1 });
        const bBuybacks = await packs.listCreditTransactions(
          { customer_id: bPull.customer_id, reason: 'buyback' },
          { take: 100 },
        );
        expect(bBuybacks).toHaveLength(0);

        // A's vault is now empty (all three of A's pulls left 'vaulted').
        const aVault = await api.get('/store/vault', {
          headers: authed(tokenA),
        });
        expect(aVault.data.items).toHaveLength(0);
      });
    });
  },
});
