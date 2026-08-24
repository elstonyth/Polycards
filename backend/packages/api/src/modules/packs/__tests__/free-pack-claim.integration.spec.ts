/**
 * Free welcome pack — claim state + unlock reads (integration:modules)
 *
 * The service seam every later task calls (spec
 * docs/superpowers/specs/2026-08-14-free-welcome-pack-design.md). Asserted
 * contracts:
 *  - markFreePackAvailable: idempotent stamp, claimed_at untouched.
 *  - claimFreePack: true EXACTLY once, and only for a stamped account.
 *  - clearFreePackClaim: compensation re-opens the claim.
 *  - hasPaidOpen: only a source='pack' pull unlocks (free/reward do not).
 *  - getActiveFreePack: an ACTIVE free_welcome pack, else null.
 *
 * Test-runner caveat: moduleIntegrationTestRunner rebuilds schema from MODELS,
 * not from the hand-written migrations — CHECK constraints are absent, so every
 * seeded field is set explicitly and only runtime logic is asserted here.
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
import RewardDraw from '../models/reward-draw';

jest.setTimeout(300 * 1000);

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
    RewardDraw,
  ],
  testSuite: ({ service }) => {
    describe('free pack claim state', () => {
      it('markFreePackAvailable stamps once, idempotently', async () => {
        await service.markFreePackAvailable('cus_1');
        await service.markFreePackAvailable('cus_1');
        const [s] = await service.listCustomerAccountStates(
          { customer_id: 'cus_1' },
          { take: 1 },
        );
        expect(s.free_pack_available_at).toBeTruthy();
        expect(s.free_pack_claimed_at).toBeNull();
      });

      it('claimFreePack succeeds exactly once, and only for stamped accounts', async () => {
        expect(await service.claimFreePack('cus_nobody')).toBe(false); // never stamped
        await service.markFreePackAvailable('cus_2');
        expect(await service.claimFreePack('cus_2')).toBe(true);
        expect(await service.claimFreePack('cus_2')).toBe(false); // second claim loses
      });

      it('clearFreePackClaim re-opens the claim (compensation path)', async () => {
        await service.markFreePackAvailable('cus_3');
        await service.claimFreePack('cus_3');
        await service.clearFreePackClaim('cus_3');
        expect(await service.claimFreePack('cus_3')).toBe(true);
      });

      it('hasPaidOpen: false for free/reward pulls, true once a pack pull exists', async () => {
        await service.createPulls([
          {
            customer_id: 'cus_4',
            pack_id: 'free-welcome',
            card_id: 'c1',
            rolled_at: new Date(),
            source: 'free',
          },
        ]);
        expect(await service.hasPaidOpen('cus_4')).toBe(false);
        // A challenge/reward prize is not a purchase either — it must not lift
        // the free pull's lock (CodeRabbit: the case the name promised).
        await service.createPulls([
          {
            customer_id: 'cus_4',
            pack_id: 'challenge-2026-08-10',
            card_id: 'c1',
            rolled_at: new Date(),
            source: 'reward',
          },
        ]);
        expect(await service.hasPaidOpen('cus_4')).toBe(false);
        await service.createPulls([
          {
            customer_id: 'cus_4',
            pack_id: 'bronze-pack',
            card_id: 'c1',
            rolled_at: new Date(),
            source: 'pack',
          },
        ]);
        expect(await service.hasPaidOpen('cus_4')).toBe(true);
      });

      it('getActiveFreePack: only active free_welcome packs, null otherwise', async () => {
        expect(await service.getActiveFreePack()).toBeNull();
        await service.createPacks([
          {
            slug: 'free-welcome',
            title: 'Welcome Pack',
            category: 'free_welcome',
            price: 0,
            image: '/x.webp',
            status: 'draft',
          },
        ]);
        expect(await service.getActiveFreePack()).toBeNull();
        await service.updatePacks({
          selector: { slug: 'free-welcome' },
          data: { status: 'active' },
        });
        expect((await service.getActiveFreePack())?.slug).toBe('free-welcome');
      });
    });
  },
});
