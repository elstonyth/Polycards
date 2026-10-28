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
import { Migration20261028120000 } from '../migrations/Migration20261028120000';

jest.setTimeout(300_000);

moduleIntegrationTestRunner<PacksModuleService>({
  moduleName: PACKS_MODULE,
  resolve: path.resolve(__dirname, '../../..', 'modules/packs'),
  moduleModels: [CoinFlipConfig, CoinFlipRound, Pull, Card, FxRate, CreditTransaction,
    CustomerAccountState, LedgerEntry, LedgerSequence, AdminActionAudit, Pack, DeliveryOrder, DeliveryOrderItem],
  testSuite: ({ service, MikroOrmWrapper }) => {
    const settings = (win = 100) => ({ enabled: true, max_stake_amount: 1000,
      win_percent: win, win_percent_2: null, win_percent_3: null, published_win_percent: 50 });
    const configure = async (win = 100) => service.saveCoinFlipSettings({
      settings: settings(win), revision: (await service.coinFlipSettings()).revision,
      adminId: 'admin_coin', reason: 'Integration test configuration',
    });
    const seed = async (source: 'pack' | 'gift' | 'bonus' | 'free' = 'pack') => {
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

    it('forfeits on loss without a credit or inventory return and preserves its receipt after pause', async () => {
      await configure(0);
      const input = await seed();
      const q = await service.quoteCoinFlip(input);
      const result = await service.acceptCoinFlip({ customerId: input.customerId, roundId: q.id });
      expect(result).toMatchObject({ status: 'lost', win_amount: 0 });
      expect(await pullState(input.pullId)).toMatchObject({ status: 'forfeited', flip_version: 1, stock_earmarked: true });
      expect(await wins(input.customerId)).toHaveLength(0);
      expect(await service.listLedgerEntries({ type: 'CF', customer_id: input.customerId })).toHaveLength(1);
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
      await expect(service.quoteCoinFlip(input)).rejects.toThrow(/processing/i);
      await expect(service.finalizePullsForCoinFlip({ customerId: 'other', pullIds: [input.pullId] })).rejects.toThrow();
      await service.finalizePullsForCoinFlip({ customerId: input.customerId, pullIds: [input.pullId] });
      await service.finalizePullsForCoinFlip({ customerId: input.customerId, pullIds: [input.pullId] });
      expect((await service.quoteCoinFlip(input)).status).toBe('quoted');
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

    it('can sell after a win, preserving the gift buyback playthrough rule', async () => {
      const input = await seed('gift');
      const q = await service.quoteCoinFlip(input);
      await service.acceptCoinFlip({ customerId: input.customerId, roundId: q.id });
      const sold = await service.buybackPullAtomic(input);
      expect(sold.amount).toBeGreaterThan(0);
      const [credit] = await service.listCreditTransactions({ id: sold.creditTransactionId });
      expect(credit).toMatchObject({ reason: 'buyback', pull_id: input.pullId, external_funded_cents: Math.round(sold.amount * 100) });
      expect((await service.walletSummary(input.customerId)).playthrough.remaining).toBe(sold.amount);
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
      if (results[0].status === 'fulfilled') {
        const order = results[0].value;
        const transition = await service.transitionDeliveryOrderStatus({ orderId: order.orderId,
          to: 'canceled', trackingNumber: null, pullIds: [input.pullId] });
        const fresh = await service.quoteCoinFlip(input);
        await service.acceptCoinFlip({ customerId: input.customerId, roundId: fresh.id });
        await expect(service.undoDeliveryAtomic({ orderId: order.orderId, expectedStatus: 'canceled',
          pullVersions: transition.pullVersions, restorePulls: true,
          previous: { status: 'requested', tracking_number: null, shipped_at: null, delivered_at: null } })).rejects.toThrow(/changed/);
        expect((await pullState(input.pullId)).status).toBe('forfeited');
      }
    });

    it.each(['credit_transaction', 'ledger_entry', 'coin_flip_round'] as const)('rolls back if %s write fails', async table => {
      const input = await seed();
      const q = await service.quoteCoinFlip(input);
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

    it('applies real migration checks and refuses destructive rollback once a round exists', async () => {
      const em = MikroOrmWrapper.forkManager();
      const migration = Object.create(Migration20261028120000.prototype) as Migration20261028120000;
      const sql: string[] = [];
      migration.addSql = statement => { if (typeof statement !== 'string') throw new Error('Expected SQL text.'); sql.push(statement); };
      await migration.up();
      for (const statement of sql) await em.execute(statement);
      const input = await seed();
      const q = await service.quoteCoinFlip(input);
      await service.acceptCoinFlip({ customerId: input.customerId, roundId: q.id });
      await expect(em.execute("UPDATE credit_transaction SET bonus_cents = 1 WHERE reason = 'coin_flip_win'")).rejects.toThrow(/credit_coin_flip_basis_check/);
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
