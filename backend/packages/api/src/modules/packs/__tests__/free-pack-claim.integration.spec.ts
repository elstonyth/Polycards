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
import TicketSpin from '../models/ticket-spin';
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
import VisitorSignal from '../models/visitor-signal';
import { FREE_PACK_HOUSEHOLD_MESSAGE } from '../free-pack';

jest.setTimeout(300 * 1000);

moduleIntegrationTestRunner<PacksModuleService>({
  moduleName: PACKS_MODULE,
  resolve: path.resolve(__dirname, '../../..', 'modules/packs'),
  moduleModels: [
    Pack,
    Card,
    PackOdds,
    Pull,
    TicketSpin,
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
    VisitorSignal,
  ],
  testSuite: ({ MikroOrmWrapper, service }) => {
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

      it('one welcome pack per person or household: a second account on a claimed browser is refused (ADR 0018)', async () => {
        const em = MikroOrmWrapper.forkManager();
        await em.execute(
          'CREATE TABLE IF NOT EXISTS customer (id text primary key, created_at timestamptz not null default now(), deleted_at timestamptz null)',
        );
        await em.execute(
          "INSERT INTO customer (id, created_at) VALUES ('cus_hh_a', now() - interval '2 days'), ('cus_hh_b', now() - interval '1 day'), ('cus_hh_c', now()) ON CONFLICT DO NOTHING",
        );
        const shared = '11111111-2222-4333-8444-555555555555';
        await service.recordVisitorSignal({ customerId: 'cus_hh_a', ip: '10.0.0.1', deviceId: shared });
        await service.recordVisitorSignal({ customerId: 'cus_hh_b', ip: '10.0.0.2', deviceId: shared });
        for (const id of ['cus_hh_a', 'cus_hh_b', 'cus_hh_c']) await service.markFreePackAvailable(id);

        // No one on the browser has claimed yet, so the later account may.
        expect(await service.sharedBrowserAccounts('cus_hh_b')).toEqual([
          { customer_id: 'cus_hh_a', earlier: true, welcome_claimed: false },
        ]);
        expect(await service.claimFreePack('cus_hh_b')).toBe(true);
        // Now the earlier account on the same browser is refused, and keeps its pack waiting.
        await expect(service.claimFreePack('cus_hh_a')).rejects.toThrow(FREE_PACK_HOUSEHOLD_MESSAGE);
        const [a] = await service.listCustomerAccountStates({ customer_id: 'cus_hh_a' }, { take: 1 });
        expect(a.free_pack_claimed_at).toBeNull();
        // The browser on this request counts even before it was ever recorded.
        await expect(service.claimFreePack('cus_hh_c', shared)).rejects.toThrow(FREE_PACK_HOUSEHOLD_MESSAGE);
        // A different browser, or none, is not matched.
        expect(await service.claimFreePack('cus_hh_c', '99999999-2222-4333-8444-555555555555')).toBe(true);
      });

      it('shared-device hold: earlier unverified accounts on the browser hold; a verified pair and a player group do not (ADR 0018)', async () => {
        const em = MikroOrmWrapper.forkManager();
        await em.execute(
          'CREATE TABLE IF NOT EXISTS customer (id text primary key, created_at timestamptz not null default now(), deleted_at timestamptz null)',
        );
        await em.execute('ALTER TABLE customer ADD COLUMN IF NOT EXISTS metadata jsonb');
        await em.execute('ALTER TABLE customer ADD COLUMN IF NOT EXISTS updated_at timestamptz');
        await em.execute(
          'CREATE TABLE IF NOT EXISTS customer_group (id text primary key, name text, metadata jsonb, created_at timestamptz default now(), deleted_at timestamptz)',
        );
        await em.execute(
          'CREATE TABLE IF NOT EXISTS customer_group_customer (customer_id text, customer_group_id text, deleted_at timestamptz)',
        );
        await em.execute(
          "INSERT INTO customer (id, created_at) VALUES ('cus_dv_a', now() - interval '3 days'), ('cus_dv_b', now() - interval '2 days'), ('cus_dv_c', now() - interval '1 day') ON CONFLICT DO NOTHING",
        );
        const shared = '22222222-2222-4333-8444-555555555555';
        for (const id of ['cus_dv_a', 'cus_dv_b', 'cus_dv_c']) {
          await service.recordVisitorSignal({ customerId: id, ip: '10.0.1.1', deviceId: shared });
        }
        // The first account on the browser is never held; later ones are, by every earlier one.
        expect(await service.sharedDeviceHoldPeers('cus_dv_a')).toEqual([]);
        expect((await service.sharedDeviceHoldPeers('cus_dv_c')).sort()).toEqual(['cus_dv_a', 'cus_dv_b']);

        await service.verifyDevicePeers({ customerId: 'cus_dv_c', peerIds: ['cus_dv_a'], adminId: 'user_test', reason: 'one household' });
        expect(await service.sharedDeviceHoldPeers('cus_dv_c')).toEqual(['cus_dv_b']);
        const audits = await service.listAdminActionAudits({ entity_id: 'cus_dv_c', action: 'edit' });
        expect(audits).toHaveLength(1);

        // A real player group (partners, house) is exempt, as from the no-top-up gate.
        await em.execute("INSERT INTO customer_group (id, name) VALUES ('cg_dv', 'Partners') ON CONFLICT DO NOTHING");
        await em.execute("INSERT INTO customer_group_customer (customer_id, customer_group_id) VALUES ('cus_dv_b', 'cg_dv')");
        expect(await service.sharedDeviceHoldPeers('cus_dv_b')).toEqual([]);
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

      it('hasPaidOpen: a row labelled bonus before the label was retired still counts', async () => {
        await service.createPulls([
          {
            customer_id: 'cus_5',
            pack_id: 'bronze-pack',
            card_id: 'c1',
            rolled_at: new Date(),
            source: 'bonus',
          },
        ]);
        expect(await service.hasPaidOpen('cus_5')).toBe(true);
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
