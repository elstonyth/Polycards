import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { FREE_WELCOME_CATEGORY } from '../../src/modules/packs/free-pack';
import { mintSuperAdmin, postStoreCustomer, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

// Pack gifts and bonus credit end to end (spec 2026-10-07): an admin gifts
// packs and bonus credit; the customer opens "Vault x1 + RM300"; a stale screen
// is refused, never billed; gift and bonus cards sell back as normal credit
// that must be played through once (2026-10-09), and count toward nothing; a
// rolled-back open hands the gift back.

const PASSWORD = 'pack-gifts-password-1';
const ADMIN_EMAIL = 'pack-gifts-admin@test.dev';
const PACK = 'gift-bronze';
const PRICE = 300;
const CARD = 'gift-card';
const FX = 4;
// Card value 50 USD × FX 4 × multiplier 1 = RM 200; instant 90% = RM 180.

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    let storeHeaders: Record<string, string>;
    let customerToken: string;
    let customerId: string;
    let adminToken: string;

    const packs = () =>
      getContainer().resolve<PacksModuleService>(PACKS_MODULE);
    const authed = () => ({
      ...storeHeaders,
      authorization: `Bearer ${customerToken}`,
    });
    const admin = () => ({ authorization: `Bearer ${adminToken}` });

    const giftPacks = (quantity: number, key: string, packId = PACK) =>
      unwrapResponse(
        api.post(
          `/admin/customers/${customerId}/pack-gifts`,
          {
            pack_id: packId,
            quantity,
            note: 'test gift',
            idempotency_key: key,
          },
          { headers: admin() },
        ),
      );
    const grantBonus = (amount: number, key: string) =>
      unwrapResponse(
        api.post(
          `/admin/customers/${customerId}/credits`,
          { amount, note: 'test bonus', idempotency_key: key, kind: 'bonus' },
          { headers: admin() },
        ),
      );
    const storeGifts = async () =>
      (
        await unwrapResponse(
          api.get('/store/pack-gifts', { headers: authed() }),
        )
      ).data.gifts as { pack_id: string; count: number }[];
    const openBatch = (count: number, gifts: number) =>
      unwrapResponse(
        api.post(
          `/store/packs/${PACK}/open-batch`,
          { count, gifts },
          { headers: authed() },
        ),
      );
    // Deposit with no external basis: grandfathered out of playthrough.
    const deposit = (amount: number) =>
      packs().createCreditTransactions([
        {
          customer_id: customerId,
          amount,
          reason: 'topup' as const,
          external_funded_cents: null,
        },
      ]);
    const wallet = () => packs().walletSummary(customerId);
    const openRows = () =>
      packs().listCreditTransactions({
        customer_id: customerId,
        reason: 'pack_open',
      });

    beforeEach(async () => {
      const container = getContainer();
      const key = await container.resolve(Modules.API_KEY).createApiKeys({
        title: 'pack-gifts-test',
        type: 'publishable',
        created_by: 'pack-gifts-test',
      });
      storeHeaders = { 'x-publishable-api-key': key.token };

      await packs().createPacks([
        {
          slug: PACK,
          title: 'Bronze Pack',
          category: 'pokemon',
          price: PRICE,
          image: '/cdn/bronze.webp',
          buyback_percent: 90,
        },
        {
          slug: 'gift-welcome',
          title: 'Welcome',
          category: FREE_WELCOME_CATEGORY,
          price: 0,
          image: '/cdn/welcome.webp',
        },
      ]);
      await packs().createCards([
        {
          handle: CARD,
          name: 'Gift Card PSA 10',
          set: 'Test Set',
          grader: 'PSA',
          grade: '10',
          market_value: 50,
          market_multiplier: 1,
          image: '/cdn/gift-card.webp',
        },
      ]);
      await packs().createPackOdds([
        {
          pack_id: PACK,
          card_id: CARD,
          weight: 100,
          locked: false,
          rarity: 'Rare' as const,
        },
        {
          pack_id: 'gift-welcome',
          card_id: CARD,
          weight: 100,
          locked: false,
          rarity: 'Rare' as const,
        },
      ]);
      await packs().createFxRates([
        {
          pair: 'USD_MYR',
          rate: FX,
          source: 'test',
          manual_override: true,
          manual_rate: FX,
        },
      ]);

      const email = `gift-customer-${Date.now()}@test.dev`;
      const reg = await api.post('/auth/customer/emailpass/register', {
        email,
        password: PASSWORD,
      });
      await postStoreCustomer(
        api,
        container,
        { email },
        {
          headers: {
            ...storeHeaders,
            authorization: `Bearer ${reg.data.token}`,
          },
        },
      );
      customerToken = (
        await api.post('/auth/customer/emailpass', {
          email,
          password: PASSWORD,
        })
      ).data.token;
      customerId = (
        await container.resolve(Modules.CUSTOMER).listCustomers({ email })
      )[0].id;
      adminToken = await mintSuperAdmin(
        container,
        api,
        `${Date.now()}-${ADMIN_EMAIL}`,
        PASSWORD,
      );
    });

    it('gifts packs to the vault; replays are idempotent; reserved packs refused', async () => {
      const res = await giftPacks(2, 'grant-1');
      expect(res.status).toBe(201);
      expect(res.data.gifts).toHaveLength(2);
      expect(res.data.gifts[0]).toMatchObject({
        pack_id: PACK,
        pack_title: 'Bronze Pack',
        value_myr: PRICE,
        state: 'unopened',
      });

      expect(await storeGifts()).toEqual([
        expect.objectContaining({
          pack_id: PACK,
          count: 2,
          title: 'Bronze Pack',
          price: PRICE,
          available: true,
        }),
      ]);

      // Same key: the same grant, nothing new.
      expect((await giftPacks(2, 'grant-1')).status).toBe(201);
      expect((await storeGifts())[0].count).toBe(2);
      // Same key, different gift: refused.
      expect((await giftPacks(3, 'grant-1')).status).toBe(400);
      expect((await giftPacks(11, 'grant-2')).status).toBe(400);
      expect((await giftPacks(1, 'grant-3', 'gift-welcome')).status).toBe(400);

      // The customer is told once.
      const notes = await getContainer()
        .resolve(Modules.NOTIFICATION)
        .listNotifications({ receiver_id: customerId });
      expect(
        notes.filter(
          (n: { template: string }) => n.template === 'pack_gift_received',
        ),
      ).toHaveLength(1);
    });

    it('opens "Vault x1 + RM300": one gift row, one paid row, one debit', async () => {
      await giftPacks(1, 'mixed');
      await deposit(PRICE);

      const res = await openBatch(2, 1);
      expect(res.status).toBe(200);
      expect(res.data.gifts_used).toBe(1);
      expect(res.data.total_charged).toBe(PRICE);
      const [giftRoll, paidRoll] = res.data.rolls;
      expect(giftRoll.pull).toMatchObject({ source: 'gift', bonus_bp: 10000 });
      expect(paidRoll.pull).toMatchObject({ source: 'pack', bonus_bp: 0 });
      // The gift's sell-back is all bonus; the paid one none.
      expect(giftRoll.buyback.bonus).toBe(giftRoll.buyback.amount);
      expect(paidRoll.buyback.bonus).toBe(0);

      const debits = await openRows();
      expect(debits).toHaveLength(1);
      expect(Number(debits[0].amount)).toBe(-PRICE);

      const [gift] = await packs().listPackGifts({ customer_id: customerId });
      expect(gift.pull_id).toBe(giftRoll.pull.id);
      expect(await storeGifts()).toEqual([]);
    });

    it('opens a gift alone without any debit', async () => {
      await giftPacks(1, 'alone');
      const res = await openBatch(1, 1);
      expect(res.status).toBe(200);
      expect(res.data.total_charged).toBe(0);
      expect(await openRows()).toHaveLength(0);
      expect((await wallet()).balance).toBe(0);
    });

    // Sold out (in_stock=false, set from the admin): the pack stays listed but a
    // paid open is refused before any debit; a gift already given still opens.
    it('sold out: refuses paid opens without a debit; a gift alone still opens', async () => {
      const soldOut = await unwrapResponse(
        api.post(
          `/admin/packs/${PACK}`,
          {
            title: 'Bronze Pack',
            category: 'pokemon',
            price: PRICE,
            image: '/cdn/bronze.webp',
            buyback_percent: 90,
            rank: 0,
            status: 'active',
            in_stock: false,
          },
          { headers: admin() },
        ),
      );
      expect(soldOut.status).toBe(200);
      const [stored] = await packs().listPacks({ slug: PACK });
      expect(stored).toMatchObject({ status: 'active', in_stock: false });

      // Still listed for customers.
      const listed = await unwrapResponse(
        api.get(`/store/packs/${PACK}`, { headers: storeHeaders }),
      );
      expect(listed.status).toBe(200);

      await giftPacks(1, 'sold-out');
      await deposit(2 * PRICE);

      const batch = await openBatch(2, 1);
      expect(batch.status).toBe(400);
      expect(batch.data.message).toMatch(/sold out/);
      const single = await unwrapResponse(
        api.post(`/store/packs/${PACK}/open`, {}, { headers: authed() }),
      );
      expect(single.status).toBe(400);
      expect(await openRows()).toHaveLength(0);
      expect((await wallet()).balance).toBe(2 * PRICE);
      expect((await storeGifts())[0].count).toBe(1);

      const gift = await openBatch(1, 1);
      expect(gift.status).toBe(200);
      expect(gift.data.total_charged).toBe(0);
      expect((await wallet()).balance).toBe(2 * PRICE);
    });

    it('refuses a stale "Vault x2" and charges nothing', async () => {
      await giftPacks(1, 'stale');
      await deposit(2 * PRICE);

      const res = await openBatch(2, 2);
      expect(res.status).toBe(409);
      expect(res.data.message).toBe(
        'Your vault pack is no longer available — refresh.',
      );
      expect((await wallet()).balance).toBe(2 * PRICE);
      expect(await packs().listPulls({ customer_id: customerId })).toHaveLength(
        0,
      );
      expect((await storeGifts())[0].count).toBe(1);
    });

    it('lets exactly one of two racing opens spend one gift', async () => {
      await giftPacks(1, 'race');
      const results = await Promise.all([openBatch(1, 1), openBatch(1, 1)]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(await packs().listPulls({ customer_id: customerId })).toHaveLength(
        1,
      );
    });

    it('spends bonus first and splits it per row', async () => {
      expect((await grantBonus(400, 'bonus-400')).status).toBe(200);
      await deposit(500);

      const res = await openBatch(2, 0);
      expect(res.status).toBe(200);
      const [first, second] = res.data.rolls;
      expect(first.pull).toMatchObject({ source: 'bonus', bonus_bp: 10000 });
      expect(second.pull).toMatchObject({ source: 'pack', bonus_bp: 3334 });

      const [debit] = await openRows();
      expect(debit.bonus_cents).toBe(-40000);
      expect(await wallet()).toMatchObject({
        balance: 300,
        bonus: 0,
        withdrawable: 300,
      });

      // The admin page reads the bonus balance off the customer summary.
      const summary = await unwrapResponse(
        api.get(`/admin/customers/${customerId}/gacha`, { headers: admin() }),
      );
      expect(summary.data.bonus_balance).toBe(0);
    });

    it('sells a gifted card back as normal credit, withdrawable once played through', async () => {
      await giftPacks(1, 'sell');
      const opened = await openBatch(1, 1);
      const pullId = opened.data.rolls[0].pull.id;

      const sold = await unwrapResponse(
        api.post(`/store/vault/${pullId}/buyback`, {}, { headers: authed() }),
      );
      expect(sold.status).toBe(200);
      const [credit] = await packs().listCreditTransactions({
        pull_id: pullId,
      });
      const sale = Number(credit.amount);
      // Normal credit, the whole sale stamped for playthrough (2026-10-09).
      expect(credit.bonus_cents ?? 0).toBe(0);
      expect(credit.external_funded_cents).toBe(Math.round(sale * 100));
      const locked = await wallet();
      expect(locked).toMatchObject({ bonus: 0, withdrawable: 0 });
      expect(locked.playthrough.remaining).toBeCloseTo(sale, 2);

      // One RM 300 open plays it through; what is left can then be withdrawn.
      await deposit(PRICE);
      expect((await openBatch(1, 0)).status).toBe(200);
      const unlocked = await wallet();
      expect(unlocked.playthrough.remaining).toBe(0);
      expect(unlocked.withdrawable).toBeCloseTo(sale, 2);
    });

    it('counts gift and bonus pulls toward nothing', async () => {
      const task = await unwrapResponse(
        api.post(
          '/admin/tasks',
          {
            kind: 'achievement',
            title: 'Vault 1 card',
            requirement: { type: 'vault_count', count: 1 },
            reward: { type: 'credit', amount_myr: 3 },
            reason: 'pack gifts test',
          },
          { headers: admin() },
        ),
      );
      expect(task.status).toBe(200);

      await giftPacks(1, 'nothing');
      await openBatch(1, 1);
      await grantBonus(PRICE, 'bonus-nothing');
      await openBatch(1, 0);

      expect(await packs().hasPaidOpen(customerId)).toBe(false);
      const hub = await unwrapResponse(
        api.get('/store/tasks', { headers: authed() }),
      );
      expect(hub.data.tasks[0].progress.completed).toBe(false);
      const recent = await unwrapResponse(
        api.get('/store/pulls/recent', { headers: storeHeaders }),
      );
      const pulls = JSON.stringify(recent.data);
      const mine = await packs().listPulls({ customer_id: customerId });
      for (const p of mine) expect(pulls).not.toContain(p.id);
    });

    it('revokes an unopened gift and refuses an opened one', async () => {
      const granted = await giftPacks(2, 'revoke');
      const [first, second] = granted.data.gifts;

      const revoked = await unwrapResponse(
        api.post(
          `/admin/pack-gifts/${first.id}/revoke`,
          {},
          { headers: admin() },
        ),
      );
      expect(revoked.status).toBe(200);
      expect((await storeGifts())[0].count).toBe(1);

      await openBatch(1, 1);
      const again = await unwrapResponse(
        api.post(
          `/admin/pack-gifts/${second.id}/revoke`,
          {},
          { headers: admin() },
        ),
      );
      expect(again.status).toBe(409);
      expect(again.data.message).toBe('Already opened');

      const list = await unwrapResponse(
        api.get(`/admin/customers/${customerId}/pack-gifts`, {
          headers: admin(),
        }),
      );
      expect(
        list.data.gifts.map((g: { state: string }) => g.state).sort(),
      ).toEqual(['opened', 'revoked']);
    });

    it('counts gifts and bonus toward the daily mint ceiling', async () => {
      const before = process.env.ADJUST_DAILY_MINT_MAX_RM;
      process.env.ADJUST_DAILY_MINT_MAX_RM = '500';
      try {
        expect((await giftPacks(1, 'cap-gift')).status).toBe(201);
        const refused = await grantBonus(PRICE, 'cap-bonus');
        expect(refused.status).toBe(400);
        expect(refused.data.message).toMatch(/Daily credit-adjustment limit/);
      } finally {
        if (before === undefined) delete process.env.ADJUST_DAILY_MINT_MAX_RM;
        else process.env.ADJUST_DAILY_MINT_MAX_RM = before;
      }
    });

    it('hands the gift and the money back when the open rolls back', async () => {
      await giftPacks(1, 'rollback');
      await deposit(PRICE);
      const spy = jest
        .spyOn(packs(), 'stampPackGiftPulls')
        .mockRejectedValueOnce(new Error('stamp exploded'));
      try {
        const res = await openBatch(2, 1);
        expect(res.status).toBeGreaterThanOrEqual(400);
      } finally {
        spy.mockRestore();
      }
      expect(await packs().listPulls({ customer_id: customerId })).toHaveLength(
        0,
      );
      expect((await wallet()).balance).toBe(PRICE);
      const [gift] = await packs().listPackGifts({ customer_id: customerId });
      expect(gift).toMatchObject({
        opened_at: null,
        open_id: null,
        pull_id: null,
      });
      expect((await storeGifts())[0].count).toBe(1);
    });

    it('keeps a real-money open counting when a little bonus is left over', async () => {
      await grantBonus(5, 'bonus-leftover');
      await deposit(PRICE);
      const res = await openBatch(1, 0);
      expect(res.status).toBe(200);
      // RM 5 of a RM 300 open is under half: a real-money open, which also
      // unlocks the welcome card. The RM 5 still sells back as bonus.
      expect(res.data.rolls[0].pull).toMatchObject({
        source: 'pack',
        bonus_bp: 167,
      });
      expect(await packs().hasPaidOpen(customerId)).toBe(true);
    });

    it('weights pulled value on the boards by the real-money share', async () => {
      await grantBonus(PRICE / 2, 'bonus-half');
      await deposit(PRICE / 2);
      const res = await openBatch(1, 0);
      const pull = res.data.rolls[0].pull;
      expect(pull).toMatchObject({ source: 'bonus', bonus_bp: 5000 });

      const [row] = (
        await packs().leaderboardTop({ sinceMs: null, limit: 50 })
      ).filter((r) => r.customer_id === customerId);
      // Half real money: half the spend and half the card's value count.
      expect(row.points).toBe((PRICE / 2) * 100);
      expect(row.volume).toBeCloseTo(
        // A bigNumber may come back as a number or as its raw { value } form.
        (Number(pull.recorded_value_usd?.value ?? pull.recorded_value_usd) * FX) /
          2,
        1,
      );
    });

    it('audits a bonus grant with the balance read under the credit lock', async () => {
      await grantBonus(20, 'audit-1');
      await grantBonus(30, 'audit-2');
      const rows = await packs().listAdminActionAudits({
        action: 'grant_bonus_credit',
      });
      const second = rows.find(
        (r) => (r.after as { bonus?: number } | null)?.bonus === 50,
      );
      expect(second?.before).toMatchObject({ bonus: 20 });
    });

    it('names leftover bonus on a deletion block, and revokes gifts on purge', async () => {
      await grantBonus(5, 'bonus-delete');
      const blocked = await packs().deleteAccountPreflight(customerId);
      expect(blocked).toMatchObject({ ok: false, reason: 'BALANCE_NOT_ZERO' });
      expect((blocked as { detail: string }).detail).toMatch(
        /RM 5\.00 of it is bonus credit/,
      );

      // The operator's way out; then the purge takes the unopened gift along.
      expect((await grantBonus(-5, 'bonus-delete-back')).status).toBe(200);
      await giftPacks(1, 'delete');
      await packs().purgeAccountPacksData(customerId);
      const [gift] = await packs().listPackGifts({ customer_id: customerId });
      expect(gift.revoked_by).toBe('account-deletion');
      expect(gift.revoked_at).not.toBeNull();
    });

    it('rejects a bad kind on the credits route', async () => {
      const res = await unwrapResponse(
        api.post(
          `/admin/customers/${customerId}/credits`,
          { amount: 5, note: 'x', kind: 'gold' },
          { headers: admin() },
        ),
      );
      expect(res.status).toBe(400);
      expect(res.data.message).toMatch(/kind must be/);
    });
  },
});
