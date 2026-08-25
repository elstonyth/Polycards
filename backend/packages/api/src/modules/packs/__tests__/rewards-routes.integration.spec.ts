/**
 * D1 — Store reward routes + fail-closed gate (integration:modules)
 *
 * The route handlers are imported and called directly with a mock req/res (the
 * same pattern as the C2/C3 vault + profile route tests) — moduleIntegrationTestRunner
 * has no HTTP server, but it does give a real PacksModuleService, which is all the
 * handlers touch. The auth/rate-limit middleware is registered in api/middlewares.ts
 * and is OUT OF SCOPE here: these tests verify the handler bodies, with actor id
 * supplied via auth_context (never the body).
 *
 * Gate contract (spec §13, fail-closed):
 *  - REWARDS_REDEMPTION_ENABLED unset → POST /store/rewards/claim/:id returns 403
 *    BEFORE any write: the grant stays 'granted' (proves the gate is the first line).
 *  - POST /store/rewards/withdraw is NOT env-gated (balance-neutral; only the
 *    withdrawals_per_day cap inside recordRewardWithdrawal applies). With the
 *    env unset it still ships a vaulted reward Pull → 'requested'.
 *
 * Test-runner caveat: moduleIntegrationTestRunner rebuilds schema from MODELS, so
 * hand-written CHECK/partial-unique constraints are ABSENT here; runtime logic only.
 *
 * Path note: this lives under src/modules/packs/__tests__ (not src/api/__tests__)
 * so the integration:modules testMatch (`**\/src/modules/*\/__tests__/**`) actually
 * runs it — a file under src/api would match no test type and silently never run.
 *
 * Task 7 removed the old GET /store/rewards (index) and POST /store/rewards/draw
 * routes/tests, replacing them with GET /store/daily + POST /store/daily/draw.
 * The draw half went with the daily box (2026-08-25); GET /store/daily now
 * serves the voucher/frame grants alone.
 */

import path from 'path';
import { moduleIntegrationTestRunner } from '@medusajs/test-utils';
import { PACKS_MODULE } from '../index';
import type PacksModuleService from '../service';
import Pack from '../models/pack';
import Card from '../models/card';
import PackOdds from '../models/pack-odds';
import Pull from '../models/pull';
import CreditTransaction from '../models/credit-transaction';
import DeliveryOrder from '../models/delivery-order';
import DeliveryOrderItem from '../models/delivery-order-item';
import VipLevel from '../models/vip-level';
import RewardsSettings from '../models/rewards-settings';
import CustomerAccountState from '../models/customer-account-state';
import AdminActionAudit from '../models/admin-action-audit';
import VipMemberState from '../models/vip-member-state';
import VipRewardGrant from '../models/vip-reward-grant';
import NotificationRead from '../models/notification-read';

import { POST as claimPOST } from '../../../api/store/rewards/claim/[grantId]/route';
import { POST as withdrawPOST } from '../../../api/store/rewards/withdraw/route';

jest.setTimeout(300 * 1000);

const today = () => new Date().toISOString().slice(0, 10);

// A complete, free-form shipping address as the storefront POSTs it (camelCase).
// The withdraw route maps it → the snake_case shape snapshotAddress requires; no
// address-book lookup happens anymore (the Pull-ownership check is the boundary).
const ADDRESS = {
  firstName: 'Ada',
  lastName: 'Lovelace',
  address1: '1 Analytical Engine Way',
  city: 'Kuala Lumpur',
  postalCode: '50000',
  countryCode: 'my',
};

