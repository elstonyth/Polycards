/**
 * Daily task claims — the free welcome pull's sell/deliver LOCK
 * (integration:modules)
 *
 * Owner, 2026-10-23: a card a DAILY task pays out (its card reward, or the
 * card its free rip lands) cannot be sold or delivered until the customer's
 * first PAID open — the same rule as the free welcome pull, with the same
 * refusal copy. Weekly and achievement rewards still sell at once. The lock is
 * COMPUTED (lockedPullIds: task_claim.claim_ref → task_definition.kind), never
 * stored, so it also covers daily cards already in vaults, and the first paid
 * open lifts it with zero writes.
 *
 * Asserted contracts:
 *  - buybackPullWorkflow refuses a daily card with FREE_PULL_LOCKED_MESSAGE
 *    (vaulted, uncredited) and sells it once a paid open exists; a weekly card
 *    sells with no paid open at all. POST /store/vault/buyback-batch reports
 *    the daily card with the same copy and still sells the weekly one.
 *  - recordRewardWithdrawal refuses a daily card with the same copy, and ships
 *    it once a paid open exists.
 *  - GET /store/vault reports the daily card locked with no quote, the weekly
 *    one sellable.
 *  - POST /store/tasks/claims/:id/spin answers a daily free rip locked with no
 *    quote, a weekly one sellable with a live quote.
 *  - GET /admin/customers/:id/pulls quotes no payable-now amount for a locked
 *    daily card, so the desk sees the customer's answer.
 *
 * Harness: the free-pack-route.integration.spec.ts rig — a real DB-backed
 * PacksModuleService in a medusa container beside inert fakes, route handlers
 * called directly with a mock req/res. Claims go through the real
 * checkInDaily + claimTask path, so claim_ref is stamped exactly as in prod.
 *
 * Test-runner caveat: the runner rebuilds schema from moduleModels and DROPs
 * it around every `it`, so each test seeds everything it asserts on.
 */

import path from 'path';
import { moduleIntegrationTestRunner } from '@medusajs/test-utils';
import { MedusaError, Modules } from '@medusajs/framework/utils';
import { createMedusaContainer } from '@medusajs/framework/utils';
import { asValue } from 'awilix';
import { PACKS_MODULE } from '../index';
import type PacksModuleService from '../service';
import { FREE_PULL_LOCKED_MESSAGE } from '../free-pack';
import { UNQUOTED_BUYBACK } from '../buyback-rate';
import { clearFxDisplayCache } from '../pricing';
import { buybackPullWorkflow } from '../../../workflows/buyback-pull';
import Pack from '../models/pack';
import Card from '../models/card';
import PackOdds from '../models/pack-odds';
import Pull from '../models/pull';
import TicketSpin from '../models/ticket-spin';
import CreditTransaction from '../models/credit-transaction';
import LedgerEntry from '../models/ledger-entry';
import LedgerSequence from '../models/ledger-sequence';
import FxRate from '../models/fx-rate';
import DeliveryOrder from '../models/delivery-order';
import DeliveryOrderItem from '../models/delivery-order-item';
import VipLevel from '../models/vip-level';
import RewardsSettings from '../models/rewards-settings';
import CustomerAccountState from '../models/customer-account-state';
import AdminActionAudit from '../models/admin-action-audit';
import VipMemberState from '../models/vip-member-state';
import VipRewardGrant from '../models/vip-reward-grant';
import NotificationRead from '../models/notification-read';
import LosslessSchedule from '../models/lossless-schedule';
import TaskDefinition from '../models/task-definition';
import TaskClaim from '../models/task-claim';
import DailyCheckin from '../models/daily-checkin';
import { PixelPokemon } from '../models/pixel-pokemon';

