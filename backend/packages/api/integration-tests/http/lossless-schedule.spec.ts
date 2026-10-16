import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { clearPackListCache } from '../../src/api/store/packs/route';
import { clearPackDetailCache } from '../../src/api/store/packs/[slug]/route';
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

        const pullId = await mintPull(customerId);

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

        // Same caches, still warm: they must hold the plain body, so the cancel
        // shows at once instead of after the 30s TTL.
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
    });
  },
});
