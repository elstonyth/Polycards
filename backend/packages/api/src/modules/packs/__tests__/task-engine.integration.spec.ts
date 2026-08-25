import path from 'path';
import { moduleIntegrationTestRunner } from '@medusajs/test-utils';
import { PACKS_MODULE } from '../index';
import type PacksModuleService from '../service';
import TaskDefinition from '../models/task-definition';
import TaskClaim from '../models/task-claim';
import DailyCheckin from '../models/daily-checkin';
import CreditTransaction from '../models/credit-transaction';
import CustomerAccountState from '../models/customer-account-state';
import VipMemberState from '../models/vip-member-state';
import VipLevel from '../models/vip-level';
import AdminActionAudit from '../models/admin-action-audit';
import Pull from '../models/pull';
import Card from '../models/card';
import Pack from '../models/pack';
import PackOdds from '../models/pack-odds';

jest.setTimeout(300 * 1000);

moduleIntegrationTestRunner<PacksModuleService>({
  moduleName: PACKS_MODULE,
  resolve: path.resolve(__dirname, '../../..', 'modules/packs'),
  moduleModels: [
    TaskDefinition,
    TaskClaim,
    DailyCheckin,
    CreditTransaction,
    CustomerAccountState,
    VipMemberState,
    VipLevel,
    AdminActionAudit,
    Pull,
    Card,
    Pack,
    PackOdds,
  ],
  testSuite: ({ service }) => {
    it('check-in is once per MYT day', async () => {
      const first = await service.checkInDaily({ customerId: 'cus_t1' });
      expect(first.checked).toBe(true);
      const again = await service.checkInDaily({ customerId: 'cus_t1' });
      expect(again.checked).toBe(false);
      expect(again.day).toBe(first.day);
    });

    it('weekly check-in task: progress counts the week, claim pays credit once', async () => {
      const { id } = await service.saveTaskDefinition({
        kind: 'weekly',
        title: 'Check in 1 day',
        requirement: { type: 'checkin_days', days: 1 },
        reward: { type: 'credit', amount_myr: 2.5 },
        active: true,
        sort: 0,
        adminId: 'admin_1',
        reason: 'seed',
      });

      // Before any check-in: visible, incomplete, unclaimable.
      let hub = await service.taskHubFor({ customerId: 'cus_t2' });
      expect(hub.tasks).toHaveLength(1);
      expect(hub.tasks[0].progress).toEqual({
        current: 0,
        target: 1,
        completed: false,
      });
      expect(
        await service.claimTask({ customerId: 'cus_t2', taskId: id }),
      ).toEqual({ claimed: false, reason: 'not_completed' });

      await service.checkInDaily({ customerId: 'cus_t2' });
      hub = await service.taskHubFor({ customerId: 'cus_t2' });
      expect(hub.tasks[0].progress.completed).toBe(true);

      const claim = await service.claimTask({
        customerId: 'cus_t2',
        taskId: id,
      });
      expect(claim).toMatchObject({
        claimed: true,
        reward: { type: 'credit', amount_myr: 2.5 },
      });
      const txns = await service.listCreditTransactions({
        customer_id: 'cus_t2',
        reason: 'reward_credit',
      });
      expect(txns).toHaveLength(1);
      expect(Number(txns[0].amount)).toBe(2.5);

      // Second claim in the same week is refused and pays nothing more.
      expect(
        await service.claimTask({ customerId: 'cus_t2', taskId: id }),
      ).toEqual({ claimed: false, reason: 'already_claimed' });
      expect(
        await service.listCreditTransactions({
          customer_id: 'cus_t2',
          reason: 'reward_credit',
        }),
      ).toHaveLength(1);

      // The hub now reports it claimed.
      hub = await service.taskHubFor({ customerId: 'cus_t2' });
      expect(hub.tasks[0].claimed).toBe(true);
    });

    it('achievement vault task grants a CARD into the vault', async () => {
      await service.createCards([
        {
          handle: 'reward-card',
          name: 'Reward Card',
          set: 'S',
          grader: 'PSA',
          grade: '9',
          market_value: 10,
          image: 'x.png',
        },
      ]);
      // Two vaulted pulls make the requirement (vault 2) complete.
      await service.createPulls([
        {
          customer_id: 'cus_t3',
          pack_id: 'p',
          card_id: 'reward-card',
          rolled_at: new Date(),
        },
        {
          customer_id: 'cus_t3',
          pack_id: 'p',
          card_id: 'reward-card',
          rolled_at: new Date(),
        },
      ]);
      const { id } = await service.saveTaskDefinition({
        kind: 'achievement',
        title: 'Vault 2 cards',
        requirement: { type: 'vault_count', count: 2 },
        reward: { type: 'card', card_handle: 'reward-card' },
        active: true,
        sort: 1,
        adminId: 'admin_1',
        reason: 'seed',
      });
      const decremented: string[] = [];
      const claim = await service.claimTask({
        customerId: 'cus_t3',
        taskId: id,
        decrementStock: async (h) => {
          decremented.push(h);
          return true;
        },
      });
      expect(claim.claimed).toBe(true);
      expect(decremented).toEqual(['reward-card']);
      const rewardPulls = await service.listPulls({
        customer_id: 'cus_t3',
        source: 'reward',
      });
      expect(rewardPulls).toHaveLength(1);
      expect(rewardPulls[0].status).toBe('vaulted');
      // Achievements are once EVER — a re-claim is refused.
      expect(
        await service.claimTask({ customerId: 'cus_t3', taskId: id }),
      ).toEqual({ claimed: false, reason: 'already_claimed' });
    });

    it('pack reward rolls via the injected helper and vaults the result', async () => {
      await service.createCards([
        {
          handle: 'rolled-card',
          name: 'Rolled',
          set: 'S',
          grader: 'PSA',
          grade: '8',
          market_value: 5,
          image: 'y.png',
        },
      ]);
      await service.createPacks([
        {
          slug: 'bronze',
          title: 'Bronze Pack',
          category: 'standard',
          price: 300,
          image: '/x.webp',
          status: 'active',
        },
      ]);
      await service.checkInDaily({ customerId: 'cus_t4' });
      const { id } = await service.saveTaskDefinition({
        kind: 'weekly',
        title: 'Check in for a free rip',
        requirement: { type: 'checkin_days', days: 1 },
        reward: { type: 'pack', pack_id: 'bronze' },
        active: true,
        sort: 2,
        adminId: 'admin_1',
        reason: 'seed',
      });
      const claim = await service.claimTask({
        customerId: 'cus_t4',
        taskId: id,
        rollPack: async (packId) => {
          expect(packId).toBe('bronze');
          return { handle: 'rolled-card' };
        },
      });
      expect(claim.claimed).toBe(true);
      const pulls = await service.listPulls({
        customer_id: 'cus_t4',
        source: 'reward',
      });
      expect(pulls).toHaveLength(1);
      expect(pulls[0].pack_id).toBe('bronze');
      expect(pulls[0].card_id).toBe('rolled-card');
    });

    it('vault achievements are a lifetime high-water — selling a card cannot un-complete them', async () => {
      await service.createCards([
        {
          handle: 'hw-card',
          name: 'HW',
          set: 'S',
          grader: 'PSA',
          grade: '9',
          market_value: 10,
          image: 'x.png',
        },
      ]);
      const [p1] = await service.createPulls([
        {
          customer_id: 'cus_hw',
          pack_id: 'p',
          card_id: 'hw-card',
          rolled_at: new Date(),
        },
      ]);
      const { id } = await service.saveTaskDefinition({
        kind: 'achievement',
        title: 'Vault your first card',
        requirement: { type: 'vault_count', count: 1 },
        reward: { type: 'credit', amount_myr: 1 },
        active: true,
        sort: 0,
        adminId: 'admin_1',
        reason: 'seed',
      });
      // Sell the card BEFORE claiming — progress must not drop.
      await service.updatePulls({
        selector: { id: p1.id },
        data: { status: 'bought_back' as const },
      });
      const hub = await service.taskHubFor({ customerId: 'cus_hw' });
      expect(hub.tasks.find((t) => t.id === id)!.progress.completed).toBe(true);
      const claim = await service.claimTask({
        customerId: 'cus_hw',
        taskId: id,
      });
      expect(claim.claimed).toBe(true);
    });

    it('a retired task stays claimable for someone who completed it', async () => {
      await service.checkInDaily({ customerId: 'cus_ret' });
      const { id } = await service.saveTaskDefinition({
        kind: 'weekly',
        title: 'Check in once',
        requirement: { type: 'checkin_days', days: 1 },
        reward: { type: 'credit', amount_myr: 1 },
        active: true,
        sort: 0,
        adminId: 'admin_1',
        reason: 'seed',
      });
      await service.saveTaskDefinition({
        id,
        kind: 'weekly',
        title: 'Check in once',
        requirement: { type: 'checkin_days', days: 1 },
        reward: { type: 'credit', amount_myr: 1 },
        active: false,
        sort: 0,
        adminId: 'admin_1',
        reason: 'retire',
      });
      const claim = await service.claimTask({
        customerId: 'cus_ret',
        taskId: id,
      });
      expect(claim.claimed).toBe(true);
    });

    it('save-time guards: missing reward targets and kind flips are rejected', async () => {
      await expect(
        service.saveTaskDefinition({
          kind: 'achievement',
          title: 'Bad card',
          requirement: { type: 'vault_count', count: 1 },
          reward: { type: 'card', card_handle: 'no-such-card' },
          active: true,
          sort: 0,
          adminId: 'admin_1',
          reason: 'x',
        }),
      ).rejects.toThrow(/does not exist/i);
      await expect(
        service.saveTaskDefinition({
          kind: 'weekly',
          title: 'Bad pack',
          requirement: { type: 'checkin_days', days: 1 },
          reward: { type: 'pack', pack_id: 'no-such-pack' },
          active: true,
          sort: 0,
          adminId: 'admin_1',
          reason: 'x',
        }),
      ).rejects.toThrow(/does not exist/i);
      const { id } = await service.saveTaskDefinition({
        kind: 'weekly',
        title: 'Kind-locked',
        requirement: { type: 'checkin_days', days: 1 },
        reward: { type: 'credit', amount_myr: 1 },
        active: true,
        sort: 0,
        adminId: 'admin_1',
        reason: 'seed',
      });
      await expect(
        service.saveTaskDefinition({
          id,
          kind: 'achievement',
          title: 'Kind-locked',
          requirement: { type: 'reach_level', level: 2 },
          reward: { type: 'credit', amount_myr: 1 },
          active: true,
          sort: 0,
          adminId: 'admin_1',
          reason: 'flip',
        }),
      ).rejects.toThrow(/kind cannot change/i);
    });

    it('saveTaskDefinition validates and audits; inactive tasks vanish from the hub', async () => {
      await expect(
        service.saveTaskDefinition({
          kind: 'weekly',
          title: 'bad',
          requirement: { type: 'reach_level', level: 5 }, // lifetime fact on weekly
          reward: { type: 'credit', amount_myr: 1 },
          active: true,
          sort: 0,
          adminId: 'admin_1',
          reason: 'x',
        }),
      ).rejects.toThrow(/weekly/i);

      const { id } = await service.saveTaskDefinition({
        kind: 'achievement',
        title: 'Reach level 5',
        requirement: { type: 'reach_level', level: 5 },
        reward: { type: 'credit', amount_myr: 1 },
        active: true,
        sort: 0,
        adminId: 'admin_1',
        reason: 'seed',
      });
      await service.saveTaskDefinition({
        id,
        kind: 'achievement',
        title: 'Reach level 5',
        requirement: { type: 'reach_level', level: 5 },
        reward: { type: 'credit', amount_myr: 1 },
        active: false,
        sort: 0,
        adminId: 'admin_1',
        reason: 'retire',
      });
      const hub = await service.taskHubFor({ customerId: 'cus_t5' });
      expect(hub.tasks).toHaveLength(0);
      const audits = await service.listAdminActionAudits({
        entity_type: 'task_definition',
        entity_id: id,
      });
      expect(audits.map((a) => a.action).sort()).toEqual(['create', 'edit']);
    });
  },
});
