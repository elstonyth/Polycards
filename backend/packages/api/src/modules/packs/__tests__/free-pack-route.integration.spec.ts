/**
 * Free welcome pack — STOREFRONT READ SURFACES (integration:modules)
 *
 * Task 7 of spec docs/superpowers/specs/2026-08-14-free-welcome-pack-design.md.
 * The free pack is hidden from the public catalog, so these three reads are the
 * only way a customer ever learns it exists, opens it, and sees it locked:
 *
 *  - GET /store/free-pack — per-customer eligibility (feeds the floating badge).
 *  - GET /store/vault — every item carries `source` + `locked`; a LOCKED free
 *    pull must quote NO sellable amount (it would 400 on sell — the carried
 *    finding from the Task 6 review).
 *  - POST /store/packs/:slug/open — a free open answers `free: true` with the
 *    unquoted buyback, while still showing the card's value.
 *
 * Harness: the free-pull-lock.integration.spec.ts rig — moduleIntegrationTestRunner
 * for a real DB-backed PacksModuleService, registered into a medusa container
 * beside inert fakes for the modules the open saga touches but this feature does
 * not. Route handlers are imported and CALLED DIRECTLY with a mock req/res (the
 * rewards-routes.integration.spec.ts pattern): there is no HTTP server here, and
 * the auth/rate-limit middleware registered in api/middlewares.ts is out of
 * scope — the actor id arrives via auth_context, never the body.
 *
 * Test-runner caveat: the runner rebuilds schema from moduleModels (no CHECK
 * constraints) and DROPs it around every `it`, so each test seeds what it asserts.
 */

import path from 'path';
import { moduleIntegrationTestRunner } from '@medusajs/test-utils';
import { MedusaError, Modules } from '@medusajs/framework/utils';
import { createMedusaContainer } from '@medusajs/framework/utils';
import { asValue } from 'awilix';
import { PACKS_MODULE } from '../index';
import type PacksModuleService from '../service';
import { UNQUOTED_BUYBACK } from '../buyback-rate';
import { clearFxDisplayCache } from '../pricing';
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
import ReferralRelationship from '../models/referral-relationship';
import Commission from '../models/commission';
import CustomerAccountState from '../models/customer-account-state';
import AdminActionAudit from '../models/admin-action-audit';
import VipMemberState from '../models/vip-member-state';
import VipRewardGrant from '../models/vip-reward-grant';
import NotificationRead from '../models/notification-read';
import RewardDraw from '../models/reward-draw';

import { GET as freePackGET } from '../../../api/store/free-pack/route';
import { GET as vaultGET } from '../../../api/store/vault/route';
import { POST as openPOST } from '../../../api/store/packs/[slug]/open/route';

jest.setTimeout(300 * 1000);

