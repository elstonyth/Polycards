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
import AchievementDef from '../models/achievement-def';
import AchievementGrant from '../models/achievement-grant';
import AchievementMemberState from '../models/achievement-member-state';

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
    AchievementDef,
    AchievementGrant,
    AchievementMemberState,
  ],
  testSuite: ({ service }) => {
    describe('grantAchievements', () => {
      const cust = 'cus_ach_test';

      beforeEach(async () => {
        await service.createAchievementDefs([
          { key: 'cases_opened_1', name: 'First Pull', description: 'Open your first case', category: 'cases_opened', rarity: 'Common', xp: 50, metric: 'cases_opened', threshold: 1 },
          { key: 'cases_opened_25', name: 'Case Opener', description: 'Open 25 cases', category: 'cases_opened', rarity: 'Common', xp: 100, metric: 'cases_opened', threshold: 25 },
        ]);
      });

      it('grants a row + XP for a newly-crossed threshold, idempotently', async () => {
        // one pack pull → cases_opened = 1
        await service.createPulls([
          { customer_id: cust, pack_id: 'p', card_id: 'c', rolled_at: new Date(), status: 'vaulted', source: 'pack' },
        ]);

        const r1 = await service.grantAchievements(cust, 'open_1');
        expect(r1.newlyUnlocked).toEqual(['cases_opened_1']);

        const grants = await service.listAchievementGrants({ customer_id: cust });
        expect(grants).toHaveLength(1);
        expect(Number(grants[0].xp_awarded)).toBe(50);

        const [state] = await service.listAchievementMemberStates({ customer_id: cust });
        expect(Number(state.total_xp)).toBe(50);
        expect(Number(state.collector_level)).toBe(1);

        // re-run grants nothing new
        const r2 = await service.grantAchievements(cust, 'open_1');
        expect(r2.newlyUnlocked).toEqual([]);
        const grantsAfter = await service.listAchievementGrants({ customer_id: cust });
        expect(grantsAfter).toHaveLength(1);
      });

      it('peak_cases_opened does not drop when a card is sold back', async () => {
        // 25 pack pulls
        await service.createPulls(
          Array.from({ length: 25 }, (_, i) => ({ customer_id: cust, pack_id: 'p', card_id: `c${i}`, rolled_at: new Date(), status: 'vaulted' as const, source: 'pack' as const })),
        );
        await service.grantAchievements(cust, 'open_a');
        let [state] = await service.listAchievementMemberStates({ customer_id: cust });
        expect(Number(state.peak_cases_opened)).toBe(25);

        // selling back does not reduce cases_opened (source still 'pack'); peak holds
        await service.grantAchievements(cust, 'open_b');
        [state] = await service.listAchievementMemberStates({ customer_id: cust });
        expect(Number(state.peak_cases_opened)).toBe(25);
        const grants = await service.listAchievementGrants({ customer_id: cust });
        expect(grants.map((g) => g.achievement_key).sort()).toEqual(['cases_opened_1', 'cases_opened_25']);
      });
    });
  },
});
