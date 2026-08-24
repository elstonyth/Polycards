/**
 * Free welcome pack — open-pack workflow end-to-end (integration:modules)
 *
 * Task 4 of spec docs/superpowers/specs/2026-08-14-free-welcome-pack-design.md:
 * a free open consumes the account's one-time claim INSTEAD of charging credit.
 *
 * Asserted contracts:
 *  - Free open: claim consumed, nothing debited, pull is source='free' with a
 *    NULL recorded_value_usd (free pulls must never move the boards).
 *  - ...but its SP ledger row still books the card's draw-time vault_delta:
 *    the vault liability is real even when the pull records no board value.
 *  - A FROZEN account (manual or auto) is refused, claim left unspent — the
 *    gate paid opens get from settleOpen, which a price-0 open never reaches.
 *  - A SECOND free open is refused — the claim is one-shot.
 *  - An unstamped account cannot open the free pack at all.
 *  - A paid open is byte-identical to before: source='pack', recorded value
 *    stamped, credit debited.
 *  - Compensation: a failure AFTER the claim was won hands the claim back.
 *
 * Harness note (deviation from the task brief): the brief points at
 * close-instant / recorded-pull-value as an "openPackWorkflow end-to-end"
 * precedent — neither runs a workflow, they only call the service. The only
 * workflow-running spec is workflows/__tests__/vip-settle-step.unit.spec.ts,
 * which runs the REAL workflow against a mocked container. This spec is the
 * hybrid the task actually needs: moduleIntegrationTestRunner for a real
 * DB-backed PacksModuleService (so the atomic claim UPDATE and the pull rows
 * are real), registered into a medusa container alongside vip-settle-step's
 * fakes for the modules the open saga touches but this feature does not
 * (events, notifications, customer groups, inventory).
 *
 * Test-runner caveat: moduleIntegrationTestRunner rebuilds schema from
 * moduleModels, not from the hand-written migrations — CHECK constraints are
 * absent, so every seeded field is set explicitly and only runtime logic is
 * asserted here. It also DROPs and recreates the schema around every `it`
 * (setupDatabase/clearDatabase), so each test seeds and drives the whole
 * sequence it asserts on — the brief's "second open" case consumes its own
 * first claim rather than leaning on the previous test.
 */

import path from 'path';
import { moduleIntegrationTestRunner } from '@medusajs/test-utils';
import { MedusaError, Modules } from '@medusajs/framework/utils';
import { createMedusaContainer } from '@medusajs/framework/utils';
import { asValue } from 'awilix';
import { PACKS_MODULE } from '../index';
import type PacksModuleService from '../service';
import { displayMarketPrice, resolveFxRate } from '../pricing';
import { openPackWorkflow } from '../../../workflows/open-pack';
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
import RewardDraw from '../models/reward-draw';

jest.setTimeout(300 * 1000);

