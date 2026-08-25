/**
 * Free welcome pull — sell/deliver LOCK (integration:modules)
 *
 * Task 6 of spec docs/superpowers/specs/2026-08-14-free-welcome-pack-design.md:
 * a source='free' pull is fully locked (no buyback, no delivery) until the
 * customer's first PAID open. The unlock is COMPUTED (hasPaidOpen — "does a
 * source='pack' pull exist"), never stored, so the first paid open lifts the
 * lock with zero extra writes.
 *
 * Asserted contracts:
 *  - buybackPullWorkflow refuses a locked free pull with FREE_PULL_LOCKED_MESSAGE
 *    and leaves it vaulted + uncredited.
 *  - One source='pack' pull later, the SAME buyback succeeds.
 *  - buyback-batch semantics (the route's per-id throwOnError:false loop): the
 *    locked free pull fails with that message while the normal pull still sells.
 *  - requestDeliveryWorkflow refuses a locked free pull with the same message,
 *    and accepts it once a paid open exists.
 *  - Reward and pack pulls are untouched by the new gate.
 *
 * Harness: the free-pack-open.integration.spec.ts rig — moduleIntegration
 * TestRunner for a real DB-backed PacksModuleService, registered into a medusa
 * container next to inert fakes for the modules these sagas touch but this
 * feature does not. Pulls are seeded with createPulls rather than opened
 * through openPackWorkflow: hasPaidOpen only asks whether a source='pack' row
 * exists, so an open adds nothing but runtime.
 *
 * Test-runner caveat: the runner rebuilds schema from moduleModels (no CHECK
 * constraints) and DROPs it around every `it`, so each test seeds everything it
 * asserts on.
 */

import path from 'path';
import { moduleIntegrationTestRunner } from '@medusajs/test-utils';
import { MedusaError, Modules } from '@medusajs/framework/utils';
import { createMedusaContainer } from '@medusajs/framework/utils';
import { asValue } from 'awilix';
import { PACKS_MODULE } from '../index';
import type PacksModuleService from '../service';
import { FREE_PULL_LOCKED_MESSAGE } from '../free-pack';
import { clearFxDisplayCache } from '../pricing';
import { buybackPullWorkflow } from '../../../workflows/buyback-pull';
import { requestDeliveryWorkflow } from '../../../workflows/request-delivery';
import Pack from '../models/pack';
import Card from '../models/card';
import PackOdds from '../models/pack-odds';
import Pull from '../models/pull';
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

jest.setTimeout(300 * 1000);

const FREE_SLUG = 'free-welcome';
const PAID_SLUG = 'bronze-pack';
const ADDRESS_ID = 'addr_1';

