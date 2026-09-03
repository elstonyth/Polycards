// integration-tests/http/tasks.spec.ts
// The task system's HTTP surface (spec 2026-08-24 Phase B):
//   (auth)  store routes 401 without a bearer; /admin/tasks 401 unauthed
//   (loop)  admin creates a weekly check-in task → customer checks in →
//           claims → credited once; double actions are polite no-ops
import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { buybackAmount } from '../../src/modules/packs/buyback-rate';
import {
  DEFAULT_MARKET_MULTIPLIER,
  displayMarketPrice,
} from '../../src/modules/packs/pricing';
import { mintSuperAdmin, postStoreCustomer, unwrapResponse } from './utils';

jest.setTimeout(300 * 1000);

const PASSWORD = 'tasks-http-test-pw-1';

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('task HTTP surface', () => {
      let storeHeaders: Record<string, string>;
      let adminToken: string;
      let customerToken: string;

      const authed = (): Record<string, string> => ({
        ...storeHeaders,
        authorization: `Bearer ${customerToken}`,
      });
      const adminHeaders = (): Record<string, string> => ({
        authorization: `Bearer ${adminToken}`,
      });

      beforeEach(async () => {
        const container = getContainer();
        const apiKeyModule = container.resolve(Modules.API_KEY);
        const key = await apiKeyModule.createApiKeys({
          title: 'tasks-test',
          type: 'publishable',
          created_by: 'tasks-test',
        });
        storeHeaders = { 'x-publishable-api-key': key.token };
        adminToken = await mintSuperAdmin(
          container,
          api,
          'tasks-admin@test.dev',
          PASSWORD,
        );
        const reg = await api.post('/auth/customer/emailpass/register', {
          email: 'tasks-player@test.dev',
          password: PASSWORD,
        });
        await postStoreCustomer(
          api,
          container,
          { email: 'tasks-player@test.dev' },
          {
            headers: {
              ...storeHeaders,
              authorization: `Bearer ${reg.data.token}`,
            },
          },
        );
        const login = await api.post('/auth/customer/emailpass', {
          email: 'tasks-player@test.dev',
          password: PASSWORD,
        });
        customerToken = login.data.token;
      });

      it('401s without auth', async () => {
        expect(
          (
            await unwrapResponse(
              api.get('/store/tasks', { headers: storeHeaders }),
            )
          ).status,
        ).toBe(401);
        expect(
          (
            await unwrapResponse(
              api.post('/store/tasks/checkin', {}, { headers: storeHeaders }),
            )
          ).status,
        ).toBe(401);
        expect(
          (await unwrapResponse(api.post('/admin/tasks', {}))).status,
        ).toBe(401);
      });

      it('create → check in → claim → credited once', async () => {
        const created = await unwrapResponse(
          api.post(
            '/admin/tasks',
            {
              kind: 'weekly',
              title: 'Check in 1 day',
              requirement: { type: 'checkin_days', days: 1 },
              reward: { type: 'credit', amount_myr: 3 },
              reason: 'http test seed',
            },
            { headers: adminHeaders() },
          ),
        );
        expect(created.status).toBe(200);
        const taskId: string = created.data.id;

        // Hub shows it, incomplete, not checked in today.
        let hub = await unwrapResponse(
          api.get('/store/tasks', { headers: authed() }),
        );
        expect(hub.status).toBe(200);
        expect(hub.data.checked_in_today).toBe(false);
        expect(hub.data.tasks).toHaveLength(1);
        expect(hub.data.tasks[0].progress.completed).toBe(false);

        // Check in; second tap is a polite no-op.
        const c1 = await unwrapResponse(
          api.post('/store/tasks/checkin', {}, { headers: authed() }),
        );
        expect(c1.data.checked).toBe(true);
        const c2 = await unwrapResponse(
          api.post('/store/tasks/checkin', {}, { headers: authed() }),
        );
        expect(c2.data.checked).toBe(false);

        // Claim pays RM3 exactly once.
        const claim = await unwrapResponse(
          api.post(`/store/tasks/${taskId}/claim`, {}, { headers: authed() }),
        );
        expect(claim.data.claimed).toBe(true);
        const again = await unwrapResponse(
          api.post(`/store/tasks/${taskId}/claim`, {}, { headers: authed() }),
        );
        expect(again.data).toEqual({
          claimed: false,
          reason: 'already_claimed',
        });

        hub = await unwrapResponse(
          api.get('/store/tasks', { headers: authed() }),
        );
        expect(hub.data.checked_in_today).toBe(true);
        expect(hub.data.tasks[0].claimed).toBe(true);

        // Admin list surfaces the definition for editing.
        const list = await unwrapResponse(
          api.get('/admin/tasks', { headers: adminHeaders() }),
        );
        expect(list.data.tasks).toHaveLength(1);
        expect(list.data.tasks[0].reward).toEqual({
          type: 'credit',
          amount_myr: 3,
        });
      });

      // A pack reward is a free rip; the card it yields sells on the spot like
      // any pulled card (completing the task IS the requirement — operator
      // decision 2026-09-03). The spin response must carry the authoritative
      // instant quote, and selling must credit EXACTLY that number: the quote
      // and the credit come from the same helper, and this is the tier that
      // proves they agree end to end.
      it('pack reward → spin quotes a real instant sell-back, and selling pays exactly that', async () => {
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        // Single-card pool, so the roll is deterministic. Pinned FX so the
        // amounts are too (the sell path refuses without a firm rate).
        await packs.createPacks([
          {
            slug: 'tasks-rip-pack',
            title: 'Tasks Rip Pack',
            category: 'pokemon',
            price: 10,
            image: '/cdn/tasks-rip-pack.webp',
            buyback_percent: 95,
          },
        ]);
        await packs.createCards([
          {
            handle: 'tasks-rip-card',
            name: 'Tasks Rip Card',
            set: 'Test Set',
            grader: 'PSA',
            grade: '10',
            market_value: 20,
            image: '/cdn/tasks-rip-card.webp',
          },
        ]);
        await packs.createPackOdds([
          {
            pack_id: 'tasks-rip-pack',
            card_id: 'tasks-rip-card',
            weight: 100,
            locked: false,
            rarity: 'Rare' as const,
          },
        ]);
        await packs.createFxRates([
          {
            pair: 'USD_MYR',
            rate: 4,
            source: 'test',
            manual_override: true,
            manual_rate: 4,
          },
        ]);

        const created = await unwrapResponse(
          api.post(
            '/admin/tasks',
            {
              kind: 'weekly',
              title: 'Check in for a free rip',
              requirement: { type: 'checkin_days', days: 1 },
              reward: { type: 'pack', pack_id: 'tasks-rip-pack' },
              reason: 'http test seed',
            },
            { headers: adminHeaders() },
          ),
        );
        expect(created.status).toBe(200);
        const taskId: string = created.data.id;

        await unwrapResponse(
          api.post('/store/tasks/checkin', {}, { headers: authed() }),
        );
        const claim = await unwrapResponse(
          api.post(`/store/tasks/${taskId}/claim`, {}, { headers: authed() }),
        );
        expect(claim.data.claimed).toBe(true);
        const claimId: string = claim.data.claimId;

        const spin = await unwrapResponse(
          api.post(
            `/store/tasks/claims/${claimId}/spin`,
            {},
            { headers: authed() },
          ),
        );
        expect(spin.status).toBe(200);
        expect(spin.data.redeemed).toBe(true);
        expect(spin.data.card.handle).toBe('tasks-rip-card');
        expect(spin.data.price).toBe(0);
        expect(spin.data.free).toBe(true);
        // Not the welcome-pack lock: sellable right now, with a real quote at
        // the pack's instant rate off the MYR display value (USD 20 × FX 4 ×
        // the default market multiplier — the number the reveal shows).
        expect(spin.data.locked).toBe(false);
        expect(spin.data.sellable).toBe(true);
        expect(spin.data.buyback.rate_type).toBe('instant');
        expect(spin.data.buyback.percent).toBe(95);
        expect(spin.data.buyback.amount).toBe(
          buybackAmount(
            displayMarketPrice(20, 4, DEFAULT_MARKET_MULTIPLIER),
            95,
          ),
        );
        expect(spin.data.buyback.firm).toBe(true);
        expect(spin.data.buyback.vault_amount).toBeGreaterThan(0);
        expect(spin.data.buyback.instant_deadline_ms).toBeGreaterThan(0);

        // Selling inside the window credits exactly the quoted amount.
        const sell = await unwrapResponse(
          api.post(
            `/store/vault/${spin.data.pullId}/buyback`,
            {},
            { headers: authed() },
          ),
        );
        expect(sell.status).toBe(200);
        expect(sell.data.amount).toBe(spin.data.buyback.amount);
        expect(sell.data.rate_type).toBe('instant');
        expect(sell.data.balance).toBe(spin.data.buyback.amount);
      });
    });
  },
});
