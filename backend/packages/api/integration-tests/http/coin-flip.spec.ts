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
      const settings = { enabled: true, max_stake_amount: 500, win_percent: 100, win_percent_2: 0, win_percent_3: null,
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
      expect(publicSettings.data).toEqual({ enabled: true, eligible: true, reason: null, max_stake_amount: 500, published_win_percent: 50 });
      const q = await api.post('/store/coin-flips/quotes', { pull_id: pull.id }, { headers: owner.headers });
      const roundId = q.data.round.id as string;
      expect((await unwrapResponse(api.get(`/store/coin-flips/${roundId}`, { headers: stranger.headers }))).status).toBe(404);
      const won = await api.post(`/store/coin-flips/${roundId}/accept`, {}, { headers: owner.headers });
      const replay = await api.post(`/store/coin-flips/${roundId}/accept`, {}, { headers: owner.headers });
      expect(replay.data).toEqual(won.data);
      expect(won.data.round).toMatchObject({ status: 'won', win_amount: 100, published_win_percent: 50 });
      expect(JSON.stringify(won.data)).not.toMatch(/actual_win|odds_set|group_id|snapshot|roll/);
      await api.post('/admin/coin-flips/settings', { ...settings, win_percent: 0, expected_revision: saved.data.revision }, { headers: adminHeaders });
      const lossQuote = await api.post('/store/coin-flips/quotes', { pull_id: pull.id }, { headers: owner.headers });
      const lost = await api.post(`/store/coin-flips/${lossQuote.data.round.id}/accept`, {}, { headers: owner.headers });
      expect(lost.data.round.status).toBe('lost');
      const history = await api.get('/store/coin-flips?limit=1', { headers: owner.headers });
      expect(history.data).toMatchObject({ count: 2, limit: 1 });
      expect(history.data.rounds[0].status).toBe('lost');
      const report = await api.get('/admin/coin-flips', { headers: adminHeaders });
      expect(report.data.totals).toEqual({ wins: 1, losses: 1, payouts: 100, forfeited_value: 100 });
      expect(report.data.rounds[0].snapshot.actual_win_units).toBe(0);
      expect(await packs.listCreditTransactions({ customer_id: owner.id, reason: 'coin_flip_win' })).toHaveLength(1);
    });
  },
});