const FREE_SLUG = 'free-welcome';
const PAID_SLUG = 'bronze-pack';
const PAID_PRICE = 10;

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
    RewardDraw,
  ],
  testSuite: ({ service }) => {
    // `service` is a forwarding proxy onto the module instance the runner
    // re-creates for every test, so jest.spyOn cannot patch it (its get trap
    // always answers from the live instance). Overriding one method means
    // wrapping it in a second proxy — that is how the failure-after-claim test
    // makes a LATER step throw.
    const packsWith = (overrides: Record<string, unknown>) =>
      new Proxy(service as unknown as Record<string, unknown>, {
        get: (target, prop) =>
          prop in overrides ? overrides[prop as string] : target[prop as string],
      });

    // The open saga touches modules this feature has nothing to do with: the
    // real packs service, inert fakes for the rest (vip-settle-step.unit
    // .spec.ts's container, minus its fake packs service).
    const buildContainer = (packs: unknown = service) => {
      const container = createMedusaContainer();
      container.register({
        [PACKS_MODULE]: asValue(packs),
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
      return container;
    };

    const container = buildContainer();

    const open = (
      packId: string,
      customerId: string,
      scope = container,
    ) =>
      openPackWorkflow(scope).run({
        input: { pack_id: packId, customer_id: customerId },
      });

    // A failed open rejects with the orchestrator's re-wrapped step error,
    // which jest does not recognize as an Error (.rejects.toThrow reports
    // "did not throw" on it) — so assert the failure and its message directly.
    const openFails = async (
      packId: string,
      customerId: string,
      scope = container,
    ): Promise<string> => {
      const outcome = await open(packId, customerId, scope).then(
        () => null,
        (e: unknown) => e as { message?: string },
      );
      expect(outcome).not.toBeNull(); // the open must NOT succeed
      return outcome?.message ?? String(outcome);
    };

    const latestPull = async (customerId: string, packId: string) => {
      const [pull] = await service.listPulls(
        { customer_id: customerId, pack_id: packId },
        { take: 1, order: { rolled_at: 'DESC' } },
      );
      return pull!;
    };

    const claimState = async (customerId: string) => {
      const [s] = await service.listCustomerAccountStates(
        { customer_id: customerId },
        { take: 1 },
      );
      return s;
    };

    // The SP ledger row paired with an open (recordPullsWithLedger keys it on
    // the open_id the pull carries).
    const spRow = async (openId: string) => {
      const [row] = await service.listLedgerEntries(
        { type: 'SP', ref_id: openId },
        { take: 1 },
      );
      return row;
    };

    // Freeze the account the two ways settleOpen's gate treats alike: the admin
    // hold (cause='manual') and the negative-balance clawback hold
    // (cause='auto'). markFreePackAvailable has already created the row.
    const freeze = async (customerId: string, cause: 'manual' | 'auto') => {
      if (cause === 'manual') {
        await service.setManualFreeze({
          customerId,
          adminId: 'usr_admin_qa',
          reason: 'fraud review',
        });
        return;
      }
      const state = (await claimState(customerId))!;
      await service.updateCustomerAccountStates({
        selector: { id: state.id },
        data: { frozen: true, cause: 'auto', frozen_at: new Date() },
      });
    };

    const fund = (customerId: string, amount: number) =>
      service.createCreditTransactions([
        {
          customer_id: customerId,
          amount,
          reason: 'topup' as const,
          pull_id: null,
        },
      ]);

    // One free_welcome pack (price 0) + one normal paid pack, each with a
    // single-card odds table so the draw is deterministic. Declared AFTER the
    // runner's own beforeEach (which recreates the schema), so it re-seeds the
    // fresh database each test.
    beforeEach(async () => {
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
          price: PAID_PRICE,
          image: '/bronze.webp',
          status: 'active',
        },
      ]);
      await service.createCards([
        {
          handle: 'card-free',
          name: 'Free Card',
          set: 'Base',
          grader: 'PSA',
          grade: '10',
          market_value: 20,
          image: 'free-card.png',
        },
        {
          handle: 'card-paid',
          name: 'Paid Card',
          set: 'Base',
          grader: 'PSA',
          grade: '10',
          market_value: 20,
          image: 'paid-card.png',
        },
      ]);
      await service.createPackOdds([
        {
          pack_id: FREE_SLUG,
          card_id: 'card-free',
          rarity: 'Common',
          weight: 1_000_000,
        },
        {
          pack_id: PAID_SLUG,
          card_id: 'card-paid',
          rarity: 'Common',
          weight: 1_000_000,
        },
      ]);
    });

    describe('free welcome pack open', () => {
      const customerId = 'cus_fp_player';
      const strangerId = 'cus_fp_stranger';

      it('free open: claims once, writes source=free with null recorded value, charges nothing', async () => {
        await service.markFreePackAvailable(customerId);
        // Funded, so a debit COULD happen — proving the free open skips it.
        await fund(customerId, 100);
        const before = await service.creditBalance(customerId);

        const { result } = await open(FREE_SLUG, customerId);

        expect(result.price).toBe(0);
        expect(await service.creditBalance(customerId)).toBe(before);
        const pull = await latestPull(customerId, FREE_SLUG);
        expect(pull.source).toBe('free');
        expect(pull.recorded_value_usd).toBeNull();
        expect(
          (await claimState(customerId))!.free_pack_claimed_at,
        ).toBeTruthy();
      });

      // Vault liability is the ONE number a free open still has to book: the
      // card enters the vault, and the eventual sell/delivery subtracts its
      // full value, so an SP row carrying vault_delta 0 (what a NULL
      // recorded_value_usd derives) would drift cumulative liability down
      // forever. The pull row stays NULL — boards clean, ledger honest.
      it('free open books the real vault_delta while the pull records no value', async () => {
        await service.markFreePackAvailable(customerId);
        await open(FREE_SLUG, customerId);

        const pull = await latestPull(customerId, FREE_SLUG);
        expect(pull.recorded_value_usd).toBeNull();

        const [card] = await service.listCards(
          { handle: 'card-free' },
          { take: 1 },
        );
        // roll-pack's draw-time snapshot: FMV x the card's multiplier, shown in
        // MYR at the display rate (recordPullsWithLedger's own conversion).
        const expected = displayMarketPrice(
          Number(card!.market_value) * Number(card!.market_multiplier),
          await resolveFxRate(service),
          1,
        );
        expect(expected).toBeGreaterThan(0); // the assertion below must bite
        const sp = await spRow(pull.open_id!);
        expect(sp).toBeTruthy();
        expect(Number(sp!.vault_delta)).toBe(expected);
        // Wallet side is untouched — nothing was charged.
        expect(Number(sp!.wallet_delta)).toBe(0);
      });

      // The free open never reaches settleOpen (price 0 short-circuits the
      // charge step), so the freeze gate paid opens get for free has to live in
      // the claim step — and it must run BEFORE the claim, or a refused open
      // burns the one-time pack. Both causes, because settleOpen's gate is
      // any-cause (isFrozen), not manual-only (assertNotFrozen).
      it.each(['manual', 'auto'] as const)(
        'a %s-frozen account cannot open the free pack, and the claim survives',
        async (cause) => {
          await service.markFreePackAvailable(customerId);
          await freeze(customerId, cause);

          expect(await openFails(FREE_SLUG, customerId)).toMatch(/frozen/i);

          const state = (await claimState(customerId))!;
          expect(state.free_pack_claimed_at).toBeNull();
          expect(state.free_pack_available_at).toBeTruthy();
          expect(
            await service.listPulls({ customer_id: customerId }),
          ).toHaveLength(0);

          // Unspent means genuinely re-claimable, not merely blanked.
          await service.updateCustomerAccountStates({
            selector: { id: state.id },
            data: { frozen: false, unfrozen_at: new Date() },
          });
          const { result } = await open(FREE_SLUG, customerId);
          expect(result.price).toBe(0);
          expect((await latestPull(customerId, FREE_SLUG)).source).toBe('free');
        },
      );

      it('second free open is refused (claim consumed)', async () => {
        await service.markFreePackAvailable(customerId);
        await open(FREE_SLUG, customerId);

        expect(await openFails(FREE_SLUG, customerId)).toMatch(
          /already claimed|not available/i,
        );
        // Exactly one free pull, ever.
        expect(
          await service.listPulls({ customer_id: customerId, source: 'free' }),
        ).toHaveLength(1);
      });

      it('unstamped account cannot open the free pack', async () => {
        expect(await openFails(FREE_SLUG, strangerId)).toMatch(
          /not available/i,
        );
        expect(
          await service.listPulls({ customer_id: strangerId }),
        ).toHaveLength(0);
      });

      it('paid open is untouched: source=pack, recorded value present, charged', async () => {
        await fund(customerId, 100);
        const before = await service.creditBalance(customerId);

        const { result } = await open(PAID_SLUG, customerId);

        expect(result.price).toBe(PAID_PRICE);
        expect(await service.creditBalance(customerId)).toBe(
          before - PAID_PRICE,
        );
        const pull = await latestPull(customerId, PAID_SLUG);
        expect(pull.source).toBe('pack');
        expect(Number(pull.recorded_value_usd)).toBeGreaterThan(0);
      });

      // The reason the claim is consumed INSIDE the workflow: a failure after
      // the claim was won must hand the free pack back, and only an in-saga
      // step compensates.
      it('a failure after the claim rolls it back (compensation)', async () => {
        await service.markFreePackAvailable(customerId);
        const brokenRecord = buildContainer(
          packsWith({
            recordPullsWithLedger: async () => {
              throw new Error('record exploded');
            },
          }),
        );

        expect(await openFails(FREE_SLUG, customerId, brokenRecord)).toMatch(
          /record exploded/,
        );

        expect((await claimState(customerId))!.free_pack_claimed_at).toBeNull();
        // And the claim is genuinely re-usable, not just blanked.
        const { result } = await open(FREE_SLUG, customerId);
        expect(result.price).toBe(0);
        expect((await latestPull(customerId, FREE_SLUG)).source).toBe('free');
      });

      // The other half of that property: the no-op branch carries NO
      // compensate payload, so a failed PAID open must not hand back a free
      // pack the customer already spent.
      it('a failed PAID open does not resurrect a spent claim', async () => {
        await service.markFreePackAvailable(customerId);
        await open(FREE_SLUG, customerId); // spend the claim for real
        const claimedAt = (await claimState(customerId))!.free_pack_claimed_at;
        expect(claimedAt).toBeTruthy();
        await fund(customerId, 100);

        const brokenRecord = buildContainer(
          packsWith({
            recordPullsWithLedger: async () => {
              throw new Error('record exploded');
            },
          }),
        );
        expect(
          await openFails(PAID_SLUG, customerId, brokenRecord),
        ).toMatch(/record exploded/);

        expect((await claimState(customerId))!.free_pack_claimed_at).toEqual(
          claimedAt,
        );
      });
    });
  },
});
