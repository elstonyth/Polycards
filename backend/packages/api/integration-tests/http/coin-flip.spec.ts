import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { mintSuperAdmin, postStoreCustomer, unwrapResponse } from './utils';

jest.setTimeout(300_000);

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    it('protects routes, separates published odds, settles once, and exposes loss receipts and admin accounting', async () => {
      const container = getContainer();
      const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
      const key = await container.resolve(Modules.API_KEY).createApiKeys({ title: 'Coin test', type: 'publishable', created_by: 'test' });
      const publicHeaders = { 'x-publishable-api-key': key.token };
      const adminToken = await mintSuperAdmin(container, api, 'coin-admin@test.dev', 'Coin-admin-password-1');
      const adminHeaders = { authorization: `Bearer ${adminToken}` };
      const register = async (email: string) => {
        const password = 'Coin-player-password-1';
        const reg = await api.post('/auth/customer/emailpass/register', { email, password });
        await postStoreCustomer(api, container, { email }, { headers: { ...publicHeaders, authorization: `Bearer ${reg.data.token}` } });
        const login = await api.post('/auth/customer/emailpass', { email, password });
        const headers = { ...publicHeaders, authorization: `Bearer ${login.data.token}` };
        const me = await api.get('/store/customers/me', { headers });
        return { headers, id: me.data.customer.id as string };
      };
      const owner = await register('coin-owner@test.dev');
      const stranger = await register('coin-stranger@test.dev');
      for (const path of ['/store/coin-flips', '/store/coin-flips/settings', '/store/coin-flips/missing']) {
        expect((await unwrapResponse(api.get(path, { headers: publicHeaders }))).status).toBe(401);
      }
      expect((await unwrapResponse(api.post('/store/coin-flips/quotes', { pull_id: 'missing' }, { headers: publicHeaders }))).status).toBe(401);
      expect((await unwrapResponse(api.post('/store/coin-flips/missing/accept', {}, { headers: publicHeaders }))).status).toBe(401);
      expect((await unwrapResponse(api.get('/admin/coin-flips/settings', { headers: owner.headers }))).status).not.toBe(200);
      const initial = await api.get('/admin/coin-flips/settings', { headers: adminHeaders });
      expect(initial.data.enabled).toBe(false);
      const settings = { enabled: true, win_percent: 100, win_percent_2: 0, win_percent_3: null,
        published_win_percent: 50, expected_revision: initial.data.revision, reason: 'Test rollout' };
      const saved = await api.post('/admin/coin-flips/settings', settings, { headers: adminHeaders });
      expect(saved.data.revision).toBe(initial.data.revision + 1);
      expect((await unwrapResponse(api.post('/admin/coin-flips/settings', settings, { headers: adminHeaders }))).status).toBe(409);
      await packs.createFxRates([{ pair: 'USD_MYR', source: 'test', rate: 4 }]);
      await packs.createCards([{ handle: 'coin-card', name: 'Coin Test Card', set: 'Test', grader: 'PSA', grade: '10',
        market_value: 25, market_multiplier: 1, image: '/test.png' }]);
      const [pull] = await packs.createPulls([{ customer_id: owner.id, pack_id: 'test', card_id: 'coin-card', rolled_at: new Date(),
        source: 'gift', bonus_bp: 10000, flip_eligible_at: new Date() }]);
      await packs.createCreditTransactions([
        { customer_id: owner.id, reason: 'topup', amount: 10, external_funded_cents: 1000 },
        { customer_id: owner.id, reason: 'pack_open', amount: -10, external_funded_cents: -1000 },
      ]);
      const publicSettings = await api.get('/store/coin-flips/settings', { headers: owner.headers });
      expect(publicSettings.data).toEqual({ enabled: true, eligible: true, reason: null, published_win_percent: 50 });
      const q = await api.post('/store/coin-flips/quotes', { pull_ids: [pull.id], chosen_side: 'tail' }, { headers: owner.headers });
      const roundId = q.data.round.id as string;
      expect((await unwrapResponse(api.get(`/store/coin-flips/${roundId}`, { headers: stranger.headers }))).status).toBe(404);
      const won = await api.post(`/store/coin-flips/${roundId}/accept`, {}, { headers: owner.headers });
      const replay = await api.post(`/store/coin-flips/${roundId}/accept`, {}, { headers: owner.headers });
      expect(replay.data).toEqual(won.data);
      expect(won.data.round).toMatchObject({ status: 'won', win_amount: 100, published_win_percent: 50, chosen_side: 'tail', landed_side: 'tail' });
      expect(JSON.stringify(won.data)).not.toMatch(/actual_win|odds_set|group_id|snapshot|roll/);
      await api.post('/admin/coin-flips/settings', { ...settings, win_percent: 0, expected_revision: saved.data.revision }, { headers: adminHeaders });
      const [extra] = await packs.createPulls([{ customer_id: owner.id, pack_id: 'test', card_id: 'coin-card', rolled_at: new Date(),
        source: 'pack', bonus_bp: 0, flip_eligible_at: new Date() }]);
      const lossQuote = await api.post('/store/coin-flips/quotes', { pull_ids: [pull.id, extra.id], chosen_side: 'head' }, { headers: owner.headers });
      expect(lossQuote.data.round).toMatchObject({ stake_amount: 200, chosen_side: 'head' });
      expect(lossQuote.data.round.cards).toHaveLength(2);
      expect((await unwrapResponse(api.post(`/store/coin-flips/${lossQuote.data.round.id}/accept`, { chosen_side: 'tail' }, { headers: owner.headers }))).status).toBe(400);
      const lost = await api.post(`/store/coin-flips/${lossQuote.data.round.id}/accept`, {}, { headers: owner.headers });
      expect(lost.data.round.status).toBe('lost');
      expect(lost.data.round.landed_side).toBe('tail');
      expect((await packs.listPulls({ id: [pull.id, extra.id] })).every(p => p.status === 'forfeited')).toBe(true);
      const history = await api.get('/store/coin-flips?limit=1', { headers: owner.headers });
      expect(history.data).toMatchObject({ count: 2, limit: 1, totals: { head: 0, tail: 2 } });
      expect(history.data.rounds[0].status).toBe('lost');
      const wonOnly = await api.get('/store/coin-flips?status=won', { headers: owner.headers });
      expect(wonOnly.data).toMatchObject({ count: 1, totals: { head: 0, tail: 2 } });
      expect(wonOnly.data.rounds[0].status).toBe('won');
      const report = await api.get('/admin/coin-flips', { headers: adminHeaders });
      expect(report.data.totals).toEqual({ wins: 1, losses: 1, payouts: 100, forfeited_value: 200 });
      expect(report.data.rounds[0].snapshot.actual_win_units).toBe(0);
      const funded = await api.get('/admin/coin-flips?source=gift', { headers: adminHeaders });
      expect(funded.data.count).toBe(1);
      const mixed = await api.get('/admin/coin-flips?source=mixed', { headers: adminHeaders });
      expect(mixed.data).toMatchObject({ count: 1, totals: { wins: 0, losses: 1, payouts: 0, forfeited_value: 200 } });
      expect(mixed.data.rounds[0].cards).toHaveLength(2);
      const gifts = await api.get('/admin/coin-flips?source=pack', { headers: adminHeaders });
      expect(gifts.data).toMatchObject({ count: 0, rounds: [], totals: { wins: 0, losses: 0, payouts: 0, forfeited_value: 0 } });
      expect((await unwrapResponse(api.get('/admin/coin-flips?source=invalid', { headers: adminHeaders }))).status).toBe(400);
      expect(await packs.listCreditTransactions({ customer_id: owner.id, reason: 'coin_flip_win' })).toHaveLength(1);
      const profit = await api.get('/admin/profit-report?range=all&scope=all', { headers: adminHeaders });
      expect(profit.data.activity).toMatchObject({ coin_flip_payouts: 100, sellbacks: 0, promo_given: 0 });
      const money = await api.get(`/admin/customers/${owner.id}/money`, { headers: adminHeaders });
      expect(money.data.activity).toMatchObject({ coin_flip_payouts: 100, sellbacks: 0, promo_given: 0 });
      expect(money.data.wallet.withdrawable).toBe(100);
      const transactions = await api.get(`/admin/customers/${owner.id}/transactions?reasons=coin_flip_win`, { headers: adminHeaders });
      expect(transactions.data.total).toBe(1);
      expect(transactions.data.items[0]).toMatchObject({ reason: 'coin_flip_win', amount: 100, bonus: 0 });
      expect(transactions.data.items[0].ledger_display_id).toMatch(/^CF/);
    });
  },
});
