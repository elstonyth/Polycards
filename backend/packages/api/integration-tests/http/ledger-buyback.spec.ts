import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

const PASSWORD = 'ledger-buyback-test-password-1'; // gitleaks:allow

// Task 6 (POLYCARD-BACK Epic 4 §5.3) — the SE ledger writer wired into
// buyback-pull: a sell-back appends exactly ONE SE ledger row (wallet_delta
// +amount, vault_delta -amount, same magnitude — the plan's "Open items" #4
// scopes the display-price vault_delta convention to Tasks 7/8, NOT this
// writer) in the SAME transaction as the buyback's credit_transaction write.
// Buyback-flow behavior itself (rates, stock restore, foreign-customer 404s)
// is vault-buyback.spec.ts's job; this file only tests the new ledger row.

const PACK_SLUG = 'ledger-se-pack';
const CARD_HANDLE = 'ledger-se-card';
const FMV = 50;
const MULTIPLIER = 1.2;
const MANUAL_RATE = 4.0;
const INSTANT_PERCENT = 96;
const PACK_PRICE = 10;

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('ledger: SE writer — buyback / sell', () => {
      let storeHeaders: Record<string, string>;

      // The runner resets the database between `it` blocks, so the publishable
      // key, the gacha fixtures, and any customers are recreated per test.
      beforeEach(async () => {
        const container = getContainer();
        const apiKeyModule = container.resolve(Modules.API_KEY);
        const key = await apiKeyModule.createApiKeys({
          title: 'ledger-buyback-test',
          type: 'publishable',
          created_by: 'ledger-buyback-test',
        });
        storeHeaders = { 'x-publishable-api-key': key.token };

        // Gacha fixtures: an active pack with a SINGLE-card pool, so the
        // weighted roll is deterministic (the only card always wins). No
        // product/inventory setup — stock is a best-effort counter, not a
        // gate (decrement-card-stock.ts), so an untracked card opens fine.
        const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
        await packs.createPacks([
          {
            slug: PACK_SLUG,
            title: 'Ledger SE Test Pack',
            category: 'pokemon',
            price: PACK_PRICE,
            image: '/cdn/test-pack.webp',
            buyback_percent: INSTANT_PERCENT,
          },
        ]);
        await packs.createCards([
          {
            handle: CARD_HANDLE,
            name: 'Ledger SE Test Card PSA 10',
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
        // Pin USD->MYR so the buyback amount is deterministic.
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

      const registerCustomer = async (
        email: string,
      ): Promise<{ token: string; id: string }> => {
        const reg = await api.post('/auth/customer/emailpass/register', {
          email,
          password: PASSWORD,
        });
        const created = await api.post(
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
        return { token: login.data.token, id: created.data.customer.id };
      };

      const ledgerEntryRowsFor = async (
        customerId: string,
        type?: string,
      ): Promise<Awaited<ReturnType<PacksModuleService['listLedgerEntries']>>> => {
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        const filter: Record<string, unknown> = { customer_id: customerId };
        if (type) filter.type = type;
        return packs.listLedgerEntries(filter, {
          order: { occurred_at: 'DESC' },
        });
      };

      // Fund one pack's price and open it — returns the resulting vaulted pull id.
      const openOne = async (token: string): Promise<string> => {
        await api.post(
          '/store/credits/topup',
          { amount: PACK_PRICE },
          { headers: { ...authed(token), 'idempotency-key': 'ledger-se-topup' } },
        );
        const open = await api.post(
          `/store/packs/${PACK_SLUG}/open`,
          {},
          { headers: authed(token) },
        );
        return open.data.pull.id as string;
      };

      it('a buyback writes ONE SE ledger row: wallet +, vault -, same magnitude', async () => {
        const { token, id } = await registerCustomer('ledger-test-5@test.dev');
        const pullId = await openOne(token);
        const res = await api.post(
          `/store/vault/${pullId}/buyback`,
          {},
          { headers: authed(token) },
        );
        expect(res.status).toBe(200);
        const amount = res.data.amount as number;

        const rows = await ledgerEntryRowsFor(id, 'SE');
        expect(rows).toHaveLength(1);
        expect(Number(rows[0].wallet_delta)).toBe(amount);
        expect(Number(rows[0].vault_delta)).toBe(-amount);
      });

      it('a duplicate buyback attempt on the same pull writes no second ledger row', async () => {
        const { token, id } = await registerCustomer('ledger-test-6@test.dev');
        const pullId = await openOne(token);
        await api.post(
          `/store/vault/${pullId}/buyback`,
          {},
          { headers: authed(token) },
        );
        // Second attempt 400s ("already sold back") — axios throws on non-2xx
        // by default (this harness sets no validateStatus override), so the
        // expected-error call must go through unwrapResponse like every other
        // "expect a 4xx" call in this suite (see credit-adjust.spec.ts).
        const dup = await unwrapResponse(
          api.post(
            `/store/vault/${pullId}/buyback`,
            {},
            { headers: authed(token) },
          ),
        );
        expect(dup.status).toBe(400);
        const rows = await ledgerEntryRowsFor(id, 'SE');
        expect(rows).toHaveLength(1);
      });
    });
  },
});
