import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { moduleIntegrationTestRunner } from '@medusajs/test-utils';
import type { Context } from '@medusajs/framework/types';
import { PACKS_MODULE } from '../index';
import type PacksModuleService from '../service';
import CoinFlipConfig from '../models/coin-flip-config';
import CoinFlipRound from '../models/coin-flip-round';
import Pull from '../models/pull';
import Card from '../models/card';
import FxRate from '../models/fx-rate';
import CreditTransaction from '../models/credit-transaction';
import CustomerAccountState from '../models/customer-account-state';
import LedgerEntry from '../models/ledger-entry';
import LedgerSequence from '../models/ledger-sequence';
import AdminActionAudit from '../models/admin-action-audit';
import Pack from '../models/pack';
import DeliveryOrder from '../models/delivery-order';
import DeliveryOrderItem from '../models/delivery-order-item';
import LosslessSchedule from '../models/lossless-schedule';
import TaskDefinition from '../models/task-definition';
import TaskClaim from '../models/task-claim';
import RewardsSettings from '../models/rewards-settings';
import LuckyDrawTicket from '../models/lucky-draw-ticket';
import TicketSpin from '../models/ticket-spin';
import { Migration20261103100000 } from '../migrations/Migration20261103100000';
import { Migration20261103100100 } from '../migrations/Migration20261103100100';
import { Migration20261103100200 } from '../migrations/Migration20261103100200';
import { FREE_PULL_LOCKED_MESSAGE } from '../free-pack';

jest.setTimeout(300_000);