const FREE_SLUG = 'free-welcome';
const PAID_SLUG = 'bronze-pack';
const FREE_IMAGE = '/free.webp';

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
    const customerId = 'cus_free_reader';

    // The open saga touches modules this feature has nothing to do with: the
    // real packs service, inert fakes for the rest.
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
    const makeReqRes = (opts: {
      customerId?: string;
      params?: Record<string, string>;
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
        auth_context: { actor_id: opts.customerId ?? customerId },
        params: opts.params ?? {},
        scope: container,
      };
      return { req: req as any, res: res as any, captured };
    };

    const eligibility = async (who = customerId) => {
      const { req, res, captured } = makeReqRes({ customerId: who });
      await freePackGET(req, res);
      return captured.body;
    };

    const vaultItems = async (who = customerId) => {
      const { req, res, captured } = makeReqRes({ customerId: who });
      await vaultGET(req, res);
      return captured.body.items as any[];
    };

    const openPack = async (slug: string, who = customerId) => {
      const { req, res, captured } = makeReqRes({
        customerId: who,
        params: { slug },
      });
      await openPOST(req, res);
      return captured.body;
    };

    const seedPull = async (source: 'free' | 'pack') => {
      const [pull] = await service.createPulls([
        {
          customer_id: customerId,
          pack_id: source === 'free' ? FREE_SLUG : PAID_SLUG,
          card_id: 'card-1',
          rolled_at: new Date(),
          // Past the 30s instant window — the flat vault rate, like a real
          // sell from the vault page.
          instant_closed_at: new Date(),
          status: 'vaulted' as const,
          source,
        },
      ]);
      return pull.id;
    };

    const fund = (amount: number) =>
      service.createCreditTransactions([
        { customer_id: customerId, amount, reason: 'topup' as const, pull_id: null },
      ]);

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
          image: FREE_IMAGE,
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
      await service.createPackOdds([
        {
          pack_id: FREE_SLUG,
          card_id: 'card-1',
          rarity: 'Common',
          weight: 1_000_000,
        },
        {
          pack_id: PAID_SLUG,
          card_id: 'card-1',
          rarity: 'Common',
          weight: 1_000_000,
        },
      ]);
    });

    describe('GET /store/free-pack', () => {
      it('stamped + unclaimed + an active free pack → eligible, with slug and image', async () => {
        await service.markFreePackAvailable(customerId);

        expect(await eligibility()).toEqual({
          eligible: true,
          slug: FREE_SLUG,
          image: FREE_IMAGE,
        });
      });

      it('claimed → not eligible', async () => {
        await service.markFreePackAvailable(customerId);
        expect(await service.claimFreePack(customerId)).toBe(true);

        expect(await eligibility()).toEqual({
          eligible: false,
          slug: null,
          image: null,
        });
      });

      it('no ACTIVE free pack → not eligible even when stamped', async () => {
        await service.markFreePackAvailable(customerId);
        await service.updatePacks({
          selector: { slug: FREE_SLUG },
          data: { status: 'draft' },
        });

        expect(await eligibility()).toEqual({
          eligible: false,
          slug: null,
          image: null,
        });
      });

      it('an unstamped account is never eligible', async () => {
        expect(await eligibility('cus_stranger')).toEqual({
          eligible: false,
          slug: null,
          image: null,
        });
      });
    });

    describe('GET /store/vault', () => {
      it('marks the free pull locked and quotes NOTHING sellable until a paid open exists', async () => {
        const freeId = await seedPull('free');

        const [item] = await vaultItems();

        expect(item.pull_id).toBe(freeId);
        expect(item.source).toBe('free');
        expect(item.locked).toBe(true);
        // The carried finding: a locked pull must NOT advertise a price whose
        // sell 400s. Same unquoted block the open route degrades to — the item
        // still renders (the storefront drops a row with no finite
        // buyback.percent), it just offers nothing payable.
        expect(item.buyback.amount).toBe(0);
        expect(item.buyback.vault_amount).toBe(0);
        expect(Number.isFinite(item.buyback.percent)).toBe(true);
        // ...but `firm` stays the REAL FX firmness (true on this firm seed),
        // NOT UNQUOTED_BUYBACK's false. The vault aggregates firmness across
        // ALL items (`items.every(i => i.buyback.firm)`), so a false here would
        // blame the lock on a pricing outage for the whole vault and block the
        // customer's other, sellable cards. The lock rides on `locked` alone.
        expect(item.buyback.firm).toBe(true);
        expect(item.buyback).toEqual({ ...UNQUOTED_BUYBACK, firm: true });
        // The card's VALUE still shows — only the sell offer is withheld.
        expect(item.card.marketPriceMyr).toBeGreaterThan(0);
      });

      it('unlocks the free pull — with a live quote — once a paid open exists', async () => {
        const freeId = await seedPull('free');
        await seedPull('pack'); // the first PAID open lifts the lock

        const items = await vaultItems();
        const free = items.find((i) => i.pull_id === freeId);

        expect(free.source).toBe('free');
        expect(free.locked).toBe(false);
        expect(free.buyback.amount).toBeGreaterThan(0);
        expect(free.buyback.firm).toBe(true);
      });

      it('a normal pack pull is source=pack and never locked', async () => {
        const packId = await seedPull('pack');

        const [item] = await vaultItems();

        expect(item.pull_id).toBe(packId);
        expect(item.source).toBe('pack');
        expect(item.locked).toBe(false);
        expect(item.buyback.amount).toBeGreaterThan(0);
      });
    });

    describe('POST /store/packs/:slug/open', () => {
      it('a free open answers free:true with no sellable quote, keeping the card value', async () => {
        await service.markFreePackAvailable(customerId);

        const body = await openPack(FREE_SLUG);

        expect(body.free).toBe(true);
        expect(body.price).toBe(0);
        expect(body.buyback).toEqual(UNQUOTED_BUYBACK);
        // The reveal still shows what the card is worth.
        expect(body.card.marketPriceMyr).toBeGreaterThan(0);
      });

      it('a paid open is unchanged: a live quote and no free flag', async () => {
        await fund(100);

        const body = await openPack(PAID_SLUG);

        expect(body.free).toBeFalsy();
        expect(body.buyback.amount).toBeGreaterThan(0);
        expect(body.buyback.firm).toBe(true);
        expect(body.card.marketPriceMyr).toBeGreaterThan(0);
      });
    });
  },
});