moduleIntegrationTestRunner<PacksModuleService>({
  moduleName: PACKS_MODULE,
  resolve: path.resolve(__dirname, '../../..', 'modules/packs'),
  moduleModels: [
    Pack,
    Card,
    PackOdds,
    Pull,
    CreditTransaction,
    DeliveryOrder,
    DeliveryOrderItem,
    VipLevel,
    RewardsSettings,
    CustomerAccountState,
    AdminActionAudit,
    VipMemberState,
    VipRewardGrant,
    NotificationRead,
  ],
  testSuite: ({ service }) => {
    // Build a mock req/res. scope.resolve returns the real packs service for every
    // module token — the reward routes only touch PACKS_MODULE (the withdraw route
    // no longer resolves the CUSTOMER address book).
    type ResCapture = { status?: number; body?: unknown };
    const makeReqRes = (opts: {
      customerId?: string;
      params?: Record<string, string>;
      body?: unknown;
    }) => {
      const captured: ResCapture = {};
      const res = {
        status(code: number) {
          captured.status = code;
          return this;
        },
        json(body: unknown) {
          captured.body = body;
          return this;
        },
      };
      const req = {
        auth_context: { actor_id: opts.customerId },
        params: opts.params ?? {},
        body: opts.body,
        scope: { resolve: () => service },
      };
      return { req, res, captured };
    };

    const seedVoucherGrant = async (customerId: string) => {
      const [grant] = await service.createVipRewardGrants([
        {
          customer_id: customerId,
          level: 10,
          kind: 'voucher',
          payload: { amount_myr: 25 },
          status: 'granted',
        },
      ]);
      return grant;
    };

    const seedRewardPull = async (customerId: string) => {
      const [pull] = await service.createPulls([
        {
          customer_id: customerId,
          pack_id: 'reward-box-c',
          card_id: 'prize-handle',
          order_id: null,
          rolled_at: new Date(),
          source: 'reward',
        },
      ]);
      await service.updatePulls([{ id: pull.id, status: 'vaulted' as const }]);
      return pull;
    };

    describe('D1 — fail-closed gate (REWARDS_REDEMPTION_ENABLED unset)', () => {
      const prev = process.env.REWARDS_REDEMPTION_ENABLED;
      beforeAll(() => {
        delete process.env.REWARDS_REDEMPTION_ENABLED;
      });
      afterAll(() => {
        if (prev === undefined) delete process.env.REWARDS_REDEMPTION_ENABLED;
        else process.env.REWARDS_REDEMPTION_ENABLED = prev;
      });

      it('POST /rewards/claim/:id → 403 and the grant stays granted (no write)', async () => {
        const customerId = 'cus_d1_claim';
        const grant = await seedVoucherGrant(customerId);

        const { req, res, captured } = makeReqRes({
          customerId,
          params: { grantId: grant.id },
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await claimPOST(req as any, res as any);

        expect(captured.status).toBe(403);

        // Proves the gate ran BEFORE claimReward: status untouched.
        const [after] = await service.listVipRewardGrants(
          { id: grant.id },
          { take: 1 },
        );
        expect(after.status).toBe('granted');
      });

      it('POST /rewards/withdraw → 403 and the Pull stays vaulted (no ship)', async () => {
        const customerId = 'cus_d1_wd';
        const pull = await seedRewardPull(customerId);

        const { req, res, captured } = makeReqRes({
          customerId,
          body: { pull_id: pull.id, address: ADDRESS },
        });
        let threw = false;
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await withdrawPOST(req as any, res as any);
        } catch {
          threw = true;
        }
        // Withdraw is now gated alongside claim: a 403 (thrown NOT_ALLOWED)
        // before any write — the prize is never shipped while redemption is dark.
        expect(threw || captured.status === 403).toBe(true);
        const [after] = await service.listPulls({ id: pull.id }, { take: 1 });
        expect(after.status).toBe('vaulted');
      });
    });

    describe('withdraw with the gate ENABLED', () => {
      const prev = process.env.REWARDS_REDEMPTION_ENABLED;
      beforeAll(() => {
        process.env.REWARDS_REDEMPTION_ENABLED = 'true';
      });
      afterAll(() => {
        if (prev === undefined) delete process.env.REWARDS_REDEMPTION_ENABLED;
        else process.env.REWARDS_REDEMPTION_ENABLED = prev;
      });

      it('POST /rewards/withdraw maps the free-form address and ships', async () => {
        const customerId = 'cus_wd_ok';
        const pull = await seedRewardPull(customerId);

        const { req, res, captured } = makeReqRes({
          customerId,
          body: { pull_id: pull.id, address: ADDRESS },
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await withdrawPOST(req as any, res as any);

        expect((captured.body as { status: string }).status).toBe('requested');
        const [after] = await service.listPulls({ id: pull.id }, { take: 1 });
        expect(after.status).toBe('delivering');
      });

      it('POST /rewards/withdraw rejects an incomplete address (INVALID_DATA) without shipping', async () => {
        const customerId = 'cus_wd_badaddr';
        const pull = await seedRewardPull(customerId);

        const { req, res, captured } = makeReqRes({
          customerId,
          // countryCode missing → required-field validation fails before any write.
          body: { pull_id: pull.id, address: { ...ADDRESS, countryCode: '' } },
        });
        let err: unknown;
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await withdrawPOST(req as any, res as any);
        } catch (e) {
          err = e;
        }
        // Specifically INVALID_DATA (the address gate) — not the redemption gate
        // (which is open here) and not a generic throw.
        if (err) {
          expect((err as { type?: string }).type).toBe('invalid_data');
        } else {
          expect(captured.status).toBe(400);
        }
        const [after] = await service.listPulls({ id: pull.id }, { take: 1 });
        expect(after.status).toBe('vaulted');
      });
    });
  },
});
