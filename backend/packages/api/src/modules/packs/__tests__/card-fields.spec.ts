/**
 * Card PriceCharting-linkage fields — integration:modules
 *
 * Verifies the 4 new Card columns (pc_product_id, pc_grade,
 * market_multiplier, pc_synced_at) persist correctly, including the
 * bigNumber default (+20% display markup) applying when omitted.
 *
 * Uses the real DB via moduleIntegrationTestRunner (lightweight; no full
 * medusa app boot) — same pattern as wallet-summary.spec.ts.
 */

import path from 'path';
import { moduleIntegrationTestRunner } from '@medusajs/test-utils';
import { PACKS_MODULE } from '../index';
import type PacksModuleService from '../service';
import Pack from '../models/pack';
import Card from '../models/card';
import FxRate from '../models/fx-rate';
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

jest.setTimeout(300 * 1000);

moduleIntegrationTestRunner<PacksModuleService>({
  moduleName: PACKS_MODULE,
  resolve: path.resolve(__dirname, '../../..', 'modules/packs'),
  moduleModels: [
    Pack,
    Card,
    FxRate,
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
  ],
  testSuite: ({ service }) => {
    describe('Card PriceCharting fields', () => {
      it('persists pc fields + default multiplier', async () => {
        const [c] = await service.createCards([
          {
            handle: 'charizard-psa-10',
            name: 'Charizard',
            set: 'Base Set',
            grader: 'PSA',
            grade: '10',
            market_value: 100,
            image: 'https://x/y.png',
            pc_product_id: '6910',
            pc_grade: 'PSA 10',
          } as Record<string, unknown>,
        ]);

        expect(c.pc_product_id).toBe('6910');
        expect(c.pc_grade).toBe('PSA 10');
        expect(Number(c.market_multiplier)).toBe(1.2);
        expect(c.pc_synced_at).toBeNull();
      });
    });
  },
});
