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
import { taskWeekFor } from '../referral';

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
      // No stock hook: the route takes the unit AFTER this commits (a take
      // inside the transaction outlived a rolled-back claim).
      const claim = await service.claimTask({
        customerId: 'cus_t3',
        taskId: id,
      });
      expect(claim.claimed).toBe(true);
      const rewardPulls = await service.listPulls({
        customer_id: 'cus_t3',
        source: 'reward',
      });
      expect(rewardPulls).toHaveLength(1);
      expect(rewardPulls[0].status).toBe('vaulted');
      // The minted pull is what the route's post-commit take is keyed off.
      expect(claim.claimed && claim.ref).toBe(rewardPulls[0].id);
      // Achievements are once EVER — a re-claim is refused.
      expect(
        await service.claimTask({ customerId: 'cus_t3', taskId: id }),
      ).toEqual({ claimed: false, reason: 'already_claimed' });
    });

    // A pack reward is a free RIP: the claim grants an entitlement and the
    // slot's Spin button spends it. These three tests are the whole contract,
    // and the second is the one that matters — it is what makes closing the tab
    // mid-spin safe.
    describe('pack reward — claim grants, spin spends', () => {
      const seedPackAndCard = async () => {
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
      };

      const makeTask = async (title: string, sort: number) =>
        (
          await service.saveTaskDefinition({
            kind: 'weekly',
            title,
            requirement: { type: 'checkin_days', days: 1 },
            reward: { type: 'pack', pack_id: 'bronze' },
            active: true,
            sort,
            adminId: 'admin_1',
            reason: 'seed',
          })
        ).id;

      it('claiming records an unspent entitlement and vaults NOTHING', async () => {
        await seedPackAndCard();
        await service.checkInDaily({ customerId: 'cus_t4' });
        const id = await makeTask('Check in for a free rip', 2);

        const claim = await service.claimTask({
          customerId: 'cus_t4',
          taskId: id,
        });
        expect(claim).toMatchObject({ claimed: true, ref: null });
        // The rip has not happened yet — that is the player's to do.
        expect(
          await service.listPulls({ customer_id: 'cus_t4', source: 'reward' }),
        ).toHaveLength(0);
        const [row] = await service.listTaskClaims({ customer_id: 'cus_t4' });
        expect(row.claim_ref).toBeNull();
        // And the hub advertises it, so a player who never reaches the slot
        // can come back to it.
        const hub = await service.taskHubFor({ customerId: 'cus_t4' });
        expect(hub.pending_spins).toHaveLength(1);
        // Both surfaces NAME the pack — the player must know which pack the
        // free rip is, not just that there is one.
        expect(hub.pending_spins[0]).toMatchObject({
          pack_id: 'bronze',
          pack_title: 'Bronze Pack',
        });
        expect(hub.tasks.find((t) => t.id === id)?.reward).toEqual({
          type: 'pack',
          pack_id: 'bronze',
          pack_title: 'Bronze Pack',
        });
      });

      it('spinning rolls exactly once, however many times it is retried', async () => {
        await seedPackAndCard();
        await service.checkInDaily({ customerId: 'cus_t5' });
        const id = await makeTask('Free rip retry', 3);
        const claimed = await service.claimTask({
          customerId: 'cus_t5',
          taskId: id,
        });
        const claimId = (claimed as { claimId: string }).claimId;

        let rolls = 0;
        const rollPack = async (packId: string) => {
          expect(packId).toBe('bronze');
          rolls++;
          return { handle: 'rolled-card' };
        };
        let takes = 0;
        const decrementStock = async () => {
          takes++;
          return true; // a tracked unit really came off the shelf
        };

        const first = await service.redeemTaskPackClaim({
          customerId: 'cus_t5',
          claimId,
          rollPack,
          decrementStock,
        });
        expect(first).toMatchObject({ redeemed: true });
        const pulls = await service.listPulls({
          customer_id: 'cus_t5',
          source: 'reward',
        });
        expect(pulls).toHaveLength(1);
        expect(pulls[0].pack_id).toBe('bronze');
        expect(pulls[0].card_id).toBe('rolled-card');
        // The taken unit is earmarked on the pull, so selling the card back
        // restores it (buyback-pull.ts restores earmarked pulls only).
        expect(takes).toBe(1);
        expect(pulls[0].stock_earmarked).toBe(true);

        // THE POINT. A retry — a double-tap, a lost response, a reconnect after
        // the tab was closed mid-spin — must not mint a second card, and must
        // hand back the pull so the player can still be shown what they won.
        const again = await service.redeemTaskPackClaim({
          customerId: 'cus_t5',
          claimId,
          rollPack,
        });
        expect(again).toMatchObject({
          redeemed: false,
          reason: 'already_redeemed',
          pullId: (first as { pullId: string }).pullId,
        });
        expect(rolls).toBe(1);
        expect(
          await service.listPulls({ customer_id: 'cus_t5', source: 'reward' }),
        ).toHaveLength(1);
        // Spent, so the hub stops offering it.
        const hub = await service.taskHubFor({ customerId: 'cus_t5' });
        expect(hub.pending_spins).toHaveLength(0);
      });

      // The rollover case. A weekly claim's period_key is ITS week's Monday, so
      // once Monday 00:00 MYT passes it falls out of the hub's period-scoped
      // claims read. The entitlement must not fall out with it — /task is the
      // only surface that lists a free rip, and the unique claim index means the
      // player can never re-earn that week's task.
      it('an unspent free rip survives the week rollover', async () => {
        await seedPackAndCard();
        await service.checkInDaily({ customerId: 'cus_t7' });
        const id = await makeTask('Free rip rollover', 5);
        const claimed = await service.claimTask({
          customerId: 'cus_t7',
          taskId: id,
        });
        const claimId = (claimed as { claimId: string }).claimId;

        const thisWeek = await service.taskHubFor({ customerId: 'cus_t7' });
        expect(thisWeek.pending_spins).toHaveLength(1);

        // One hour PAST the next Monday 00:00 MYT anchor — comfortably inside
        // the following task week, so no boundary-inclusivity detail decides
        // this test.
        const nextWeek = new Date(
          taskWeekFor(new Date()).endUtcExcl.getTime() + 60 * 60 * 1000,
        );
        const hub = await service.taskHubFor({
          customerId: 'cus_t7',
          now: nextWeek,
        });
        // Proof we actually crossed the anchor rather than trusting arithmetic.
        expect(hub.week_start).not.toBe(thisWeek.week_start);
        expect(hub.pending_spins).toHaveLength(1);
        expect(hub.pending_spins[0]).toMatchObject({
          claim_id: claimId,
          pack_id: 'bronze',
        });
        // And the other half of the contract: the weekly task itself IS
        // claimable again, so the `claimed` set must have stayed period-scoped.
        expect(hub.tasks.find((t) => t.id === id)?.claimed).toBe(false);
      });

      it("refuses to spend someone else's entitlement", async () => {
        await seedPackAndCard();
        await service.checkInDaily({ customerId: 'cus_t6' });
        const id = await makeTask('Free rip theft', 4);
        const claimed = await service.claimTask({
          customerId: 'cus_t6',
          taskId: id,
        });
        const claimId = (claimed as { claimId: string }).claimId;
        let rolls = 0;
        expect(
          await service.redeemTaskPackClaim({
            customerId: 'cus_thief',
            claimId,
            rollPack: async () => {
              rolls++;
              return { handle: 'rolled-card' };
            },
          }),
        ).toEqual({ redeemed: false, reason: 'not_found' });
        // Ownership is checked BEFORE the roll — nothing was minted.
        expect(rolls).toBe(0);
      });
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

    it('a closed window declines with its own reason, not "not completed"', async () => {
      // The window can close between the page load and the tap. Answering
      // 'not_completed' over a finished task is the most confusing thing this
      // endpoint could say, so window_closed is a distinct case.
      const { id } = await service.saveTaskDefinition({
        kind: 'achievement',
        title: 'Vault one card',
        requirement: { type: 'vault_count', count: 1 },
        reward: { type: 'credit', amount_myr: 1 },
        active: true,
        sort: 0,
        startsAt: null,
        endsAt: new Date('2020-01-01T00:00:00Z'),
        adminId: 'admin_1',
        reason: 'window test',
      });
      expect(
        await service.claimTask({ customerId: 'cus_win', taskId: id }),
      ).toEqual({ claimed: false, reason: 'window_closed' });

      // A task id that does not exist is still 'not_found' — the two must not
      // collapse into one message.
      expect(
        await service.claimTask({
          customerId: 'cus_win',
          taskId: 'task_ghost',
        }),
      ).toEqual({ claimed: false, reason: 'not_found' });
    });
  },
});
