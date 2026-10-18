import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { clearPackListCache } from '../../src/api/store/packs/route';
import { clearPackDetailCache } from '../../src/api/store/packs/[slug]/route';
import { clearLosslessDisplayMemo } from '../../src/api/store/packs/lossless-display';
import { mintSuperAdmin, postStoreCustomer, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

// Lossless Mode (spec 2026-10-17): while an admin-scheduled window is live, a
// pack's INSTANT sell pays 100% instead of its configured rate. The stored
// buyback_percent never changes, the vault (flat) rate never changes, and the
// decision is taken at the pull's rolled_at so the quote and the credit agree.
//
// Fixture Value: FMV $50 (raw USD) × FX 4.0 × markup 1.2 = RM 240. The pack's
// own instant rate is 90, so without a window the instant sell and the flat
// sell pay the same RM 216 and only a live window can move the number.
const PACK_SLUG = 'ls-pack';
const CARD_HANDLE = 'ls-card';
const PASSWORD = 'ls-test-password-1';
const ADMIN = 'user_lossless_test';
const PACK_PERCENT = 90;
const LOSSLESS_AMOUNT = 240; // 100% × 240
const PACK_AMOUNT = 216; // 90% × 240

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('Lossless Mode pricing', () => {
      let storeHeaders: Record<string, string>;
      let packs: PacksModuleService;

      beforeEach(async () => {
        // Module state outlives the per-test database reset: a catalog cached
        // by an earlier test would otherwise be served to this one.
        clearPackListCache();
        clearPackDetailCache();
        clearLosslessDisplayMemo();

        const container = getContainer();
        const key = await container.resolve(Modules.API_KEY).createApiKeys({
          title: 'lossless-schedule-test',
          type: 'publishable',
          created_by: 'lossless-schedule-test',
        });
        storeHeaders = { 'x-publishable-api-key': key.token };

        packs = container.resolve<PacksModuleService>(PACKS_MODULE);
        await packs.createPacks([
          {
            slug: PACK_SLUG,
            title: 'Lossless Test Pack',
            category: 'pokemon',
            price: 10,
            image: '/cdn/ls-pack.webp',
            buyback_percent: PACK_PERCENT,
          },
        ]);
        await packs.createCards([
          {
            handle: CARD_HANDLE,
            name: 'Lossless Test Card PSA 10',
            set: 'Test Set',
            grader: 'PSA',
            grade: '10',
            market_value: 50,
            market_multiplier: 1.2,
            image: '/cdn/ls-card.webp',
          },
        ]);
        await packs.createPackOdds([
          {
            pack_id: PACK_SLUG,
            card_id: CARD_HANDLE,
            weight: 100,
            locked: false,
            rarity: 'Rare' as const,
          },
        ]);
        // The sell refuses without a firm FX rate; pin it so amounts are exact.
        await packs.createFxRates([
          {
            pair: 'USD_MYR',
            rate: 4,
            source: 'test',
            manual_override: true,
            manual_rate: 4,
          },
        ]);
      });

      const get = (path: string, headers: Record<string, string>) =>
        unwrapResponse(api.get(path, { headers }));

      const authed = (token: string): Record<string, string> => ({
        ...storeHeaders,
        authorization: `Bearer ${token}`,
      });

      const registerCustomer = async (
        email: string,
      ): Promise<{ token: string; customerId: string }> => {
        const reg = await api.post('/auth/customer/emailpass/register', {
          email,
          password: PASSWORD,
        });
        await postStoreCustomer(
          api,
          getContainer(),
          { email },
          {
            headers: {
              ...storeHeaders,
              authorization: `Bearer ${reg.data.token}`,
            },
          },
        );
        const login = await api.post('/auth/customer/emailpass', {
          email,
          password: PASSWORD,
        });
        const token: string = login.data.token;
        const me = await get('/store/customers/me', authed(token));
        expect(me.status).toBe(200);
        return { token, customerId: me.data.customer.id };
      };

      // A vaulted pull straight from the module, the way the vault suite mints
      // prizes: pricing reads only the row, so no open is needed.
      const mintPull = async (
        customerId: string,
        overrides: {
          rolled_at?: Date;
          revealed_at?: Date | null;
          instant_closed_at?: Date | null;
          source?: 'pack' | 'reward';
        } = {},
      ): Promise<string> => {
        const now = new Date();
        const [pull] = await packs.createPulls([
          {
            customer_id: customerId,
            pack_id: PACK_SLUG,
            card_id: CARD_HANDLE,
            order_id: null,
            rolled_at: now,
            revealed_at: now,
            status: 'vaulted' as const,
            source: 'pack' as const,
            ...overrides,
          },
        ]);
        return pull.id;
      };

      const vaultQuote = async (token: string, pullId: string) => {
        const vault = await get('/store/vault', authed(token));
        expect(vault.status).toBe(200);
        const row = vault.data.items.find(
          (i: { pull_id: string }) => i.pull_id === pullId,
        );
        expect(row).toBeDefined();
        return row.buyback as { percent: number; amount: number };
      };

      const sell = async (token: string, pullId: string) => {
        const res = await unwrapResponse(
          api.post(`/store/vault/${pullId}/buyback`, {}, {
            headers: authed(token),
          }),
        );
        expect(res.status).toBe(200);
        return res.data as { percent: number; amount: number };
      };

      const storeBadges = async () => {
        const list = await get('/store/packs', storeHeaders);
        const detail = await get(`/store/packs/${PACK_SLUG}`, storeHeaders);
        expect(list.status).toBe(200);
        expect(detail.status).toBe(200);
        return {
          list: list.data.packs.find(
            (p: { slug: string }) => p.slug === PACK_SLUG,
          ).buyback_percent as number,
          detail: detail.data.pack.buyback_percent as number,
        };
      };

      afterEach(() => jest.restoreAllMocks());

      const liveAllWindow = () =>
        packs.createLosslessSchedule({
          startsAt: new Date(Date.now() - 60_000),
          endsAt: new Date(Date.now() + 60 * 60_000),
          packSlugs: null,
          adminId: ADMIN,
          reason: 'lossless http test',
        });

      it('no window: the badges, the quote and an instant sell all stay at the pack rate', async () => {
        const { token, customerId } = await registerCustomer('ls-none@test.dev');
        expect(await storeBadges()).toEqual({
          list: PACK_PERCENT,
          detail: PACK_PERCENT,
        });

        const pullId = await mintPull(customerId);
        expect(await vaultQuote(token, pullId)).toMatchObject({
          percent: PACK_PERCENT,
          amount: PACK_AMOUNT,
        });
        expect(await sell(token, pullId)).toMatchObject({
          percent: PACK_PERCENT,
          amount: PACK_AMOUNT,
        });
      });

      it('live "all" window: store badges show 100, admin keeps 90, a fresh pull quotes and credits 100%', async () => {
        const { token, customerId } = await registerCustomer('ls-live@test.dev');
        await liveAllWindow();

        expect(await storeBadges()).toEqual({ list: 100, detail: 100 });

        // Admin reads the CONFIGURED rate for the edit form — never overlaid —
        // while its payable-now quote matches what the customer is offered.
        const adminToken = await mintSuperAdmin(
          getContainer(),
          api,
          'ls-admin@test.dev',
          PASSWORD,
        );
        const adminHeaders = { authorization: `Bearer ${adminToken}` };
        const adminPack = await get(`/admin/packs/${PACK_SLUG}`, adminHeaders);
        expect(adminPack.status).toBe(200);
        expect(adminPack.data.pack.buyback_percent).toBe(PACK_PERCENT);

        // Minted after the admin setup so its 30s instant window is not spent
        // before the sell below.
        const pullId = await mintPull(customerId);
        const adminPulls = await get(
          `/admin/customers/${customerId}/pulls`,
          adminHeaders,
        );
        expect(adminPulls.status).toBe(200);
        const adminRow = adminPulls.data.items.find(
          (i: { id: string }) => i.id === pullId,
        );
        expect(adminRow.quote).toMatchObject({
          percent: 100,
          amount: LOSSLESS_AMOUNT,
        });

        const quote = await vaultQuote(token, pullId);
        expect(quote).toMatchObject({ percent: 100, amount: LOSSLESS_AMOUNT });
        const credit = await sell(token, pullId);
        expect(credit).toMatchObject({ percent: 100, amount: LOSSLESS_AMOUNT });
        expect(credit.amount).toBe(quote.amount);

        // The schedule never writes the stored rate.
        const [stored] = await packs.listPacks({ slug: PACK_SLUG }, { take: 1 });
        expect(stored.buyback_percent).toBe(PACK_PERCENT);
      });

      it('a pull whose instant window was closed sells at the flat rate during a live window', async () => {
        const { token, customerId } = await registerCustomer('ls-closed@test.dev');
        await liveAllWindow();

        const pullId = await mintPull(customerId, {
          instant_closed_at: new Date(),
        });
        expect(await vaultQuote(token, pullId)).toMatchObject({
          percent: 90,
          amount: PACK_AMOUNT,
        });
        expect(await sell(token, pullId)).toMatchObject({
          percent: 90,
          amount: PACK_AMOUNT,
        });
      });

      it('a reward pull on a real pack is never lifted, in the quote or the credit', async () => {
        const { token, customerId } = await registerCustomer('ls-reward@test.dev');
        await liveAllWindow();

        const pullId = await mintPull(customerId, { source: 'reward' });
        expect(await vaultQuote(token, pullId)).toMatchObject({
          percent: PACK_PERCENT,
          amount: PACK_AMOUNT,
        });
        expect(await sell(token, pullId)).toMatchObject({
          percent: PACK_PERCENT,
          amount: PACK_AMOUNT,
        });

        // The reveal quote (open / task spin) goes through quoteBuyback: the
        // same pack is lifted for a paid pull and held for a reward pull.
        const fresh = { rolled_at: new Date() };
        expect(
          (await packs.quoteBuyback(PACK_SLUG, fresh, 240)).percent,
        ).toBe(100);
        expect(
          (await packs.quoteBuyback(PACK_SLUG, fresh, 240, undefined, 'reward'))
            .percent,
        ).toBe(PACK_PERCENT);
      });

      it('cancelling a live window: a pull rolled before keeps 100%, one rolled after gets the pack rate, and the cached badges were never overlaid', async () => {
        const { token, customerId } = await registerCustomer('ls-cancel@test.dev');
        const { id: windowId } = await liveAllWindow();

        // Warm both store caches while the window is live.
        expect(await storeBadges()).toEqual({ list: 100, detail: 100 });

        // Rolled inside the window, just before the cancel; revealed now, so
        // its 30s instant window is still open when it sells below.
        const before = await mintPull(customerId, {
          rolled_at: new Date(Date.now() - 2_000),
        });
        await packs.cancelLosslessSchedule({
          id: windowId,
          adminId: ADMIN,
          reason: 'lossless http test cancel',
        });
        const after = await mintPull(customerId);

        // Same pack caches, still warm; only the 10s windows memo is reset
        // (its lag is covered below). The caches must hold the plain body, so
        // the cancel shows without waiting out their 30s TTL.
        clearLosslessDisplayMemo();
        expect(await storeBadges()).toEqual({
          list: PACK_PERCENT,
          detail: PACK_PERCENT,
        });

        expect(await vaultQuote(token, before)).toMatchObject({
          percent: 100,
          amount: LOSSLESS_AMOUNT,
        });
        expect(await sell(token, before)).toMatchObject({
          percent: 100,
          amount: LOSSLESS_AMOUNT,
        });
        expect(await vaultQuote(token, after)).toMatchObject({
          percent: PACK_PERCENT,
          amount: PACK_AMOUNT,
        });
        expect(await sell(token, after)).toMatchObject({
          percent: PACK_PERCENT,
          amount: PACK_AMOUNT,
        });
      });

      it('badges read windows through a 10s memo; the price never does', async () => {
        const { token, customerId } = await registerCustomer('ls-memo@test.dev');
        // Warms the memo with "no windows".
        expect(await storeBadges()).toEqual({
          list: PACK_PERCENT,
          detail: PACK_PERCENT,
        });
        await liveAllWindow();

        // A new window reaches the badges only on the memo refresh (≤10s)…
        expect(await storeBadges()).toEqual({
          list: PACK_PERCENT,
          detail: PACK_PERCENT,
        });
        // …but the sell reads windows live, so it pays 100% straight away.
        const pullId = await mintPull(customerId);
        expect(await sell(token, pullId)).toMatchObject({
          percent: 100,
          amount: LOSSLESS_AMOUNT,
        });

        clearLosslessDisplayMemo();
        expect(await storeBadges()).toEqual({ list: 100, detail: 100 });
      });

      it('a failed windows read serves the badges at the pack rate, not a 500, and is not retried until the memo TTL', async () => {
        await liveAllWindow();
        const read = jest
          .spyOn(packs, 'losslessWindows')
          .mockRejectedValue(new Error('lossless_schedule unavailable'));
        expect(await storeBadges()).toEqual({
          list: PACK_PERCENT,
          detail: PACK_PERCENT,
        });
        // One read for both routes: the failure is memoized, not retried per
        // request (which under pool exhaustion parks every catalog view).
        expect(read).toHaveBeenCalledTimes(1);

        // Recovered, but still inside the TTL: the plain badges stand.
        jest.restoreAllMocks();
        expect(await storeBadges()).toEqual({
          list: PACK_PERCENT,
          detail: PACK_PERCENT,
        });
        // The memo reset stands in for the 10s TTL running out.
        clearLosslessDisplayMemo();
        expect(await storeBadges()).toEqual({ list: 100, detail: 100 });
      });
    });

    describe('Lossless Mode admin API', () => {
      let packs: PacksModuleService;
      let adminHeaders: Record<string, string>;

      beforeEach(async () => {
        clearPackListCache();
        clearPackDetailCache();
        clearLosslessDisplayMemo();

        const container = getContainer();
        packs = container.resolve<PacksModuleService>(PACKS_MODULE);
        await packs.createPacks([
          {
            slug: PACK_SLUG,
            title: 'Lossless Test Pack',
            category: 'pokemon',
            price: 10,
            image: '/cdn/ls-pack.webp',
            buyback_percent: PACK_PERCENT,
          },
          {
            slug: 'ls-free',
            title: 'Free Welcome',
            category: 'free_welcome',
            price: 0,
            image: '/cdn/ls-free.webp',
            buyback_percent: PACK_PERCENT,
          },
          {
            slug: 'ls-reward',
            title: 'Reward Box',
            category: 'reward_box',
            price: 0,
            image: '/cdn/ls-reward.webp',
            buyback_percent: PACK_PERCENT,
          },
        ]);
        const token = await mintSuperAdmin(
          container,
          api,
          'ls-api-admin@test.dev',
          PASSWORD,
        );
        adminHeaders = { authorization: `Bearer ${token}` };
      });

      const post = (path: string, body: unknown) =>
        unwrapResponse(api.post(path, body, { headers: adminHeaders }));

      const liveBody = (over: Record<string, unknown> = {}) => ({
        starts_at: new Date(Date.now() - 60_000).toISOString(),
        ends_at: new Date(Date.now() + 60 * 60_000).toISOString(),
        pack_slugs: [PACK_SLUG],
        reason: 'lossless api test',
        ...over,
      });

      const list = async () => {
        const res = await unwrapResponse(
          api.get('/admin/lossless-schedules', { headers: adminHeaders }),
        );
        expect(res.status).toBe(200);
        return res.data.schedules as {
          id: string;
          status: string;
          cancelled_at: string | null;
          effective_end: string;
          ends_at: string;
        }[];
      };

      it('POST schedules a window, audits it in the same transaction, and GET lists it live', async () => {
        const res = await post('/admin/lossless-schedules', liveBody());
        expect(res.status).toBe(200);
        const created = res.data.schedule;
        expect(created).toMatchObject({
          pack_slugs: [PACK_SLUG],
          cancelled_at: null,
          status: 'live',
        });
        expect(created.effective_end).toBe(created.ends_at);

        const audits = await packs.listAdminActionAudits(
          { entity_type: 'pack', entity_id: created.id },
          { take: 10 },
        );
        expect(audits).toHaveLength(1);
        expect(audits[0]).toMatchObject({
          action: 'create',
          reason: 'lossless api test',
        });
        expect(audits[0].admin_id).toBe(created.created_by);

        const rows = await list();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ id: created.id, status: 'live' });
      });

      it('POST with no reason is refused and writes nothing', async () => {
        const res = await post('/admin/lossless-schedules', {
          ...liveBody(),
          reason: undefined,
        });
        expect(res.status).toBe(400);
        expect(await list()).toHaveLength(0);
      });

      it.each([
        ['an unknown slug', 'no-such-pack'],
        ['the free welcome pack', 'ls-free'],
        ['a reward box', 'ls-reward'],
      ])('POST naming %s is refused with the offending slug and writes nothing', async (_name, slug) => {
        const res = await post(
          '/admin/lossless-schedules',
          liveBody({ pack_slugs: [PACK_SLUG, slug] }),
        );
        expect(res.status).toBe(400);
        expect(res.data.message).toBe(`Unknown or ineligible pack: ${slug}`);
        expect(await list()).toHaveLength(0);
      });

      it('cancel ends a live window; cancelling again is refused', async () => {
        const created = (await post('/admin/lossless-schedules', liveBody()))
          .data.schedule;

        const cancel = await post(
          `/admin/lossless-schedules/${created.id}/cancel`,
          { reason: 'lossless api test cancel' },
        );
        expect(cancel.status).toBe(200);
        expect(cancel.data.schedule).toMatchObject({
          id: created.id,
          status: 'ended',
        });
        expect(cancel.data.schedule.cancelled_at).not.toBeNull();
        expect(
          new Date(cancel.data.schedule.effective_end).getTime(),
        ).toBeLessThan(new Date(cancel.data.schedule.ends_at).getTime());
        expect((await list())[0].status).toBe('ended');

        const again = await post(
          `/admin/lossless-schedules/${created.id}/cancel`,
          { reason: 'lossless api test cancel again' },
        );
        expect(again.status).toBe(400);
        expect(again.data.message).toBe(
          'This schedule already ended or was cancelled.',
        );
      });

      it('cancel without a reason is refused and the window stays live', async () => {
        const created = (await post('/admin/lossless-schedules', liveBody()))
          .data.schedule;
        const res = await post(
          `/admin/lossless-schedules/${created.id}/cancel`,
          {},
        );
        expect(res.status).toBe(400);
        expect((await list())[0].status).toBe('live');
      });
    });
  },
});
