/**
 * reward_draw integration test — integration:modules
 *
 * Verifies the reward_draw model structure and basic CRUD via the module
 * service:
 *
 * 1. A row with all required fields saves and round-trips cleanly
 *    (status defaults to 'drawn', nullable fields come back null).
 * 2. Two rows with the SAME (customer_id, draw_day) but DIFFERENT
 *    draw_ordinals both save — confirms the composite index does NOT
 *    block distinct ordinals.
 *
 * Note on the partial-unique index UQ_reward_draw_customer_day_ordinal:
 * the test runner uses refreshDatabase() (model-sync) in beforeEach, which
 * rebuilds the schema from MikroORM model definitions only — hand-written
 * partial-expression indexes are absent in this environment. The uniqueness
 * SQL contract is verified in migrations/__tests__/reward-draw-unique.unit.spec.ts
 * (SQL-string assertion on Migration20260625000100). The combined DB-level
 * enforcement under concurrent load is exercised by Task B6's concurrency
 * test, which asserts exactly draws_per_day 'drawn' + 1 'capped' with no
 * raw 23505 leaking to callers.
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
import ReferralRelationship from '../models/referral-relationship';
import Commission from '../models/commission';
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
    ReferralRelationship,
    Commission,
    CustomerAccountState,
    AdminActionAudit,
    VipMemberState,
    VipRewardGrant,
    NotificationRead,
    RewardDraw,
  ],
  testSuite: ({ service }) => {
    const BASE = {
      customer_id: 'cust_draw_test',
      tier: 'c',
      draw_day: '2026-06-25',
      prize_kind: 'credit' as const,
      prize_snapshot: { amount_myr: 5, currency: 'MYR' },
      vault_pull_id: null,
      credit_txn_id: null,
    };

    describe('reward_draw model', () => {
      it('round-trips all columns: status defaults drawn, nullable fields null', async () => {
        const [row] = await service.createRewardDraws([
          { ...BASE, draw_ordinal: 1 },
        ]);

        expect(row.customer_id).toBe('cust_draw_test');
        expect(row.tier).toBe('c');
        expect(row.draw_day).toBe('2026-06-25');
        expect(row.draw_ordinal).toBe(1);
        expect(row.prize_kind).toBe('credit');
        expect(row.prize_snapshot).toEqual({ amount_myr: 5, currency: 'MYR' });
        expect(row.status).toBe('drawn');   // default
        expect(row.vault_pull_id).toBeNull();
        expect(row.credit_txn_id).toBeNull();
      });

      it('accepts two rows with the same (customer_id, draw_day) but different ordinals', async () => {
        const customerId = 'cust_draw_test_2';
        const [r1] = await service.createRewardDraws([
          { ...BASE, customer_id: customerId, draw_ordinal: 1 },
        ]);
        const [r2] = await service.createRewardDraws([
          { ...BASE, customer_id: customerId, draw_ordinal: 2 },
        ]);

        expect(r1.draw_ordinal).toBe(1);
        expect(r2.draw_ordinal).toBe(2);
        expect(r1.id).not.toBe(r2.id);

        const saved = await service.listRewardDraws({ customer_id: customerId });
        expect(saved).toHaveLength(2);
        expect(saved.map((r) => r.draw_ordinal).sort()).toEqual([1, 2]);
      });

      it('links a product row to a real reward Pull via vault_pull_id', async () => {
        // Create an actual Pull first, so vault_pull_id references a row that
        // exists — the point is the association resolves, not that a column
        // stores an arbitrary string (a fabricated id round-tripping proves
        // nothing; a referential-integrity regression would still pass that).
        const [pull] = await service.createPulls([
          {
            customer_id: 'cust_draw_test_3',
            pack_id: 'pokemon-rookie',
            card_id: 'pikachu',
            order_id: null,
            rolled_at: new Date(),
            source: 'reward',
          },
        ]);

        const [row] = await service.createRewardDraws([
          {
            customer_id: 'cust_draw_test_3',
            tier: 'b',
            draw_day: '2026-06-25',
            draw_ordinal: 1,
            prize_kind: 'product',
            prize_snapshot: { product_handle: 'p-x', title: 'Pikachu', image: null },
            vault_pull_id: pull.id,
            credit_txn_id: null,
          },
        ]);

        expect(row.prize_kind).toBe('product');
        expect(row.vault_pull_id).toBe(pull.id);
        // The referenced Pull is a real, retrievable row.
        const [linked] = await service.listPulls({ id: pull.id });
        expect(linked?.id).toBe(pull.id);
        expect(row.credit_txn_id).toBeNull();
      });
    });
  },
});