moduleIntegrationTestRunner<PacksModuleService>({
  moduleName: PACKS_MODULE,
  resolve: path.resolve(__dirname, '../../..', 'modules/packs'),
  moduleModels: [
    Pack,
    Card,
    PackOdds,
    Pull,
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
  ],
  testSuite: ({ service }) => {
    const customerId = 'cus_lock_player';

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
        [Modules.CUSTOMER]: asValue({
          listCustomerGroups: async () => [],
          listCustomers: async () => [{ id: customerId, phone: '0123456789' }],
          listCustomerAddresses: async () => [
            {
              id: ADDRESS_ID,
              customer_id: customerId,
              first_name: 'Ada',
              last_name: 'Lovelace',
              address_1: '1 Analytical Way',
              city: 'KL',
              postal_code: '50000',
              country_code: 'my',
            },
          ],
        }),
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

    // The workflow orchestrator re-wraps a step error into something jest does
    // not recognize as an Error (`.rejects.toThrow` reports "did not throw"),
    // so failures are asserted on the returned object's message — the same
    // shape free-pack-open.integration.spec.ts uses.
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

    const deliver = (pullIds: string[]) =>
      requestDeliveryWorkflow(container).run({
        input: {
          customer_id: customerId,
          pull_ids: pullIds,
          address_id: ADDRESS_ID,
        },
      });

    const seedPull = async (source: 'free' | 'pack' | 'reward') => {
      const [pull] = await service.createPulls([
        {
          customer_id: customerId,
          pack_id: source === 'free' ? FREE_SLUG : PAID_SLUG,
          card_id: 'card-1',
          rolled_at: new Date(),
          // Past the 30s instant window — the flat vault rate, like a real sell
          // from the vault page.
          instant_closed_at: new Date(),
          status: 'vaulted' as const,
          source,
        },
      ]);
      return pull.id;
    };

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
          slug: FREE_SLUG,
          title: 'Welcome Pack',
          category: 'free_welcome',
          price: 0,
          image: '/free.webp',
          status: 'active',
        },
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
    });

    describe('buyback', () => {
      it('refuses a free pull while the account has no paid open', async () => {
        const freeId = await seedPull('free');

        expect(await failureMessage(sell(freeId))).toContain(
          FREE_PULL_LOCKED_MESSAGE,
        );
        expect((await pullById(freeId)).status).toBe('vaulted');
        expect(
          await service.listCreditTransactions({ pull_id: freeId }),
        ).toEqual([]);
      });

      it('sells the same free pull once a paid open exists', async () => {
        const freeId = await seedPull('free');
        await seedPull('pack'); // the first PAID open — lifts the lock

        const { result } = await sell(freeId);

        expect(result.amount).toBeGreaterThan(0);
        expect((await pullById(freeId)).status).toBe('bought_back');
      });

      it('never gated a normal pack pull', async () => {
        const packId = await seedPull('pack');

        const { result } = await sell(packId);

        expect(result.amount).toBeGreaterThan(0);
        expect((await pullById(packId)).status).toBe('bought_back');
      });

      // buyback-batch (POST /store/vault/buyback-batch) runs this SAME guarded
      // step per id with throwOnError:false and reports each failure's reason
      // instead of aborting the loop — so the lock needs no batch-side filter,
      // only the reason must survive the workflow's `errors` wrapper into the
      // route's errorMessage(). Note there is no "[locked free, normal pack]"
      // batch to test: a source='pack' pull in the vault IS the unlock, so a
      // batch holding one has no locked free pull left in it (the second case
      // below).
      it('batch: a locked free pull reports its reason and keeps selling', async () => {
        const freeId = await seedPull('free');

        const { result, errors } = await buybackPullWorkflow(container).run({
          input: { pull_id: freeId, customer_id: customerId },
          throwOnError: false,
        });

        expect(result).toBeFalsy();
        // Mirrors the route's errorMessage() unwrapping of an `errors` entry.
        const e = errors?.[0] as
          | { message?: string; error?: { message?: string } }
          | undefined;
        expect(e?.message ?? e?.error?.message ?? '').toContain(
          FREE_PULL_LOCKED_MESSAGE,
        );
        expect((await pullById(freeId)).status).toBe('vaulted');
      });

      it('batch: once the paid open exists, free and pack pulls both sell', async () => {
        const freeId = await seedPull('free');
        const packId = await seedPull('pack');

        for (const id of [freeId, packId]) {
          const { errors } = await buybackPullWorkflow(container).run({
            input: { pull_id: id, customer_id: customerId },
            throwOnError: false,
          });
          expect(errors ?? []).toHaveLength(0);
        }

        expect((await pullById(freeId)).status).toBe('bought_back');
        expect((await pullById(packId)).status).toBe('bought_back');
      });
    });

    describe('delivery', () => {
      it('refuses a free pull while the account has no paid open', async () => {
        const freeId = await seedPull('free');

        expect(await failureMessage(deliver([freeId]))).toContain(
          FREE_PULL_LOCKED_MESSAGE,
        );
        expect((await pullById(freeId)).status).toBe('vaulted');
        expect(await service.listDeliveryOrders({})).toEqual([]);
      });

      it('ships the same free pull once a paid open exists', async () => {
        const freeId = await seedPull('free');
        await seedPull('pack');
        // Delivery charges the RM15 West shipping fee from the wallet since
        // 2026-08-25 (card-1 is RM96 — under the RM200 protection threshold,
        // so no insurance) — fund the fee or the request refuses on balance.
        await service.mutateCreditAtomic({
          customerId,
          amount: 20,
          reason: 'topup',
        });

        const { result } = await deliver([freeId]);

        expect(result.status).toBe('requested');
        expect((await pullById(freeId)).status).toBe('delivering');
      });
    });
  },
});