moduleIntegrationTestRunner<PacksModuleService>({
  moduleName: PACKS_MODULE,
  resolve: path.resolve(__dirname, '../../..', 'modules/packs'),
  moduleModels: [CoinFlipConfig, CoinFlipRound, Pull, Card, FxRate, CreditTransaction,
    CustomerAccountState, LedgerEntry, LedgerSequence, AdminActionAudit, Pack, DeliveryOrder, DeliveryOrderItem,
    LosslessSchedule, TaskDefinition, TaskClaim, RewardsSettings, LuckyDrawTicket, TicketSpin],
  testSuite: ({ service, MikroOrmWrapper }) => {
    const settings = (win = 100) => ({ enabled: true,
      win_percent: win, win_percent_2: null, win_percent_3: null, published_win_percent: 50 });
    const configure = async (win = 100) => service.saveCoinFlipSettings({
      settings: settings(win), revision: (await service.coinFlipSettings()).revision,
      adminId: 'admin_coin', reason: 'Integration test configuration',
    });
    const seed = async (source: 'pack' | 'gift' | 'bonus' | 'free' | 'reward' = 'pack') => {
      const customerId = `coin_${randomUUID()}`;
      const [card] = await service.createCards([{ handle: customerId, name: 'Pikachu', set: 'Base',
        grader: 'PSA', grade: '10', market_value: 20, market_multiplier: 1.25, image: '/pikachu.png' }]);
      const [pull] = await service.createPulls([{ customer_id: customerId, card_id: card.handle,
        pack_id: 'coin-test', rolled_at: new Date(), source, bonus_bp: source === 'pack' ? 0 : 10000,
        stock_earmarked: true, flip_eligible_at: new Date() }]);
      // Eligible despite zero wallet balance.
      await service.createCreditTransactions([
        { customer_id: customerId, amount: 10, reason: 'topup', external_funded_cents: 1000 },
        { customer_id: customerId, amount: -10, reason: 'pack_open', external_funded_cents: -1000 },
      ]);
      return { customerId, pullId: pull.id };
    };
    beforeEach(async () => {
      const em = MikroOrmWrapper.forkManager();
      await em.execute('CREATE TABLE IF NOT EXISTS customer_group (id text primary key, name text, metadata jsonb, created_at timestamptz default now(), deleted_at timestamptz)');
      await em.execute('CREATE TABLE IF NOT EXISTS customer_group_customer (customer_id text, customer_group_id text, deleted_at timestamptz)');
      await em.execute('TRUNCATE customer_group_customer, customer_group');
      await service.createFxRates([{ pair: 'USD_MYR', rate: 4, source: 'test', manual_override: false }]);
      await configure();
    });
    const pullState = async (id: string) => (await service.listPulls({ id }, { take: 1 }))[0];
    const wins = (customerId: string) => service.listCreditTransactions({ customer_id: customerId, reason: 'coin_flip_win' });
    const addPull = async (customerId: string, source: 'pack' | 'gift' | 'reward' = 'gift') =>
      (await service.createPulls([{ customer_id: customerId, card_id: customerId, pack_id: 'coin-test',
        rolled_at: new Date(), source, bonus_bp: source === 'pack' ? 0 : 10000,
        stock_earmarked: true, flip_eligible_at: new Date() }]))[0];

    it.each(['head', 'tail'] as const)('atomically pays or forfeits a mixed bundle called %s, with one idempotent receipt', async chosenSide => {
      for (const win of [100, 0]) {
        await configure(win);
        const input = await seed();
        const gift = await addPull(input.customerId);
        const reward = await addPull(input.customerId, 'reward');
        const pullIds = [input.pullId, gift.id, reward.id];
        const q = await service.quoteCoinFlip({ customerId: input.customerId, pullIds, chosenSide });
        expect(q).toMatchObject({ stake_amount: 300, chosen_side: chosenSide, landed_side: null });
        expect(q.cards).toHaveLength(3);
        const accept = { customerId: input.customerId, roundId: q.id };
        const [result, retry] = await Promise.all([service.acceptCoinFlip(accept), service.acceptCoinFlip(accept)]);
        expect(retry).toEqual(result);
        expect(result).toMatchObject({ status: win ? 'won' : 'lost', win_amount: win ? 300 : 0,
          landed_side: win ? chosenSide : chosenSide === 'head' ? 'tail' : 'head' });
        for (const id of pullIds) expect(await pullState(id)).toMatchObject({ status: win ? 'vaulted' : 'forfeited', flip_version: 1 });
        expect(await wins(input.customerId)).toHaveLength(win ? 1 : 0);
        const entries = await service.listLedgerEntries({ type: 'CF', customer_id: input.customerId });
        expect(entries).toHaveLength(1);
        expect(Number(entries[0].vault_delta)).toBe(win ? 0 : -200);
        expect((entries[0].payload as { cards: unknown[] }).cards).toHaveLength(3);
        expect(await service.coinFlipTotals({ customerId: input.customerId, source: 'mixed' })).toMatchObject({
          wins: win ? 1 : 0, losses: win ? 0 : 1, payouts: win ? 300 : 0, forfeited_value: win ? 0 : 300,
        });
      }
    });

    it('ignores an old cap and rejects a stale card without partially committing its bundle', async () => {
      const input = await seed();
      const second = await addPull(input.customerId);
      const selection = { customerId: input.customerId, pullIds: [input.pullId, second.id], chosenSide: 'tail' as const };
      await MikroOrmWrapper.forkManager().execute('UPDATE coin_flip_config SET max_stake_cents = 15000');
      const q = await service.quoteCoinFlip(selection);
      expect(q.stake_amount).toBe(200);
      await service.updatePulls([{ id: second.id, flip_version: 1 }]);
      await expect(service.acceptCoinFlip({ customerId: input.customerId, roundId: q.id })).rejects.toThrow(/changed/);
      expect(await pullState(input.pullId)).toMatchObject({ status: 'vaulted', flip_version: 0 });
      expect(await wins(input.customerId)).toHaveLength(0);
      expect((await service.getCoinFlipRound({ customerId: input.customerId, roundId: q.id })).status).toBe('quoted');
    });

    it('refuses a quote once its cards are worth less, and honours it if they rose', async () => {
      await configure(100);
      const input = await seed();
      const [card] = await service.listCards({ handle: input.customerId });
      const q = await service.quoteCoinFlip(input);
      await service.updateCards([{ id: card.id, market_value: 10 }]);
      await expect(service.acceptCoinFlip({ customerId: input.customerId, roundId: q.id })).rejects.toThrow(/changed/);
      expect((await service.getCoinFlipRound({ customerId: input.customerId, roundId: q.id })).status).toBe('quoted');
      expect((await pullState(input.pullId)).status).toBe('vaulted');
      expect(await wins(input.customerId)).toHaveLength(0);
      const lower = await service.quoteCoinFlip(input);
      expect(lower.stake_amount).toBeLessThan(q.stake_amount);
      await service.updateCards([{ id: card.id, market_value: 40 }]);
      const receipt = await service.acceptCoinFlip({ customerId: input.customerId, roundId: lower.id });
      expect(receipt).toMatchObject({ status: 'won', win_amount: lower.stake_amount });
    });

    it.each([100, 0])('settles a RM60m bundle with %i%% odds without a value cap or integer overflow', async percent => {
      await configure(percent);
      const input = await seed();
      const [card] = await service.listCards({ handle: input.customerId });
      await service.updateCards([{ id: card.id, market_value: 6_000_000 }]);
      const second = await addPull(input.customerId);
      await MikroOrmWrapper.forkManager().execute('UPDATE coin_flip_config SET max_stake_cents = 100');
      const q = await service.quoteCoinFlip({ customerId: input.customerId, pullIds: [input.pullId, second.id], chosenSide: 'tail' });
      expect(q.stake_amount).toBe(60_000_000);
      const receipt = await service.acceptCoinFlip({ customerId: input.customerId, roundId: q.id });
      expect(receipt).toMatchObject({ status: percent ? 'won' : 'lost', stake_amount: 60_000_000, win_amount: percent ? 60_000_000 : 0 });
      expect(await service.getCoinFlipRound({ customerId: input.customerId, roundId: q.id })).toEqual(receipt);
      expect((await service.walletSummary(input.customerId)).withdrawable).toBe(percent ? 60_000_000 : 0);
      for (const id of [input.pullId, second.id]) expect((await pullState(id)).status).toBe(percent ? 'vaulted' : 'forfeited');
    });

    it('serializes overlapping bundles so a shared card cannot settle twice', async () => {
      const input = await seed();
      const b = await addPull(input.customerId);
      const c = await addPull(input.customerId);
      const aQuote = await service.quoteCoinFlip({ customerId: input.customerId, pullIds: [input.pullId, b.id], chosenSide: 'head' });
      const bQuote = await service.quoteCoinFlip({ customerId: input.customerId, pullIds: [b.id, c.id], chosenSide: 'tail' });
      const results = await Promise.allSettled([aQuote, bQuote].map(q => service.acceptCoinFlip({ customerId: input.customerId, roundId: q.id })));
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      expect(await wins(input.customerId)).toHaveLength(1);
      expect((await pullState(b.id)).flip_version).toBe(1);
      expect((await service.walletSummary(input.customerId)).withdrawable).toBe(200);
    });

    it('keeps legacy single-card quotes recoverable as Head calls', async () => {
      const input = await seed();
      const q = await service.quoteCoinFlip(input);
      await MikroOrmWrapper.forkManager().execute("UPDATE coin_flip_round SET snapshot = snapshot - 'cards' - 'chosen_side' WHERE id = ?", [q.id]);
      const result = await service.acceptCoinFlip({ customerId: input.customerId, roundId: q.id });
      expect(result).toMatchObject({ status: 'won', chosen_side: 'head', landed_side: 'head', win_amount: 100 });
      expect(result.cards).toHaveLength(1);
    });

    it('applies every actual odds setting from 100–0 through 0–100 at its exact settlement boundary', async () => {
      const input = await seed();
      // Control only the draw in this test; quotes, saved settings and money writes use the real database.
      const draw = jest.spyOn(require('node:crypto'), 'randomInt');
      try {
        for (let percent = 100; percent >= 0; percent--) {
          await configure(percent);
          for (const chosenSide of ['head', 'tail'] as const) {
            for (const won of [true, false]) {
              if ((won && percent === 0) || (!won && percent === 100)) continue;
              const pull = await addPull(input.customerId);
              draw.mockReturnValue(won ? percent * 10000 - 1 : percent * 10000);
              const q = await service.quoteCoinFlip({ customerId: input.customerId, pullIds: [pull.id], chosenSide });
              const receipt = await service.acceptCoinFlip({ customerId: input.customerId, roundId: q.id });
              expect({ percent, side: chosenSide, status: receipt.status }).toEqual({ percent, side: chosenSide, status: won ? 'won' : 'lost' });
              expect(receipt.landed_side).toBe(won ? chosenSide : chosenSide === 'head' ? 'tail' : 'head');
              expect(receipt.win_amount).toBe(won ? 100 : 0);
              expect(receipt.published_win_percent).toBe(50);
            }
          }
        }
        expect(draw).toHaveBeenCalledTimes(400);
        expect((await service.listAndCountCreditTransactions({ customer_id: input.customerId, reason: 'coin_flip_win' }))[1]).toBe(200);
      } finally { draw.mockRestore(); }
    });

    it.each(['pack', 'gift', 'bonus'] as const)('pays a %s card as normal credit once, keeps funding tags and supports a new confirmed win', async source => {
      const input = await seed(source);
      const quote = await service.quoteCoinFlip(input);
      expect(quote).toMatchObject({ status: 'quoted', stake_amount: 100, published_win_percent: 50 });
      expect(JSON.stringify(quote)).not.toMatch(/actual|odds_set|group_id|roll|bonus_bp/);
      const accept = { customerId: input.customerId, roundId: quote.id };
      const receipts = await Promise.all([service.acceptCoinFlip(accept), service.acceptCoinFlip(accept)]);
      expect(receipts[0]).toEqual(receipts[1]);
      expect(receipts[0]).toMatchObject({ status: 'won', win_amount: 100 });
      expect(await wins(input.customerId)).toHaveLength(1);
      expect((await wins(input.customerId))[0]).toMatchObject({ pull_id: null, bonus_cents: 0, external_funded_cents: 0 });
      expect(await pullState(input.pullId)).toMatchObject({ status: 'vaulted', source, flip_version: 1, stock_earmarked: true });
      const again = await service.quoteCoinFlip(input);
      await service.acceptCoinFlip({ ...accept, roundId: again.id });
      expect(await wins(input.customerId)).toHaveLength(2);
      expect((await service.walletSummary(input.customerId)).withdrawable).toBe(200);
    });

    it.each(['pack', 'gift', 'bonus', 'reward'] as const)('forfeits a %s loss without credit or inventory return, conserving tracked vault liability', async source => {
      await configure(0);
      const input = await seed(source);
      if (source === 'reward') {
        await service.recordLedgerEntry({ type: 'WP', customerId: input.customerId, refId: input.pullId,
          walletDelta: 0, vaultDelta: null,
          payload: { type: 'WP', period: 'luckydraw:test', stage: 0, rank: 0, sku: input.customerId, value: 0 } });
      }
      const q = await service.quoteCoinFlip(input);
      const result = await service.acceptCoinFlip({ customerId: input.customerId, roundId: q.id });
      expect(result).toMatchObject({ status: 'lost', win_amount: 0, stake_amount: 100 });
      expect(await pullState(input.pullId)).toMatchObject({ status: 'forfeited', flip_version: 1, stock_earmarked: true });
      expect(await wins(input.customerId)).toHaveLength(0);
      const entries = await service.listLedgerEntries({ type: 'CF', customer_id: input.customerId });
      expect(entries).toHaveLength(1);
      expect(Number(entries[0].wallet_delta)).toBe(0);
      expect(Number(entries[0].vault_delta)).toBe(source === 'reward' ? 0 : -100);
      expect(entries[0].payload).toMatchObject({ outcome: 'lost', value: 100 });
      expect(await service.coinFlipTotals({ customerId: input.customerId })).toMatchObject({ losses: 1, payouts: 0, forfeited_value: 100 });
      if (source === 'reward') {
        const history = await service.listLedgerEntries({ customer_id: input.customerId });
        expect(history.reduce((sum, row) => sum + Number(row.vault_delta ?? 0), 0)).toBe(0);
      }
      await service.saveCoinFlipSettings({ settings: { ...settings(), enabled: false },
        revision: (await service.coinFlipSettings()).revision, adminId: 'admin_coin', reason: 'Pause' });
      expect(await service.acceptCoinFlip({ customerId: input.customerId, roundId: q.id })).toEqual(result);
    });

    it('allows at most one of two quotes for the same card version to settle', async () => {
      const input = await seed();
      const a = await service.quoteCoinFlip(input);
      const b = await service.quoteCoinFlip(input);
      const results = await Promise.allSettled([a, b].map(q => service.acceptCoinFlip({ customerId: input.customerId, roundId: q.id })));
      expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
      expect(await wins(input.customerId)).toHaveLength(1);
    });

    it('rolls every money, card and receipt write back when the enclosing transaction fails', async () => {
      const input = await seed();
      const q = await service.quoteCoinFlip(input);
      const em = MikroOrmWrapper.forkManager();
      await em.begin();
      try {
        await service.acceptCoinFlip({ customerId: input.customerId, roundId: q.id }, { transactionManager: em } as unknown as Context);
      } finally { await em.rollback(); }
      expect(await wins(input.customerId)).toHaveLength(0);
      expect(await pullState(input.pullId)).toMatchObject({ status: 'vaulted', flip_version: 0 });
      expect((await service.getCoinFlipRound({ customerId: input.customerId, roundId: q.id })).status).toBe('quoted');
      expect(await service.listLedgerEntries({ type: 'CF', customer_id: input.customerId })).toHaveLength(0);
    });

    it('refuses unfinished pack cards and validates finalization ownership', async () => {
      const input = await seed();
      await service.updatePulls([{ id: input.pullId, flip_eligible_at: null }]);
      await expect(service.quoteCoinFlip(input)).rejects.toThrow(/^Pikachu is still processing/);
      await expect(service.finalizePullsForCoinFlip({ customerId: 'other', pullIds: [input.pullId] })).rejects.toThrow();
      const before = (await pullState(input.pullId)).updated_at;
      await service.finalizePullsForCoinFlip({ customerId: input.customerId, pullIds: [input.pullId] });
      await service.finalizePullsForCoinFlip({ customerId: input.customerId, pullIds: [input.pullId] });
      expect((await service.quoteCoinFlip(input)).status).toBe('quoted');
      // /store/vault/latest reads updated_at on a held card as a new event.
      expect((await pullState(input.pullId)).updated_at).toEqual(before);
    });

    it('requires paused feature and explicit drained ingress for legacy eligibility repair', async () => {
      const input = await seed();
      const repair = { customerId: input.customerId, pullIds: [input.pullId], ingressDrained: true };
      await service.updatePulls([{ id: input.pullId, flip_eligible_at: null }]);
      await expect(service.finalizeLegacyPullsForCoinFlip(repair)).rejects.toThrow(/Pause/);
      await service.saveCoinFlipSettings({ settings: { ...settings(), enabled: false },
        revision: (await service.coinFlipSettings()).revision, adminId: 'admin_coin', reason: 'Maintenance' });
      await expect(service.finalizeLegacyPullsForCoinFlip({ ...repair, ingressDrained: false })).rejects.toThrow(/drain/);
      await service.finalizeLegacyPullsForCoinFlip(repair);
      expect((await pullState(input.pullId)).flip_eligible_at).toBeTruthy();
    });

    it.each(['expired', 'config', 'disabled', 'frozen', 'playthrough', 'ownership', 'group'] as const)('refuses %s changes after quote without mutation', async cause => {
      const input = await seed();
      const q = await service.quoteCoinFlip(input);
      if (cause === 'expired') await service.updateCoinFlipRounds([{ id: q.id, expires_at: new Date(0) }]);
      if (cause === 'config') await configure(0);
      if (cause === 'disabled' || cause === 'frozen') await service.createCustomerAccountStates([{ customer_id: input.customerId, [cause]: true }]);
      if (cause === 'playthrough') await service.createCreditTransactions([{ customer_id: input.customerId, amount: 10, reason: 'topup', external_funded_cents: 1000 }]);
      if (cause === 'ownership') await service.updatePulls([{ id: input.pullId, customer_id: 'other' }]);
      if (cause === 'group') {
        const em = MikroOrmWrapper.forkManager();
        await em.execute("INSERT INTO customer_group (id, name, metadata) VALUES ('coin-group', 'Players', '{\"odds_set\":2}')");
        await em.execute("INSERT INTO customer_group_customer (customer_id, customer_group_id) VALUES (?, 'coin-group')", [input.customerId]);
      }
      await expect(service.acceptCoinFlip({ customerId: input.customerId, roundId: q.id })).rejects.toThrow();
      expect(await wins(input.customerId)).toHaveLength(0);
      expect((await service.getCoinFlipRound({ customerId: input.customerId, roundId: q.id })).status).toBe('quoted');
    });

    it('conceals another customer’s quote and refuses locked welcome cards', async () => {
      const input = await seed();
      const q = await service.quoteCoinFlip(input);
      await expect(service.acceptCoinFlip({ customerId: 'other', roundId: q.id })).rejects.toThrow(/not found/i);
      await expect(service.quoteCoinFlip(await seed('free'))).rejects.toThrow();
    });

    it('requires the effective partner group to allow withdrawals', async () => {
      const input = await seed();
      const q = await service.quoteCoinFlip(input);
      const em = MikroOrmWrapper.forkManager();
      await em.execute("INSERT INTO customer_group (id, name, metadata) VALUES ('blocked', 'Partner', '{\"partner_rate_bp\":100,\"withdrawals_blocked\":true}')");
      await em.execute("INSERT INTO customer_group_customer (customer_id, customer_group_id) VALUES (?, 'blocked')", [input.customerId]);
      await expect(service.quoteCoinFlip(input)).rejects.toThrow(/Withdrawals are not available/);
      await expect(service.acceptCoinFlip({ customerId: input.customerId, roundId: q.id })).rejects.toThrow(/Withdrawals are not available/);
      await em.execute("UPDATE customer_group SET metadata = '{\"withdrawals_blocked\":true}' WHERE id = 'blocked'");
      expect((await service.quoteCoinFlip(input)).status).toBe('quoted');
    });

    it('can sell after a win, preserving the gift buyback cash rule', async () => {
      const input = await seed('gift');
      const q = await service.quoteCoinFlip(input);
      await service.acceptCoinFlip({ customerId: input.customerId, roundId: q.id });
      const sold = await service.buybackPullAtomic(input);
      expect(sold.amount).toBeGreaterThan(0);
      const [credit] = await service.listCreditTransactions({ id: sold.creditTransactionId });
      expect(credit).toMatchObject({ reason: 'buyback', pull_id: input.pullId });
      expect(credit.external_funded_cents ?? 0).toBe(0);
      expect((await service.walletSummary(input.customerId)).playthrough.remaining).toBe(0);
      expect((await service.walletSummary(input.customerId)).withdrawable).toBe(100 + sold.amount);
      expect(await wins(input.customerId)).toHaveLength(1);
    });

    it('serializes a losing flip against buyback', async () => {
      await configure(0);
      const input = await seed();
      const q = await service.quoteCoinFlip(input);
      const results = await Promise.allSettled([
        service.acceptCoinFlip({ customerId: input.customerId, roundId: q.id }),
        service.buybackPullAtomic(input),
      ]);
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      const pull = await pullState(input.pullId);
      const sales = await service.listCreditTransactions({ pull_id: input.pullId });
      expect(sales).toHaveLength(pull.status === 'bought_back' ? 1 : 0);
      expect(['bought_back', 'forfeited']).toContain(pull.status);
    });

    it('keeps bonus-funded sales held while reward sales are cash', async () => {
      for (const source of ['bonus', 'reward'] as const) {
        const input = await seed(source);
        const sold = await service.buybackPullAtomic(input);
        const [credit] = await service.listCreditTransactions({ id: sold.creditTransactionId });
        expect(credit.external_funded_cents ?? 0).toBe(source === 'bonus' ? Math.round(sold.amount * 100) : 0);
      }
    });

    it('rechecks the daily-task card lock for flipping, selling and delivery', async () => {
      const input = await seed('reward');
      const [task] = await service.createTaskDefinitions([{ kind: 'daily', title: 'Daily card',
        requirement: { type: 'checkin' }, reward: { type: 'card' } }]);
      await service.createTaskClaims([{ customer_id: input.customerId, task_id: task.id, claim_ref: input.pullId }]);
      await expect(service.quoteCoinFlip(input)).rejects.toThrow(FREE_PULL_LOCKED_MESSAGE);
      await expect(service.buybackPullAtomic(input)).rejects.toThrow(FREE_PULL_LOCKED_MESSAGE);
      await expect(service.createDeliveryOrderWithLedger({ customerId: input.customerId, pullIds: [input.pullId], fx: 4,
        snapshot: { ship_name: 'Test', ship_address_1: '1 Road', ship_address_2: null, ship_city: 'Kuala Lumpur',
          ship_province: 'Kuala Lumpur', ship_postal_code: '50000', ship_country_code: 'my', ship_phone: null },
      })).rejects.toThrow(/changed/i);
      const pull = await pullState(input.pullId);
      await service.createPulls([{ customer_id: input.customerId, card_id: pull.card_id,
        pack_id: 'coin-test', rolled_at: new Date(), source: 'pack' }]);
      expect((await service.quoteCoinFlip(input)).status).toBe('quoted');
      expect((await service.buybackPullAtomic(input)).amount).toBeGreaterThan(0);
    });

    it('preserves the lossless instant offer in atomic buyback and closes it with the reveal', async () => {
      await service.createPacks([{ slug: 'coin-test', title: 'Coin test', category: 'pokemon',
        price: 10, image: '/pack.png', buyback_percent: 90 }]);
      await service.createLosslessSchedules([{ starts_at: new Date(Date.now() - 60_000),
        ends_at: new Date(Date.now() + 60_000), created_by: 'admin_coin' }]);
      const open = await seed();
      expect(await service.buybackPullAtomic(open)).toMatchObject({ amount: 100, percent: 100, rate_type: 'instant' });
      const closed = await seed();
      await service.updatePulls([{ id: closed.pullId, instant_closed_at: new Date() }]);
      expect(await service.buybackPullAtomic(closed)).toMatchObject({ amount: 90, percent: 90, rate_type: 'vault' });
    });

    it('serializes a losing flip against delivery and never revives a later flipped card during cancel compensation', async () => {
      await configure(0);
      const input = await seed();
      await service.createCreditTransactions([{ customer_id: input.customerId, reason: 'adjustment', amount: 100 }]);
      const snapshot = { ship_name: 'Test Player', ship_address_1: '1 Test Road',
        ship_address_2: null, ship_city: 'Kuala Lumpur', ship_province: 'Kuala Lumpur',
        ship_postal_code: '50000', ship_country_code: 'my', ship_phone: '0123456789' };
      const q = await service.quoteCoinFlip(input);
      const results = await Promise.allSettled([
        service.createDeliveryOrderWithLedger({ customerId: input.customerId, pullIds: [input.pullId], snapshot, fx: 4 }),
        service.acceptCoinFlip({ customerId: input.customerId, roundId: q.id }),
      ]);
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      for (const result of results) if (result.status === 'rejected') expect(String(result.reason)).toMatch(/changed|no longer/i);
      // Its own card, so this half runs whichever side won the race above.
      const later = await seed();
      await service.createCreditTransactions([{ customer_id: later.customerId, reason: 'adjustment', amount: 100 }]);
      const order = await service.createDeliveryOrderWithLedger({ customerId: later.customerId, pullIds: [later.pullId], snapshot, fx: 4 });
      const transition = await service.transitionDeliveryOrderStatus({ orderId: order.orderId,
        to: 'canceled', trackingNumber: null, pullIds: [later.pullId] });
      const fresh = await service.quoteCoinFlip(later);
      await service.acceptCoinFlip({ customerId: later.customerId, roundId: fresh.id });
      await expect(service.undoDeliveryAtomic({ orderId: order.orderId, expectedStatus: 'canceled',
        pullVersions: transition.pullVersions, restorePulls: true,
        previous: { status: 'requested', tracking_number: null, shipped_at: null, delivered_at: null } })).rejects.toThrow(/changed/);
      expect((await pullState(later.pullId)).status).toBe('forfeited');
    });

    it.each(['credit_transaction', 'ledger_entry', 'coin_flip_round'] as const)('rolls back if %s write fails', async table => {
      const input = await seed();
      const other = await addPull(input.customerId);
      const q = await service.quoteCoinFlip({ customerId: input.customerId, pullIds: [input.pullId, other.id], chosenSide: 'tail' });
      const em = MikroOrmWrapper.forkManager();
      await em.execute("CREATE OR REPLACE FUNCTION coin_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'write failed'; END $$");
      await em.execute(`CREATE TRIGGER coin_test_failure BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION coin_test_fail()`);
      try {
        await expect(service.acceptCoinFlip({ customerId: input.customerId, roundId: q.id })).rejects.toThrow('write failed');
      } finally {
        await em.execute(`DROP TRIGGER coin_test_failure ON ${table}`);
        await em.execute('DROP FUNCTION coin_test_fail()');
      }
      expect((await pullState(input.pullId)).flip_version).toBe(0);
      expect((await pullState(other.id)).flip_version).toBe(0);
      expect(await wins(input.customerId)).toHaveLength(0);
      expect((await service.getCoinFlipRound({ customerId: input.customerId, roundId: q.id })).status).toBe('quoted');
      expect(await service.listLedgerEntries({ type: 'CF', customer_id: input.customerId })).toHaveLength(0);
    });

    it('rechecks a freeze committed while acceptance waits for the credit lock', async () => {
      const input = await seed();
      const q = await service.quoteCoinFlip(input);
      const em = MikroOrmWrapper.forkManager();
      await em.begin();
      await em.execute('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [`credit:${input.customerId}`]);
      const accepting = service.acceptCoinFlip({ customerId: input.customerId, roundId: q.id });
      const rejected = expect(accepting).rejects.toThrow(/review/);
      await em.execute('INSERT INTO customer_account_state (id, customer_id, frozen) VALUES (?, ?, true)', [randomUUID(), input.customerId]);
      await em.commit();
      await rejected;
      expect(await wins(input.customerId)).toHaveLength(0);
    });

    it.each([[100, false], [0, true]] as const)('at %i%% odds moves the pull updated_at only on a loss, so a win lights no Vault red dot', async (win, moved) => {
      await configure(win);
      const input = await seed();
      const old = new Date('2026-01-01T00:00:00.000Z');
      await MikroOrmWrapper.forkManager().execute('UPDATE pull SET updated_at = ? WHERE id = ?', [old, input.pullId]);
      const quote = await service.quoteCoinFlip(input);
      await service.acceptCoinFlip({ customerId: input.customerId, roundId: quote.id });
      const updated = new Date((await pullState(input.pullId)).updated_at).getTime();
      expect(updated !== old.getTime()).toBe(moved);
    });

    it('counts how a customer\'s settled flips landed, whichever side they called', async () => {
      const toss = async (customerId: string, chosenSide: 'head' | 'tail') => {
        const pull = await addPull(customerId);
        const quote = await service.quoteCoinFlip({ customerId, pullIds: [pull.id], chosenSide });
        await service.acceptCoinFlip({ customerId, roundId: quote.id });
      };
      const { customerId } = await seed();
      const other = await seed();
      await service.quoteCoinFlip({ customerId, pullIds: [(await addPull(customerId)).id], chosenSide: 'head' });
      expect(await service.coinFlipLandedCounts(customerId)).toEqual({ head: 0, tail: 0 });
      await configure(100);
      await toss(customerId, 'head');
      await toss(customerId, 'head');
      await toss(customerId, 'tail');
      await toss(other.customerId, 'tail');
      await configure(0);
      await toss(customerId, 'head');
      await toss(customerId, 'tail');
      expect(await service.coinFlipLandedCounts(customerId)).toEqual({ head: 3, tail: 2 });
      expect(await service.coinFlipLandedCounts(other.customerId)).toEqual({ head: 0, tail: 1 });
    });

    describe('ticket flips', () => {
      const seedTickets = async (held: number) => {
        const { customerId } = await seed();
        await service.createLuckyDrawTickets([{ customer_id: customerId, delta: held, reason: 'admin_grant', ref: `admin:${randomUUID()}` }]);
        return customerId;
      };
      const ticketRows = (customerId: string) => service.listLuckyDrawTickets({ customer_id: customerId, reason: 'coin_flip' });

      it.each([[100, 'won', 25, 5], [0, 'lost', 15, -5]] as const)('at %i%% odds a %s flip moves only the staked tickets, once', async (win, status, after, delta) => {
        await configure(win);
        const customerId = await seedTickets(20);
        const walletBefore = (await service.walletSummary(customerId)).balance;
        const quote = await service.quoteCoinFlip({ customerId, tickets: 5, chosenSide: 'tail' });
        expect(quote).toMatchObject({ status: 'quoted', tickets: 5, stake_amount: 0, win_amount: 0, card: null, cards: [], chosen_side: 'tail', landed_side: null });
        expect(JSON.stringify(quote)).not.toMatch(/actual|odds_set|group_id|roll|bonus_bp/);
        // A quote holds nothing.
        expect(await service.luckyDrawBalance(customerId)).toBe(20);
        const accept = { customerId, roundId: quote.id };
        const [result, retry] = await Promise.all([service.acceptCoinFlip(accept), service.acceptCoinFlip(accept)]);
        expect(retry).toEqual(result);
        expect(result).toMatchObject({ status, tickets: 5, stake_amount: 0, win_amount: 0, landed_side: status === 'won' ? 'tail' : 'head' });
        expect(await service.luckyDrawBalance(customerId)).toBe(after);
        const rows = await ticketRows(customerId);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ delta, ref: quote.id });
        // Tickets never touch money: no Credit, no wallet change, no ledger row.
        expect(await wins(customerId)).toHaveLength(0);
        expect((await service.walletSummary(customerId)).balance).toBe(walletBefore);
        expect(await service.listLedgerEntries({ type: 'CF', customer_id: customerId })).toHaveLength(0);
        expect(await service.coinFlipTotals({ customerId })).toMatchObject({
          wins: status === 'won' ? 1 : 0, losses: status === 'won' ? 0 : 1, payouts: 0, forfeited_value: 0,
        });
      });

      it('a loss takes all of a full-balance stake and nothing more', async () => {
        await configure(0);
        const customerId = await seedTickets(7);
        const quote = await service.quoteCoinFlip({ customerId, tickets: 7, chosenSide: 'head' });
        await service.acceptCoinFlip({ customerId, roundId: quote.id });
        expect(await service.luckyDrawBalance(customerId)).toBe(0);
        await expect(service.quoteCoinFlip({ customerId, tickets: 1, chosenSide: 'head' })).rejects.toThrow(/enough tickets/);
      });

      it('refuses a stake above the balance at quote', async () => {
        const customerId = await seedTickets(3);
        await expect(service.quoteCoinFlip({ customerId, tickets: 4, chosenSide: 'head' })).rejects.toThrow(/enough tickets/);
        await expect(service.quoteCoinFlip({ customerId, tickets: 0, chosenSide: 'head' })).rejects.toThrow();
      });

      it('re-checks the balance at accept, since a quote holds no tickets', async () => {
        const customerId = await seedTickets(5);
        const first = await service.quoteCoinFlip({ customerId, tickets: 5, chosenSide: 'head' });
        const second = await service.quoteCoinFlip({ customerId, tickets: 5, chosenSide: 'head' });
        await configure(0);
        const q1 = await service.quoteCoinFlip({ customerId, tickets: 5, chosenSide: 'head' });
        const q2 = await service.quoteCoinFlip({ customerId, tickets: 5, chosenSide: 'head' });
        await expect(service.acceptCoinFlip({ customerId, roundId: first.id })).rejects.toThrow(/changed/);
        expect(second.status).toBe('quoted');
        await service.acceptCoinFlip({ customerId, roundId: q1.id });
        await expect(service.acceptCoinFlip({ customerId, roundId: q2.id })).rejects.toThrow(/enough tickets/);
        expect(await service.luckyDrawBalance(customerId)).toBe(0);
        expect((await service.getCoinFlipRound({ customerId, roundId: q2.id })).status).toBe('quoted');
      });

      it('refuses an expired quote and another customer', async () => {
        const customerId = await seedTickets(5);
        const quote = await service.quoteCoinFlip({ customerId, tickets: 2, chosenSide: 'head' });
        await expect(service.acceptCoinFlip({ customerId: 'someone_else', roundId: quote.id })).rejects.toThrow(/not found/i);
        await MikroOrmWrapper.forkManager().execute("UPDATE coin_flip_round SET expires_at = now() - interval '1 second' WHERE id = ?", [quote.id]);
        await expect(service.acceptCoinFlip({ customerId, roundId: quote.id })).rejects.toThrow(/expired/i);
        expect(await service.luckyDrawBalance(customerId)).toBe(5);
      });

      it('holds the ticket lock while it settles, so a Lucky Draw entry cannot spend the same tickets', async () => {
        const customerId = await seedTickets(5);
        const quote = await service.quoteCoinFlip({ customerId, tickets: 5, chosenSide: 'head' });
        const em = MikroOrmWrapper.forkManager();
        const observer = MikroOrmWrapper.forkManager();
        await em.begin();
        let pending: Promise<unknown> | undefined;
        try {
          await em.execute('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [`tickets:${customerId}`]);
          pending = service.acceptCoinFlip({ customerId, roundId: quote.id });
          let waiting = false;
          for (let attempt = 0; attempt < 100; attempt++) {
            const [row] = await observer.execute<{ waiting: boolean }[]>(
              "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE wait_event = 'advisory' AND query LIKE ?) AS waiting", [`%tickets:${customerId}%`]);
            if (row.waiting) { waiting = true; break; }
            await new Promise(resolve => setTimeout(resolve, 20));
          }
          expect(waiting).toBe(true);
        } finally {
          await em.rollback();
        }
        await expect(pending).resolves.toMatchObject({ status: 'won' });
      });

      it('sees a spend committed while it waited for the ticket lock', async () => {
        const customerId = await seedTickets(5);
        const quote = await service.quoteCoinFlip({ customerId, tickets: 5, chosenSide: 'head' });
        const em = MikroOrmWrapper.forkManager();
        const observer = MikroOrmWrapper.forkManager();
        await em.begin();
        let pending: Promise<unknown> | undefined;
        try {
          await em.execute('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [`tickets:${customerId}`]);
          await em.execute(
            "INSERT INTO lucky_draw_ticket (id, customer_id, delta, reason, ref, created_at, updated_at) VALUES (?, ?, -5, 'admin_grant', ?, now(), now())",
            [`ldtk_${randomUUID()}`, customerId, `admin:${randomUUID()}`]);
          pending = service.acceptCoinFlip({ customerId, roundId: quote.id }).catch((error: Error) => error);
          let waiting = false;
          for (let attempt = 0; attempt < 100; attempt++) {
            const [row] = await observer.execute<{ waiting: boolean }[]>(
              "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE wait_event = 'advisory' AND query LIKE ?) AS waiting", [`%tickets:${customerId}%`]);
            if (row.waiting) { waiting = true; break; }
            await new Promise(resolve => setTimeout(resolve, 20));
          }
          expect(waiting).toBe(true);
          await em.commit();
        } catch (error) {
          await em.rollback();
          throw error;
        }
        expect(await pending).toMatchObject({ message: expect.stringMatching(/enough tickets/) });
        expect(await service.luckyDrawBalance(customerId)).toBe(0);
        expect(await ticketRows(customerId)).toHaveLength(0);
        expect((await service.getCoinFlipRound({ customerId, roundId: quote.id })).status).toBe('quoted');
      });

      describe('with cards in the same flip', () => {
        const seedBoth = async (held: number) => {
          const input = await seed();
          await service.createLuckyDrawTickets([{ customer_id: input.customerId, delta: held, reason: 'admin_grant', ref: `admin:${randomUUID()}` }]);
          return input;
        };

        it('a win pays Credit on the cards, keeps them and adds the tickets, once', async () => {
          const input = await seedBoth(20);
          const quote = await service.quoteCoinFlip({ customerId: input.customerId, pullIds: [input.pullId], tickets: 5, chosenSide: 'tail' });
          expect(quote).toMatchObject({ status: 'quoted', stake_amount: 100, tickets: 5, chosen_side: 'tail' });
          expect(quote.cards).toHaveLength(1);
          expect(await service.luckyDrawBalance(input.customerId)).toBe(20);
          const accept = { customerId: input.customerId, roundId: quote.id };
          const [result, retry] = await Promise.all([service.acceptCoinFlip(accept), service.acceptCoinFlip(accept)]);
          expect(retry).toEqual(result);
          expect(result).toMatchObject({ status: 'won', win_amount: 100, tickets: 5 });
          expect(await pullState(input.pullId)).toMatchObject({ status: 'vaulted', flip_version: 1 });
          expect(await wins(input.customerId)).toHaveLength(1);
          expect(await service.luckyDrawBalance(input.customerId)).toBe(25);
          expect(await ticketRows(input.customerId)).toHaveLength(1);
          expect(await service.listLedgerEntries({ type: 'CF', customer_id: input.customerId })).toHaveLength(1);
          expect(await service.coinFlipTotals({ customerId: input.customerId })).toEqual({ wins: 1, losses: 0, payouts: 100, forfeited_value: 0 });
        });

        it('a loss forfeits the cards and takes every staked ticket, leaving the rest', async () => {
          await configure(0);
          const input = await seedBoth(20);
          const quote = await service.quoteCoinFlip({ customerId: input.customerId, pullIds: [input.pullId], tickets: 5, chosenSide: 'tail' });
          const result = await service.acceptCoinFlip({ customerId: input.customerId, roundId: quote.id });
          expect(result).toMatchObject({ status: 'lost', win_amount: 0, tickets: 5, landed_side: 'head' });
          expect(await pullState(input.pullId)).toMatchObject({ status: 'forfeited' });
          expect(await wins(input.customerId)).toHaveLength(0);
          expect(await service.luckyDrawBalance(input.customerId)).toBe(15);
          expect((await ticketRows(input.customerId))[0]).toMatchObject({ delta: -5, ref: quote.id });
        });

        it('settles nothing when the tickets are gone by accept, not even the cards', async () => {
          const input = await seedBoth(5);
          const quote = await service.quoteCoinFlip({ customerId: input.customerId, pullIds: [input.pullId], tickets: 5, chosenSide: 'head' });
          await service.createLuckyDrawTickets([{ customer_id: input.customerId, delta: -1, reason: 'admin_grant', ref: `admin:${randomUUID()}` }]);
          await expect(service.acceptCoinFlip({ customerId: input.customerId, roundId: quote.id })).rejects.toThrow(/enough tickets/);
          expect(await pullState(input.pullId)).toMatchObject({ status: 'vaulted', flip_version: 0 });
          expect(await wins(input.customerId)).toHaveLength(0);
          expect(await ticketRows(input.customerId)).toHaveLength(0);
          expect((await service.getCoinFlipRound({ customerId: input.customerId, roundId: quote.id })).status).toBe('quoted');
        });

        it('settles nothing when a card changed by accept, not even the tickets', async () => {
          const input = await seedBoth(5);
          const quote = await service.quoteCoinFlip({ customerId: input.customerId, pullIds: [input.pullId], tickets: 5, chosenSide: 'head' });
          await service.updatePulls([{ id: input.pullId, flip_version: 1 }]);
          await expect(service.acceptCoinFlip({ customerId: input.customerId, roundId: quote.id })).rejects.toThrow(/changed/);
          expect(await service.luckyDrawBalance(input.customerId)).toBe(5);
          expect(await ticketRows(input.customerId)).toHaveLength(0);
        });

        it('refuses a quote above the ticket balance even with cards', async () => {
          const input = await seedBoth(2);
          await expect(service.quoteCoinFlip({ customerId: input.customerId, pullIds: [input.pullId], tickets: 3, chosenSide: 'head' })).rejects.toThrow(/enough tickets/);
          await expect(service.quoteCoinFlip({ customerId: input.customerId, pullIds: [input.pullId], tickets: 0, chosenSide: 'head' })).rejects.toThrow();
        });
      });

      it('lists in history next to card flips and counts them in the tally, with money totals untouched', async () => {
        const input = await seed();
        await service.createLuckyDrawTickets([{ customer_id: input.customerId, delta: 4, reason: 'admin_grant', ref: `admin:${randomUUID()}` }]);
        const cards = await service.quoteCoinFlip(input);
        await service.acceptCoinFlip({ customerId: input.customerId, roundId: cards.id });
        const tickets = await service.quoteCoinFlip({ customerId: input.customerId, tickets: 4, chosenSide: 'head' });
        await service.acceptCoinFlip({ customerId: input.customerId, roundId: tickets.id });
        const [rows, count] = await service.listAndCountCoinFlipRounds({ customer_id: input.customerId, status: ['won', 'lost'] });
        expect(count).toBe(2);
        expect(rows.map(row => row.ticket_stake).sort()).toEqual([0, 4]);
        expect(await service.coinFlipTotals({ customerId: input.customerId })).toEqual({ wins: 2, losses: 0, payouts: 100, forfeited_value: 0 });
        expect(await service.coinFlipTotals({ customerId: input.customerId, source: 'tickets' })).toEqual({ wins: 1, losses: 0, payouts: 0, forfeited_value: 0 });
      });
    });

    it('applies real migration checks and refuses destructive rollback once a round exists', async () => {
      const em = MikroOrmWrapper.forkManager();
      const migration = Object.create(Migration20261103100000.prototype) as Migration20261103100000;
      const sql: string[] = [];
      migration.addSql = statement => { if (typeof statement !== 'string') throw new Error('Expected SQL text.'); sql.push(statement); };
      await migration.up();
      for (const statement of sql) await em.execute(statement);
      const uncapped = Object.create(Migration20261103100100.prototype) as Migration20261103100100;
      uncapped.addSql = statement => { sql.push(statement as string); };
      sql.length = 0;
      await uncapped.up();
      for (const statement of sql) await em.execute(statement);
      const tickets = Object.create(Migration20261103100200.prototype) as Migration20261103100200;
      tickets.addSql = statement => { sql.push(statement as string); };
      sql.length = 0;
      await tickets.up();
      for (const statement of sql) await em.execute(statement);
      const input = await seed();
      const q = await service.quoteCoinFlip(input);
      await service.acceptCoinFlip({ customerId: input.customerId, roundId: q.id });
      await expect(em.execute("UPDATE credit_transaction SET bonus_cents = 1 WHERE reason = 'coin_flip_win'")).rejects.toThrow(/credit_coin_flip_basis_check/);
      // A round stakes cards, tickets or both, never neither; only a win on cards carries Credit.
      await expect(em.execute('UPDATE coin_flip_round SET pull_id = NULL WHERE id = ?', [q.id])).rejects.toThrow(/coin_flip_round_stake_kind_check/);
      await expect(em.execute('UPDATE coin_flip_round SET credit_transaction_id = NULL WHERE id = ?', [q.id])).rejects.toThrow(/coin_flip_round_settlement_check/);
      await service.createLuckyDrawTickets([{ customer_id: input.customerId, delta: 3, reason: 'admin_grant', ref: `admin:${randomUUID()}` }]);
      const ticketRound = await service.quoteCoinFlip({ customerId: input.customerId, tickets: 3, chosenSide: 'head' });
      await expect(em.execute('UPDATE coin_flip_round SET ticket_stake = 0 WHERE id = ?', [ticketRound.id])).rejects.toThrow(/coin_flip_round_stake_kind_check/);
      await expect(em.execute('UPDATE coin_flip_round SET ticket_stake = 10001 WHERE id = ?', [ticketRound.id])).rejects.toThrow(/coin_flip_round_stake_kind_check/);
      await service.acceptCoinFlip({ customerId: input.customerId, roundId: ticketRound.id });
      expect(await service.luckyDrawBalance(input.customerId)).toBe(6);
      await expect(em.execute("UPDATE lucky_draw_ticket SET reason = 'made_up' WHERE ref = ?", [ticketRound.id])).rejects.toThrow(/lucky_draw_ticket_reason_check/);
      sql.length = 0;
      await tickets.down();
      await expect(em.execute(sql[0])).rejects.toThrow(/Ticket flips exist/);
      sql.length = 0;
      await migration.down();
      await expect(em.execute(sql[0])).rejects.toThrow(/history exists/);
      expect(await wins(input.customerId)).toHaveLength(1);
    });

    it('a stale buyback undo cannot revive a card after another undo and resale', async () => {
      const input = await seed();
      const sale = await service.buybackPullAtomic(input);
      const undo = { pullId: input.pullId, creditTransactionId: sale.creditTransactionId, restoreEarmark: false };
      const em = MikroOrmWrapper.forkManager();
      const observer = MikroOrmWrapper.forkManager();
      await em.begin();
      let pending: Promise<boolean> | undefined;
      try {
        await em.execute('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [`credit:${input.customerId}`]);
        pending = service.undoBuybackAtomic(undo);
        let waiting = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          const [row] = await observer.execute<{ waiting: boolean }[]>(
            "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE wait_event = 'advisory' AND query LIKE ?) AS waiting", [`%credit:${input.customerId}%`]);
          if (row.waiting) { waiting = true; break; }
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        expect(waiting).toBe(true);
        const context = { transactionManager: em } as unknown as Context;
        expect(await service.undoBuybackAtomic(undo, context)).toBe(true);
        const resale = await service.buybackPullAtomic(input, context);
        await em.commit();
        expect(await pending).toBe(false);
        expect((await pullState(input.pullId)).status).toBe('bought_back');
        expect(await service.listCreditTransactions({ id: resale.creditTransactionId })).toHaveLength(1);
      } catch (error) {
        if (em.isInTransaction()) await em.rollback();
        if (pending) await pending.catch(() => undefined);
        throw error;
      }
    });
  },
});