import { GET as vaultGET } from '../../../api/store/vault/route';
import { POST as spinPOST } from '../../../api/store/tasks/claims/[claimId]/spin/route';
import { GET as adminPullsGET } from '../../../api/admin/customers/[id]/pulls/route';
import { POST as buybackBatchPOST } from '../../../api/store/vault/buyback-batch/route';

jest.setTimeout(300 * 1000);

const PAID_SLUG = 'bronze-pack';
const ADDRESS = {
  first_name: 'Ada',
  last_name: 'Lovelace',
  address_1: '1 Analytical Engine Way',
  city: 'Kuala Lumpur',
  postal_code: '50000',
  country_code: 'my',
};

moduleIntegrationTestRunner<PacksModuleService>({
  moduleName: PACKS_MODULE,
  resolve: path.resolve(__dirname, '../../..', 'modules/packs'),
  moduleModels: [
    LosslessSchedule,
    Pack,
    Card,
    PackOdds,
    Pull,
    TicketSpin,
    CreditTransaction,
    LedgerEntry,
    LedgerSequence,
    FxRate,
    DeliveryOrder,
    DeliveryOrderItem,
    VipLevel,
    RewardsSettings,
    CustomerAccountState,
    AdminActionAudit,
    VipMemberState,
    VipRewardGrant,
    NotificationRead,
    TaskDefinition,
    TaskClaim,
    DailyCheckin,
    PixelPokemon,
  ],
  testSuite: ({ service }) => {
    const customerId = 'cus_daily_lock';

    const container = (() => {
      const c = createMedusaContainer();
      c.register({
        [PACKS_MODULE]: asValue(service),
        event_bus: asValue({
          emit: async () => undefined,
          releaseGroupedEvents: async () => undefined,
          clearGroupedEvents: async () => undefined,
        }),
        [Modules.NOTIFICATION]: asValue({
          createNotifications: async (n: Record<string, unknown>) => [n],
        }),
        [Modules.CUSTOMER]: asValue({ listCustomerGroups: async () => [] }),
        logger: asValue({
          info: () => undefined,
          warn: () => undefined,
          error: () => undefined,
          debug: () => undefined,
        }),
        query: asValue({ graph: async () => ({ data: [] }) }),
        inventory: asValue({
          adjustInventory: async () => {
            throw new MedusaError(MedusaError.Types.NOT_FOUND, 'untracked');
          },
        }),
      });
      return c;
    })();

    type ResCapture = { status?: number; body?: any };
    const makeReqRes = (
      params: Record<string, string> = {},
      query: Record<string, string> = {},
      body: unknown = undefined,
    ) => {
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
        auth_context: { actor_id: customerId },
        params,
        query,
        body,
        scope: container,
      };
      return { req: req as any, res: res as any, captured };
    };

    const vaultItem = async (pullId: string) => {
      const { req, res, captured } = makeReqRes();
      await vaultGET(req, res);
      return (captured.body.items as any[]).find((i) => i.pull_id === pullId);
    };

    const adminQuote = async (pullId: string) => {
      const { req, res, captured } = makeReqRes({ id: customerId });
      await adminPullsGET(req, res);
      return (captured.body.items as any[]).find((i) => i.id === pullId)
        ?.quote;
    };

    const sellBatch = async (pullIds: string[]) => {
      const { req, res, captured } = makeReqRes({}, {}, { pull_ids: pullIds });
      await buybackBatchPOST(req, res);
      return captured.body;
    };

    const spin = async (claimId: string) => {
      const { req, res, captured } = makeReqRes({ claimId });
      await spinPOST(req, res);
      return captured.body;
    };

    // The workflow orchestrator re-wraps a step error into something jest does
    // not recognize as an Error, so failures are asserted on the message (the
    // free-pull-lock.integration.spec.ts shape).
    const failureMessage = async (run: Promise<unknown>): Promise<string> => {
      const outcome = await run.then(
        () => null,
        (e: unknown) => e as { message?: string },
      );
      expect(outcome).not.toBeNull();
      return outcome?.message ?? String(outcome);
    };

    const sell = (pullId: string) =>
      buybackPullWorkflow(container).run({
        input: { pull_id: pullId, customer_id: customerId },
      });

    // A check-in task of the given cadence, claimed through the real path:
    // check in, complete, claim. One check-in a day is idempotent, so a daily
    // and a weekly task can both be claimed in one test.
    type Kind = 'daily' | 'weekly' | 'achievement';
    const claim = async (
      kind: Kind,
      reward: Record<string, unknown>,
    ) => {
      await service.checkInDaily({ customerId });
      const [task] = await service.createTaskDefinitions([
        {
          kind,
          title: `${kind} check-in`,
          requirement: { type: 'checkin_days', days: 1 },
          reward,
          active: true,
          sort: 0,
        },
      ]);
      const claimed = await service.claimTask({ customerId, taskId: task.id });
      if (!claimed.claimed) throw new Error(`claim refused: ${claimed.reason}`);
      return claimed;
    };

    const claimCard = async (kind: Kind) =>
      (await claim(kind, { type: 'card', card_handle: 'card-1' }))
        .ref as string;

    // The customer's first PAID open — what lifts the lock.
    const payForAPack = () =>
      service.createPulls([
        {
          customer_id: customerId,
          pack_id: PAID_SLUG,
          card_id: 'card-1',
          rolled_at: new Date(),
          status: 'vaulted' as const,
          source: 'pack' as const,
        },
      ]);

    const pullById = async (id: string) => {
      const [p] = await service.listPulls({ id }, { take: 1 });
      return p!;
    };

    beforeEach(async () => {
      clearFxDisplayCache(); // 30s display cache outlives the fixtures
      await service.createFxRates([
        { pair: 'USD_MYR', rate: 4, source: 'test', manual_override: false },
      ]);
      await service.createPacks([
        {
          slug: PAID_SLUG,
          title: 'Bronze Pack',
          category: 'standard',
          price: 10,
          image: '/bronze.webp',
          status: 'active',
        },
      ]);
      await service.createCards([
        {
          handle: 'card-1',
          name: 'Card One',
          set: 'Base',
          grader: 'PSA',
          grade: '10',
          market_value: 20,
          image: 'card-1.png',
        },
      ]);
      await service.createPackOdds([
        {
          pack_id: PAID_SLUG,
          card_id: 'card-1',
          rarity: 'Common',
          weight: 1_000_000,
        },
      ]);
    });

    describe('lockedPullIds', () => {
      it('locks a daily card until the first paid open, never a weekly or achievement one', async () => {
        const daily = await claimCard('daily');
        const weekly = await claimCard('weekly');
        const achievement = await claimCard('achievement');
        const pulls = [
          { id: daily, source: 'reward' },
          { id: weekly, source: 'reward' },
          { id: achievement, source: 'reward' },
        ];

        expect([...(await service.lockedPullIds(customerId, pulls))]).toEqual([
          daily,
        ]);

        await payForAPack();

        expect((await service.lockedPullIds(customerId, pulls)).size).toBe(0);
      });
    });

    describe('buyback', () => {
      it('refuses a daily card with the free-pack copy, then sells it after a paid open', async () => {
        const daily = await claimCard('daily');

        expect(await failureMessage(sell(daily))).toContain(
          FREE_PULL_LOCKED_MESSAGE,
        );
        expect((await pullById(daily)).status).toBe('vaulted');
        expect(
          await service.listCreditTransactions({ pull_id: daily }),
        ).toEqual([]);

        await payForAPack();
        const { result } = await sell(daily);

        expect(result.amount).toBeGreaterThan(0);
        expect((await pullById(daily)).status).toBe('bought_back');
      });

      it('batch: reports the daily card with the free-pack copy and sells the weekly one', async () => {
        const daily = await claimCard('daily');
        const weekly = await claimCard('weekly');

        const body = await sellBatch([daily, weekly]);

        expect(body).toMatchObject({ sold: 1, failed: 1 });
        expect(body.results).toEqual(
          expect.arrayContaining([
            { pull_id: daily, ok: false, error: FREE_PULL_LOCKED_MESSAGE },
            expect.objectContaining({ pull_id: weekly, ok: true }),
          ]),
        );
        expect((await pullById(daily)).status).toBe('vaulted');
        expect((await pullById(weekly)).status).toBe('bought_back');
      });

      it('still sells a weekly card with no paid open at all', async () => {
        const weekly = await claimCard('weekly');

        const { result } = await sell(weekly);

        expect(result.amount).toBeGreaterThan(0);
        expect((await pullById(weekly)).status).toBe('bought_back');
      });
    });

    describe('delivery (recordRewardWithdrawal)', () => {
      it('refuses a daily card with the same copy, then ships it after a paid open', async () => {
        // One real top-up (the no-top-up gate runs first) that also covers the
        // zone's shipping fee.
        await service.mutateCreditAtomic({
          customerId,
          amount: 50,
          reason: 'topup',
          idempotencyReference: `seed-topup:${customerId}`,
        });
        const daily = await claimCard('daily');

        await expect(
          service.recordRewardWithdrawal(customerId, daily, ADDRESS),
        ).rejects.toThrow(FREE_PULL_LOCKED_MESSAGE);
        expect((await pullById(daily)).status).toBe('vaulted');

        await payForAPack();
        const shipped = await service.recordRewardWithdrawal(
          customerId,
          daily,
          ADDRESS,
        );

        expect(shipped.status).toBe('requested');
        expect((await pullById(daily)).status).toBe('delivering');
      });
    });

    describe('GET /store/vault', () => {
      it('shows a daily card locked with no quote and a weekly card sellable', async () => {
        const daily = await claimCard('daily');
        const weekly = await claimCard('weekly');

        const lockedItem = await vaultItem(daily);
        expect(lockedItem).toMatchObject({ locked: true, sellable: false });
        expect(lockedItem.buyback.amount).toBe(UNQUOTED_BUYBACK.amount);
        const open = await vaultItem(weekly);
        expect(open).toMatchObject({ locked: false, sellable: true });
        expect(open.buyback.amount).toBeGreaterThan(0);

        await payForAPack();

        expect(await vaultItem(daily)).toMatchObject({
          locked: false,
          sellable: true,
        });
      });
    });

    describe('GET /admin/customers/:id/pulls', () => {
      it('quotes nothing payable for a locked daily card, a price for a weekly one', async () => {
        const daily = await claimCard('daily');
        const weekly = await claimCard('weekly');

        expect(await adminQuote(daily)).toBeNull();
        expect((await adminQuote(weekly))?.amount).toBeGreaterThan(0);

        await payForAPack();

        expect((await adminQuote(daily))?.amount).toBeGreaterThan(0);
      });
    });

    describe('POST /store/tasks/claims/:claimId/spin', () => {
      it('spins a daily free rip locked with no quote, a weekly one sellable', async () => {
        const dailyRip = await claim('daily', {
          type: 'pack',
          pack_id: PAID_SLUG,
        });
        const weeklyRip = await claim('weekly', {
          type: 'pack',
          pack_id: PAID_SLUG,
        });

        const locked = await spin(dailyRip.claimId);
        expect(locked).toMatchObject({
          redeemed: true,
          locked: true,
          sellable: false,
          buyback: UNQUOTED_BUYBACK,
        });
        // The spun card is the claim's pull, so the vault agrees.
        expect((await vaultItem(locked.pullId)).locked).toBe(true);

        const open = await spin(weeklyRip.claimId);
        expect(open).toMatchObject({
          redeemed: true,
          locked: false,
          sellable: true,
        });
        expect(open.buyback.amount).toBeGreaterThan(0);
      });
    });
  },
});
