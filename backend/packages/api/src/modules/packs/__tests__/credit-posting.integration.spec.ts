/**
 * Credit posting characterization (golden rows) — integration:modules.
 *
 * Pins every credit_transaction and ledger_entry column each credit-writing
 * site produced on 2026-11-15, BEFORE the credit-posting refactor
 * (plans/architecture-deepening/03-credit-posting-design.md). The refactor
 * moves these writes behind one entry point; this file is the proof that the
 * rows stayed identical to the sen.
 *
 * DO NOT EDIT THE GOLDEN ROWS. A later commit that needs a different row here
 * changed money behaviour, not structure. Interface assertions (replay,
 * floor, unfreeze, concurrency) live in their own specs.
 *
 * Normalised: ids become labels (so "ledger ref_id = the credit row" stays
 * asserted), timestamps and display_id are dropped, deleted_at becomes a
 * flag, rows are sorted by content. NULL stays distinct from 0 (D9).
 */

import path from 'path';
import { moduleIntegrationTestRunner } from '@medusajs/test-utils';
import { loadModels } from '@medusajs/framework/utils';
import type { Context } from '@medusajs/framework/types';
import { PACKS_MODULE } from '../index';
import type PacksModuleService from '../service';
import { CORE_CUSTOMER_MODELS } from '../test-support/core-customer-models';
import { snapshotAddress } from '../delivery';
import { referralWeekFor } from '../referral';

jest.setTimeout(300 * 1000);

type Row = Record<string, unknown>;
type Golden = { credits: Row[]; ledger: Row[] };

const ADDRESS = {
  first_name: 'Ada',
  last_name: 'Lovelace',
  address_1: '1 Analytical Engine Way',
  city: 'Kuala Lumpur',
  postal_code: '50000',
  country_code: 'my',
};

moduleIntegrationTestRunner<PacksModuleService>({
  moduleName: PACKS_MODULE,
  resolve: path.resolve(__dirname, '../../..', 'modules/packs'),
  moduleModels: [
    ...CORE_CUSTOMER_MODELS,
    // Each model file exports its model twice (named + default).
    ...new Set(loadModels(path.resolve(__dirname, '../models'))),
  ],
  testSuite: ({ service, MikroOrmWrapper }) => {
    const svc = service as unknown as Record<string, any>;
    const sql = () => MikroOrmWrapper.forkManager();
    // A transaction context for the private/protected writers that only run
    // composed (the same thing @InjectTransactionManager builds).
    const inTxn = <T>(fn: (ctx: Context) => Promise<T>): Promise<T> =>
      svc.baseRepository_.transaction((transactionManager: unknown) =>
        fn({ transactionManager } as Context),
      );

    // knex expands an array binding into a list, so IN (?) and never empty.
    const ids = async (table: string, column: string, customers: string[]) =>
      !customers.length ? [] : (
        await sql().execute(
          `SELECT id FROM ${table} WHERE ${column} IN (?) ORDER BY created_at, id`,
          [customers],
        )
      ).map((r: { id: string }) => r.id);

    // Every id the rows can mention, labelled. Longest first so an id that
    // prefixes another can't be half-replaced.
    const relabel = (value: unknown, labels: [string, string][]): unknown => {
      if (typeof value === 'string') {
        let out = value;
        for (const [id, label] of labels) out = out.split(id).join(label);
        return out;
      }
      if (Array.isArray(value)) return value.map((v) => relabel(v, labels));
      if (value && typeof value === 'object') {
        return Object.fromEntries(
          Object.entries(value as Row).map(([k, v]) => [k, relabel(v, labels)]),
        );
      }
      return value;
    };
    const strip = (row: Row, drop: string[]): Row => {
      const out: Row = {};
      for (const [k, v] of Object.entries(row)) {
        if (k === 'deleted_at') out.deleted = v !== null;
        else if (!drop.includes(k)) out[k] = v;
      }
      return out;
    };
    const byContent = (a: Row, b: Row) =>
      JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0;

    const golden = async (
      customers: string[],
      extra: [string, string][] = [],
    ): Promise<Golden> => {
      const em = sql();
      const credits: Row[] = await em.execute(
        'SELECT * FROM credit_transaction WHERE customer_id IN (?)',
        [customers],
      );
      const ledger: Row[] = await em.execute(
        'SELECT * FROM ledger_entry WHERE customer_id IN (?)',
        [customers],
      );
      const known: [string, string][] = [...extra];
      const add = (prefix: string, list: string[]) =>
        list.forEach((id, i) => known.push([id, `<${prefix}#${i}>`]));
      add('pull', await ids('pull', 'customer_id', customers));
      add('order', await ids('delivery_order', 'customer_id', customers));
      add('round', await ids('coin_flip_round', 'customer_id', customers));
      add('line', await ids('weekly_settlement_line', 'customer_id', customers));
      add('task', await ids('task_definition', 'id', (await em.execute(
        'SELECT task_id FROM task_claim WHERE customer_id IN (?)', [customers],
      )).map((r: { task_id: string }) => r.task_id)));

      // Credit labels follow content order, with every credit id masked so a
      // reversal's reference doesn't decide its own position.
      const creditIds = credits.map((c) => String(c.id));
      const masked = (c: Row) =>
        relabel(strip(c, ['id', 'created_at', 'updated_at']), [
          ...creditIds.map((id) => [id, '<ct>'] as [string, string]),
          ...known,
        ]) as Row;
      const order = [...credits].sort((a, b) => byContent(masked(a), masked(b)));
      order.forEach((c, i) => known.push([String(c.id), `<ct#${i}>`]));
      known.sort((a, b) => b[0].length - a[0].length);

      return {
        credits: order.map(
          (c) => relabel(strip(c, ['id', 'created_at', 'updated_at']), known) as Row,
        ),
        ledger: ledger
          .map(
            (l) =>
              relabel(
                strip(l, ['id', 'display_id', 'created_at', 'updated_at', 'occurred_at']),
                known,
              ) as Row,
          )
          .sort(byContent),
      };
    };

    const seed = (rows: Row[]) => service.createCreditTransactions(rows as never);

    it('topUpCreditsWithLedger: TP row per credit, a replay writes nothing', async () => {
      const c = 'cus_g_topup';
      const first = await service.topUpCreditsWithLedger({
        customerId: c, amount: 25.5, reason: 'topup', reference: 'gw-ref-1',
        idempotencyReference: 'topup-anchor-1', ledgerPaymentMethod: 'BQR',
        ledgerGatewayRef: 'gw-txn-1',
      });
      expect(first).toMatchObject({ balance: 25.5, amount: 25.5, replayed: false, reference: 'gw-ref-1' });
      const replay = await service.topUpCreditsWithLedger({
        customerId: c, amount: 25.5, reason: 'topup', reference: 'gw-ref-1b',
        idempotencyReference: 'topup-anchor-1', ledgerPaymentMethod: 'BQR',
        ledgerGatewayRef: 'gw-txn-1',
      });
      expect(replay).toMatchObject({ id: first.id, balance: 25.5, replayed: true, reference: 'gw-ref-1' });
      await service.topUpCreditsWithLedger({
        customerId: c, amount: 10.004, reason: 'topup', reference: 'gw-ref-2',
        idempotencyReference: 'topup-anchor-2',
      });
      expect(await golden([c])).toEqual(GOLDEN.topup);
    });

    it('withdrawCreditsWithLedger: WD debit and refund, refund replay writes nothing', async () => {
      const c = 'cus_g_wd';
      await seed([{ customer_id: c, amount: 100, reason: 'topup', external_funded_cents: 10000 }]);
      const ledger = (outcome: 'requested' | 'refunded') => ({
        outcome, bankCode: 'MBBEMYKL', accountNumber: '1234567890', gatewayRef: 'payout-1',
      });
      await service.withdrawCreditsWithLedger({
        customerId: c, amount: -40, reason: 'cashout', reference: 'payout-1',
        idempotencyReference: 'wd:payout-1', floor: 0, ledger: ledger('requested'),
      });
      for (let i = 0; i < 2; i++) {
        await service.withdrawCreditsWithLedger({
          customerId: c, amount: 40, reason: 'cashout', reference: 'payout-1',
          idempotencyReference: 'wd-refund:payout-1', ledger: ledger('refunded'),
        });
      }
      expect(await golden([c])).toEqual(GOLDEN.withdraw);
    });

    it('adminAdjustCredit: AD rows for adjustment and bonus_grant, keyed replay writes nothing', async () => {
      const c = 'cus_g_adj';
      const grant = { customerId: c, amount: 30, note: 'goodwill', adminId: 'admin_g', idempotencyKey: 'k1' };
      const first = await service.adminAdjustCredit(grant);
      expect(first).toMatchObject({ amount: 30, balance: 30 });
      await service.adminAdjustCredit(grant);
      await service.adminAdjustCredit({ customerId: c, amount: -5.25, note: 'clawback', adminId: 'admin_g' });
      await service.adminAdjustCredit({ customerId: c, amount: 8, note: 'promo', adminId: 'admin_g', idempotencyKey: 'k2', bonus: true });
      await service.adminAdjustCredit({ customerId: c, amount: -3, note: 'promo back', adminId: 'admin_g', bonus: true });
      await expect(
        service.adminAdjustCredit({ customerId: c, amount: -9, note: 'too much bonus', adminId: 'admin_g', bonus: true }),
      ).rejects.toThrow('Bonus credit cannot go below RM 0 (bonus balance RM 5.00).');
      await expect(
        service.adminAdjustCredit({ customerId: c, amount: -26, note: 'into bonus', adminId: 'admin_g' }),
      ).rejects.toThrow("Bonus credit can only be spent on packs — it can't pay for this.");
      expect(await golden([c])).toEqual(GOLDEN.adjust);
    });

    it('mutateCreditAtomic: floor refusal writes nothing; pack_open (no bonus) consumes external', async () => {
      const c = 'cus_g_mut';
      await seed([
        { customer_id: c, amount: 10, reason: 'topup', external_funded_cents: 1000 },
        { customer_id: c, amount: 5, reason: 'adjustment', external_funded_cents: 0 },
      ]);
      await expect(
        service.mutateCreditAtomic({ customerId: c, amount: -20, reason: 'adjustment', reference: 'too much', floor: 0 }),
      ).rejects.toThrow("Deduction exceeds the customer's balance (RM 15.00) — the balance cannot go below RM 0.00.");
      const open = await service.mutateCreditAtomic({
        customerId: c, amount: -12.5, reason: 'pack_open', sourceTransactionId: 'open_g_m1',
      });
      expect(open).toMatchObject({ balance: 2.5, amount: -12.5, replayed: false });
      expect(await golden([c])).toEqual(GOLDEN.mutate);
    });

    it('settleOpen + reverseOpen: bonus first, then external; reversal mirrors; replays write nothing', async () => {
      const c = 'cus_g_open';
      await seed([
        { customer_id: c, amount: 20, reason: 'topup', external_funded_cents: 2000, bonus_cents: 0 },
        { customer_id: c, amount: 5, reason: 'bonus_grant', external_funded_cents: 0, bonus_cents: 500 },
      ]);
      const res = await service.settleOpen({ customerId: c, amount: -12, sourceTransactionId: 'open_g_1' });
      expect(res).toMatchObject({ balance: 13, bonusCents: 500 });
      await expect(
        service.settleOpen({ customerId: c, amount: -1, sourceTransactionId: 'open_g_1' }),
      ).rejects.toThrow("Open 'open_g_1' has already been settled.");
      expect(await service.reverseOpen('open_g_1')).toEqual({ reversed: 1 });
      expect(await service.reverseOpen('open_g_1')).toEqual({ reversed: 0 });
      expect(await golden([c])).toEqual(GOLDEN.open);
    });

    it('claimReward voucher: whole-row bonus, voucher: anchor, NO ledger row (D6)', async () => {
      const c = 'cus_g_voucher';
      const prev = process.env.REWARDS_REDEMPTION_ENABLED;
      process.env.REWARDS_REDEMPTION_ENABLED = 'true';
      try {
        await service.createVipRewardGrants([
          { id: 'vrg_g_voucher', customer_id: c, level: 2, kind: 'voucher',
            payload: { amount_myr: 5 }, status: 'granted', source_open_id: 'open_seed' },
        ]);
        expect(await service.claimReward(c, 'vrg_g_voucher')).toMatchObject({ claimed: true, amount_myr: 5 });
      } finally {
        if (prev === undefined) delete process.env.REWARDS_REDEMPTION_ENABLED;
        else process.env.REWARDS_REDEMPTION_ENABLED = prev;
      }
      expect(await golden([c])).toEqual(GOLDEN.voucher);
    });

    it('claimTask: reward_credit bonus row + WP keyed on the credit row', async () => {
      const c = 'cus_g_task';
      await service.saveTaskDefinition({
        kind: 'weekly', title: 'Check in 1 day',
        requirement: { type: 'checkin_days', days: 1 },
        reward: { type: 'credit', amount_myr: 2.5 },
        active: true, sort: 0, adminId: 'admin_g', reason: 'seed',
      });
      await service.checkInDaily({ customerId: c });
      const [task] = await service.listTaskDefinitions({});
      expect(await service.claimTask({ customerId: c, taskId: task.id })).toMatchObject({ claimed: true });
      const [claim] = await service.listTaskClaims({ customer_id: c });
      expect(await golden([c], [[`:${claim.period_key}`, ':<period>']])).toEqual(GOLDEN.task);
    });

    it('settleChallengeWinner: reward_credit bonus row + WP keyed on the challenge anchor', async () => {
      const c = 'cus_g_chal';
      const weekStart = new Date('2026-11-02T00:00:00.000Z');
      const weekEnd = new Date('2026-11-09T00:00:00.000Z');
      await svc.settleChallengeWinner({
        weekStart, weekEnd, customerId: c, rank: 1,
        payout: { rank: 1, credits: 15, cardIds: [] },
        handleById: new Map(),
        snapshot: { pool_myr: 100, unlocked_stages: [1], week_end: weekEnd.toISOString(), ranking: [c] },
      });
      expect(await golden([c])).toEqual(GOLDEN.challenge);
    });

    it('payLuckyDrawPrize: reward_credit bonus row + WP keyed on the credit row', async () => {
      const c = 'cus_g_draw';
      await inTxn((ctx) =>
        svc.payLuckyDrawPrize({ id: 'ldp_g_1', kind: 'credit', credit_myr: 9.99 }, c, null, ctx),
      );
      expect(await golden([c])).toEqual(GOLDEN.luckydraw);
    });

    describe('deliveries', () => {
      const prevGate = process.env.REWARDS_REDEMPTION_ENABLED;
      beforeAll(() => { delete process.env.REWARDS_REDEMPTION_ENABLED; });
      afterAll(() => {
        if (prevGate === undefined) delete process.env.REWARDS_REDEMPTION_ENABLED;
        else process.env.REWARDS_REDEMPTION_ENABLED = prevGate;
      });
      const card = (handle: string, usd: number) => service.createCards([
        { handle, name: handle, set: 'Base', grader: 'PSA', grade: '10', market_value: usd, image: 'x.webp' },
      ]);
      const pull = async (customer: string, handle: string, source: 'pack' | 'reward') =>
        (await service.createPulls([
          { customer_id: customer, pack_id: 'g-pack', card_id: handle, order_id: null, rolled_at: new Date(), source },
        ]))[0].id;

      it('createDeliveryOrderWithLedger + cancel: fee bonus first, refund returns the bonus part', async () => {
        const c = 'cus_g_del';
        await card('g-del-card', 10);
        await seed([
          { customer_id: c, amount: 50, reason: 'topup', external_funded_cents: 5000, bonus_cents: 0 },
          { customer_id: c, amount: 3, reason: 'bonus_grant', external_funded_cents: 0, bonus_cents: 300 },
        ]);
        const p = await pull(c, 'g-del-card', 'pack');
        const { orderId } = await service.createDeliveryOrderWithLedger({
          customerId: c, snapshot: snapshotAddress(ADDRESS)!, pullIds: [p], fx: 4,
        });
        await service.transitionDeliveryOrderStatus({ orderId, to: 'canceled', trackingNumber: null, pullIds: [p] });
        expect(await golden([c])).toEqual(GOLDEN.delivery);
      });

      it('recordRewardWithdrawal: prize fee + OD with vault 0', async () => {
        const c = 'cus_g_rwd';
        await card('g-rwd-card', 10);
        await seed([{ customer_id: c, amount: 50, reason: 'topup', external_funded_cents: 5000, bonus_cents: 0 }]);
        const p = await pull(c, 'g-rwd-card', 'reward');
        expect(await service.recordRewardWithdrawal(c, p, ADDRESS)).toMatchObject({ status: 'requested' });
        expect(await golden([c])).toEqual(GOLDEN.rewardDelivery);
      });
    });

    describe('cards', () => {
      beforeEach(async () => {
        const em = sql();
        await em.execute('TRUNCATE customer_group_customer, customer_group CASCADE');
        await service.createFxRates([{ pair: 'USD_MYR', rate: 4, source: 'test', manual_override: false }]);
      });
      const card = (handle: string) => service.createCards([
        { handle, name: 'Pikachu', set: 'Base', grader: 'PSA', grade: '10',
          market_value: 20, market_multiplier: 1.25, image: '/pikachu.png' },
      ]);
      const pull = async (customer: string, handle: string, bonusBp: number) =>
        (await service.createPulls([
          { customer_id: customer, card_id: handle, pack_id: 'g-pack', rolled_at: new Date(),
            source: 'pack', bonus_bp: bonusBp, stock_earmarked: true,
            flip_eligible_at: new Date(), instant_closed_at: new Date() },
        ]))[0].id;

      it('buybackPullAtomic: SE keyed on the credit row; playthrough ext only with a bonus share; undo hard-deletes both', async () => {
        const c = 'cus_g_bb';
        await service.createPacks([{ slug: 'g-pack', title: 'G pack', category: 'pokemon',
          price: 10, image: '/pack.png', buyback_percent: 90 }]);
        await card('g-bb-card');
        const plain = await pull(c, 'g-bb-card', 0);
        const held = await pull(c, 'g-bb-card', 5000);
        const third = await pull(c, 'g-bb-card', 0);
        expect(await service.buybackPullAtomic({ customerId: c, pullId: plain })).toMatchObject({ amount: 90, rate_type: 'vault' });
        await service.buybackPullAtomic({ customerId: c, pullId: held });
        const undone = await service.buybackPullAtomic({ customerId: c, pullId: third });
        expect(await service.undoBuybackAtomic({
          pullId: third, creditTransactionId: undone.creditTransactionId, restoreEarmark: false,
        })).toBe(true);
        expect(await golden([c])).toEqual(GOLDEN.buyback);
      });

      it('acceptCoinFlip: a win pays coin_flip_win + CF; a loss writes CF only', async () => {
        const configure = async (win: number) => service.saveCoinFlipSettings({
          settings: { enabled: true, win_percent: win, win_percent_2: null, win_percent_3: null, published_win_percent: 50 },
          revision: (await service.coinFlipSettings()).revision,
          adminId: 'admin_g', reason: 'Golden rows',
        });
        for (const [c, win] of [['cus_g_cf_win', 100], ['cus_g_cf_loss', 0]] as const) {
          await configure(win);
          await card(c);
          const p = await pull(c, c, 0);
          await seed([
            { customer_id: c, amount: 10, reason: 'topup', external_funded_cents: 1000 },
            { customer_id: c, amount: -10, reason: 'pack_open', external_funded_cents: -1000 },
          ]);
          const q = await service.quoteCoinFlip({ customerId: c, pullIds: [p], chosenSide: 'head' });
          expect(await service.acceptCoinFlip({ customerId: c, roundId: q.id })).toMatchObject({
            status: win ? 'won' : 'lost',
          });
        }
        expect(await golden(['cus_g_cf_win', 'cus_g_cf_loss'])).toEqual(GOLDEN.coinFlip);
      });
    });

    it('payWeeklySettlement: RF ledger first, NULL-column commission credit (D1, D9), re-pay writes nothing', async () => {
      const week = referralWeekFor(new Date());
      await service.createReferralAttributions([{ customer_id: 'cus_g_ref_a', referrer_id: 'cus_g_ref_r' }]);
      await seed([{ customer_id: 'cus_g_ref_a', amount: -1000, reason: 'pack_open' }]);
      const run = await service.closeReferralWeek({ weekStartIso: week.weekStartIso });
      await service.approveWeeklySettlement({ settlementId: run.settlementId!, adminId: 'admin_g' });
      expect(await service.payWeeklySettlement({ settlementId: run.settlementId! })).toMatchObject({ paid: 1 });
      await service.payWeeklySettlement({ settlementId: run.settlementId! });
      const [line] = await service.listWeeklySettlementLines({ customer_id: 'cus_g_ref_r' });
      const [settled] = await service.listWeeklySettlements({ id: run.settlementId! });
      const weekIso = new Date(settled.week_start).toISOString().slice(0, 10);
      const all = await golden(['cus_g_ref_r'], [[weekIso, '<week>']]);
      const [ct] = (await sql().execute(
        'SELECT id FROM credit_transaction WHERE customer_id = ?', ['cus_g_ref_r'],
      )) as { id: string }[];
      expect({ ...all, line: { status: line.status, paid: line.paid_transaction_id === ct.id } })
        .toEqual(GOLDEN.referral);
    });
  },
});

// Captured from the code at master f15fbe81d (2026-11-15). Never edit.
const GOLDEN: Record<string, unknown> = {
  "topup": {
    "credits": [
      {
        "customer_id": "cus_g_topup",
        "amount": "10",
        "reason": "topup",
        "pull_id": null,
        "reference": "gw-ref-2",
        "external_funded_cents": 1000,
        "source_transaction_id": "topup-anchor-2",
        "bonus_cents": 0,
        "raw_amount": {
          "value": "10",
          "precision": 20
        },
        "deleted": false
      },
      {
        "customer_id": "cus_g_topup",
        "amount": "25.5",
        "reason": "topup",
        "pull_id": null,
        "reference": "gw-ref-1",
        "external_funded_cents": 2550,
        "source_transaction_id": "topup-anchor-1",
        "bonus_cents": 0,
        "raw_amount": {
          "value": "25.5",
          "precision": 20
        },
        "deleted": false
      }
    ],
    "ledger": [
      {
        "type": "TP",
        "customer_id": "cus_g_topup",
        "wallet_delta": "10",
        "vault_delta": null,
        "payload": {
          "type": "TP",
          "gateway_ref": "gw-ref-2",
          "payment_method": "mock"
        },
        "ref_id": "<ct#0>",
        "raw_wallet_delta": {
          "value": "10",
          "precision": 20
        },
        "raw_vault_delta": null,
        "deleted": false
      },
      {
        "type": "TP",
        "customer_id": "cus_g_topup",
        "wallet_delta": "25.5",
        "vault_delta": null,
        "payload": {
          "type": "TP",
          "gateway_ref": "gw-txn-1",
          "payment_method": "BQR"
        },
        "ref_id": "<ct#1>",
        "raw_wallet_delta": {
          "value": "25.5",
          "precision": 20
        },
        "raw_vault_delta": null,
        "deleted": false
      }
    ]
  },
  "withdraw": {
    "credits": [
      {
        "customer_id": "cus_g_wd",
        "amount": "-40",
        "reason": "cashout",
        "pull_id": null,
        "reference": "payout-1",
        "external_funded_cents": 0,
        "source_transaction_id": "wd:payout-1",
        "bonus_cents": 0,
        "raw_amount": {
          "value": "-40",
          "precision": 20
        },
        "deleted": false
      },
      {
        "customer_id": "cus_g_wd",
        "amount": "100",
        "reason": "topup",
        "pull_id": null,
        "reference": null,
        "external_funded_cents": 10000,
        "source_transaction_id": null,
        "bonus_cents": null,
        "raw_amount": {
          "value": "100",
          "precision": 20
        },
        "deleted": false
      },
      {
        "customer_id": "cus_g_wd",
        "amount": "40",
        "reason": "cashout",
        "pull_id": null,
        "reference": "payout-1",
        "external_funded_cents": 0,
        "source_transaction_id": "wd-refund:payout-1",
        "bonus_cents": 0,
        "raw_amount": {
          "value": "40",
          "precision": 20
        },
        "deleted": false
      }
    ],
    "ledger": [
      {
        "type": "WD",
        "customer_id": "cus_g_wd",
        "wallet_delta": "-40",
        "vault_delta": null,
        "payload": {
          "type": "WD",
          "outcome": "requested",
          "bank_code": "MBBEMYKL",
          "gateway_ref": "payout-1",
          "account_last4": "7890"
        },
        "ref_id": "<ct#0>",
        "raw_wallet_delta": {
          "value": "-40",
          "precision": 20
        },
        "raw_vault_delta": null,
        "deleted": false
      },
      {
        "type": "WD",
        "customer_id": "cus_g_wd",
        "wallet_delta": "40",
        "vault_delta": null,
        "payload": {
          "type": "WD",
          "outcome": "refunded",
          "bank_code": "MBBEMYKL",
          "gateway_ref": "payout-1",
          "account_last4": "7890"
        },
        "ref_id": "<ct#2>",
        "raw_wallet_delta": {
          "value": "40",
          "precision": 20
        },
        "raw_vault_delta": null,
        "deleted": false
      }
    ]
  },
  "adjust": {
    "credits": [
      {
        "customer_id": "cus_g_adj",
        "amount": "-3",
        "reason": "bonus_grant",
        "pull_id": null,
        "reference": "promo back",
        "external_funded_cents": 0,
        "source_transaction_id": null,
        "bonus_cents": -300,
        "raw_amount": {
          "value": "-3",
          "precision": 20
        },
        "deleted": false
      },
      {
        "customer_id": "cus_g_adj",
        "amount": "-5.25",
        "reason": "adjustment",
        "pull_id": null,
        "reference": "clawback",
        "external_funded_cents": 0,
        "source_transaction_id": null,
        "bonus_cents": 0,
        "raw_amount": {
          "value": "-5.25",
          "precision": 20
        },
        "deleted": false
      },
      {
        "customer_id": "cus_g_adj",
        "amount": "30",
        "reason": "adjustment",
        "pull_id": null,
        "reference": "goodwill",
        "external_funded_cents": 0,
        "source_transaction_id": "adjust-idem:27e2c3dab838fc7aebaa309966e038ba919f33fed0f446fd3f2475d284c014b1",
        "bonus_cents": 0,
        "raw_amount": {
          "value": "30",
          "precision": 20
        },
        "deleted": false
      },
      {
        "customer_id": "cus_g_adj",
        "amount": "8",
        "reason": "bonus_grant",
        "pull_id": null,
        "reference": "promo",
        "external_funded_cents": 0,
        "source_transaction_id": "adjust-idem:68a7dd9d5ccef25cd8ddd907680876b8e797cf9212c8fc8381f0c70065d0f498",
        "bonus_cents": 800,
        "raw_amount": {
          "value": "8",
          "precision": 20
        },
        "deleted": false
      }
    ],
    "ledger": [
      {
        "type": "AD",
        "customer_id": "cus_g_adj",
        "wallet_delta": "-3",
        "vault_delta": null,
        "payload": {
          "type": "AD",
          "detail": "bonus",
          "reason": "promo back",
          "admin_id": "admin_g",
          "card_handle": null
        },
        "ref_id": "<ct#0>",
        "raw_wallet_delta": {
          "value": "-3",
          "precision": 20
        },
        "raw_vault_delta": null,
        "deleted": false
      },
      {
        "type": "AD",
        "customer_id": "cus_g_adj",
        "wallet_delta": "-5.25",
        "vault_delta": null,
        "payload": {
          "type": "AD",
          "detail": null,
          "reason": "clawback",
          "admin_id": "admin_g",
          "card_handle": null
        },
        "ref_id": "<ct#1>",
        "raw_wallet_delta": {
          "value": "-5.25",
          "precision": 20
        },
        "raw_vault_delta": null,
        "deleted": false
      },
      {
        "type": "AD",
        "customer_id": "cus_g_adj",
        "wallet_delta": "30",
        "vault_delta": null,
        "payload": {
          "type": "AD",
          "detail": null,
          "reason": "goodwill",
          "admin_id": "admin_g",
          "card_handle": null
        },
        "ref_id": "<ct#2>",
        "raw_wallet_delta": {
          "value": "30",
          "precision": 20
        },
        "raw_vault_delta": null,
        "deleted": false
      },
      {
        "type": "AD",
        "customer_id": "cus_g_adj",
        "wallet_delta": "8",
        "vault_delta": null,
        "payload": {
          "type": "AD",
          "detail": "bonus",
          "reason": "promo",
          "admin_id": "admin_g",
          "card_handle": null
        },
        "ref_id": "<ct#3>",
        "raw_wallet_delta": {
          "value": "8",
          "precision": 20
        },
        "raw_vault_delta": null,
        "deleted": false
      }
    ]
  },
  "mutate": {
    "credits": [
      {
        "customer_id": "cus_g_mut",
        "amount": "-12.5",
        "reason": "pack_open",
        "pull_id": null,
        "reference": null,
        "external_funded_cents": -1000,
        "source_transaction_id": "open_g_m1",
        "bonus_cents": 0,
        "raw_amount": {
          "value": "-12.5",
          "precision": 20
        },
        "deleted": false
      },
      {
        "customer_id": "cus_g_mut",
        "amount": "10",
        "reason": "topup",
        "pull_id": null,
        "reference": null,
        "external_funded_cents": 1000,
        "source_transaction_id": null,
        "bonus_cents": null,
        "raw_amount": {
          "value": "10",
          "precision": 20
        },
        "deleted": false
      },
      {
        "customer_id": "cus_g_mut",
        "amount": "5",
        "reason": "adjustment",
        "pull_id": null,
        "reference": null,
        "external_funded_cents": 0,
        "source_transaction_id": null,
        "bonus_cents": null,
        "raw_amount": {
          "value": "5",
          "precision": 20
        },
        "deleted": false
      }
    ],
    "ledger": []
  },
  "open": {
    "credits": [
      {
        "customer_id": "cus_g_open",
        "amount": "-12",
        "reason": "pack_open",
        "pull_id": null,
        "reference": null,
        "external_funded_cents": -700,
        "source_transaction_id": "open_g_1",
        "bonus_cents": -500,
        "raw_amount": {
          "value": "-12",
          "precision": 20
        },
        "deleted": false
      },
      {
        "customer_id": "cus_g_open",
        "amount": "12",
        "reason": "pack_open",
        "pull_id": null,
        "reference": "reversal:<ct#0>",
        "external_funded_cents": 700,
        "source_transaction_id": "open_g_1",
        "bonus_cents": 500,
        "raw_amount": {
          "value": "12",
          "precision": 20
        },
        "deleted": false
      },
      {
        "customer_id": "cus_g_open",
        "amount": "20",
        "reason": "topup",
        "pull_id": null,
        "reference": null,
        "external_funded_cents": 2000,
        "source_transaction_id": null,
        "bonus_cents": 0,
        "raw_amount": {
          "value": "20",
          "precision": 20
        },
        "deleted": false
      },
      {
        "customer_id": "cus_g_open",
        "amount": "5",
        "reason": "bonus_grant",
        "pull_id": null,
        "reference": null,
        "external_funded_cents": 0,
        "source_transaction_id": null,
        "bonus_cents": 500,
        "raw_amount": {
          "value": "5",
          "precision": 20
        },
        "deleted": false
      }
    ],
    "ledger": []
  },
  "voucher": {
    "credits": [
      {
        "customer_id": "cus_g_voucher",
        "amount": "5",
        "reason": "voucher_claim",
        "pull_id": null,
        "reference": null,
        "external_funded_cents": 0,
        "source_transaction_id": "voucher:vrg_g_voucher",
        "bonus_cents": 500,
        "raw_amount": {
          "value": "5",
          "precision": 20
        },
        "deleted": false
      }
    ],
    "ledger": []
  },
  "task": {
    "credits": [
      {
        "customer_id": "cus_g_task",
        "amount": "2.5",
        "reason": "reward_credit",
        "pull_id": null,
        "reference": null,
        "external_funded_cents": 0,
        "source_transaction_id": "task:<task#0>:cus_g_task:<period>",
        "bonus_cents": 250,
        "raw_amount": {
          "value": "2.5",
          "precision": 20
        },
        "deleted": false
      }
    ],
    "ledger": [
      {
        "type": "WP",
        "customer_id": "cus_g_task",
        "wallet_delta": "2.5",
        "vault_delta": null,
        "payload": {
          "sku": null,
          "rank": 0,
          "type": "WP",
          "stage": 0,
          "value": 0,
          "period": "task:<task#0>:<period>"
        },
        "ref_id": "<ct#0>",
        "raw_wallet_delta": {
          "value": "2.5",
          "precision": 20
        },
        "raw_vault_delta": null,
        "deleted": false
      }
    ]
  },
  "challenge": {
    "credits": [
      {
        "customer_id": "cus_g_chal",
        "amount": "15",
        "reason": "reward_credit",
        "pull_id": null,
        "reference": null,
        "external_funded_cents": 0,
        "source_transaction_id": "challenge:2026-11-02T00:00:00.000Z:cus_g_chal",
        "bonus_cents": 1500,
        "raw_amount": {
          "value": "15",
          "precision": 20
        },
        "deleted": false
      }
    ],
    "ledger": [
      {
        "type": "WP",
        "customer_id": "cus_g_chal",
        "wallet_delta": "15",
        "vault_delta": null,
        "payload": {
          "sku": null,
          "rank": 1,
          "type": "WP",
          "stage": 1,
          "value": 0,
          "period": "2026-11-02T00:00:00.000Z"
        },
        "ref_id": "challenge:2026-11-02T00:00:00.000Z:cus_g_chal",
        "raw_wallet_delta": {
          "value": "15",
          "precision": 20
        },
        "raw_vault_delta": null,
        "deleted": false
      }
    ]
  },
  "luckydraw": {
    "credits": [
      {
        "customer_id": "cus_g_draw",
        "amount": "9.99",
        "reason": "reward_credit",
        "pull_id": null,
        "reference": null,
        "external_funded_cents": 0,
        "source_transaction_id": "luckydraw:ldp_g_1",
        "bonus_cents": 999,
        "raw_amount": {
          "value": "9.99",
          "precision": 20
        },
        "deleted": false
      }
    ],
    "ledger": [
      {
        "type": "WP",
        "customer_id": "cus_g_draw",
        "wallet_delta": "9.99",
        "vault_delta": null,
        "payload": {
          "sku": null,
          "rank": 0,
          "type": "WP",
          "stage": 0,
          "value": 0,
          "period": "luckydraw:ldp_g_1"
        },
        "ref_id": "<ct#0>",
        "raw_wallet_delta": {
          "value": "9.99",
          "precision": 20
        },
        "raw_vault_delta": null,
        "deleted": false
      }
    ]
  },
  "delivery": {
    "credits": [
      {
        "customer_id": "cus_g_del",
        "amount": "-15",
        "reason": "delivery_fee",
        "pull_id": null,
        "reference": "<order#0>",
        "external_funded_cents": 0,
        "source_transaction_id": null,
        "bonus_cents": -300,
        "raw_amount": {
          "value": "-15",
          "precision": 20
        },
        "deleted": false
      },
      {
        "customer_id": "cus_g_del",
        "amount": "15",
        "reason": "delivery_fee",
        "pull_id": null,
        "reference": "refund:<order#0>",
        "external_funded_cents": 0,
        "source_transaction_id": null,
        "bonus_cents": 300,
        "raw_amount": {
          "value": "15",
          "precision": 20
        },
        "deleted": false
      },
      {
        "customer_id": "cus_g_del",
        "amount": "3",
        "reason": "bonus_grant",
        "pull_id": null,
        "reference": null,
        "external_funded_cents": 0,
        "source_transaction_id": null,
        "bonus_cents": 300,
        "raw_amount": {
          "value": "3",
          "precision": 20
        },
        "deleted": false
      },
      {
        "customer_id": "cus_g_del",
        "amount": "50",
        "reason": "topup",
        "pull_id": null,
        "reference": null,
        "external_funded_cents": 5000,
        "source_transaction_id": null,
        "bonus_cents": 0,
        "raw_amount": {
          "value": "50",
          "precision": 20
        },
        "deleted": false
      }
    ],
    "ledger": [
      {
        "type": "OD",
        "customer_id": "cus_g_del",
        "wallet_delta": "-15",
        "vault_delta": "-48",
        "payload": {
          "type": "OD",
          "status": "requested",
          "handles": [
            {
              "qty": 1,
              "card_handle": "g-del-card"
            }
          ],
          "shipping_fee": 15,
          "insurance_fee": 0
        },
        "ref_id": "<order#0>",
        "raw_wallet_delta": {
          "value": "-15",
          "precision": 20
        },
        "raw_vault_delta": {
          "value": "-48",
          "precision": 20
        },
        "deleted": false
      },
      {
        "type": "OD",
        "customer_id": "cus_g_del",
        "wallet_delta": "15",
        "vault_delta": "48",
        "payload": {
          "type": "OD",
          "status": "canceled",
          "handles": [
            {
              "qty": 1,
              "card_handle": "g-del-card"
            }
          ]
        },
        "ref_id": "cancel:<order#0>",
        "raw_wallet_delta": {
          "value": "15",
          "precision": 20
        },
        "raw_vault_delta": {
          "value": "48",
          "precision": 20
        },
        "deleted": false
      }
    ]
  },
  "rewardDelivery": {
    "credits": [
      {
        "customer_id": "cus_g_rwd",
        "amount": "-15",
        "reason": "delivery_fee",
        "pull_id": null,
        "reference": "<order#0>",
        "external_funded_cents": 0,
        "source_transaction_id": null,
        "bonus_cents": 0,
        "raw_amount": {
          "value": "-15",
          "precision": 20
        },
        "deleted": false
      },
      {
        "customer_id": "cus_g_rwd",
        "amount": "50",
        "reason": "topup",
        "pull_id": null,
        "reference": null,
        "external_funded_cents": 5000,
        "source_transaction_id": null,
        "bonus_cents": 0,
        "raw_amount": {
          "value": "50",
          "precision": 20
        },
        "deleted": false
      }
    ],
    "ledger": [
      {
        "type": "OD",
        "customer_id": "cus_g_rwd",
        "wallet_delta": "-15",
        "vault_delta": "0",
        "payload": {
          "type": "OD",
          "status": "requested",
          "handles": [
            {
              "qty": 1,
              "card_handle": "g-rwd-card"
            }
          ],
          "shipping_fee": 15,
          "insurance_fee": 0
        },
        "ref_id": "<order#0>",
        "raw_wallet_delta": {
          "value": "-15",
          "precision": 20
        },
        "raw_vault_delta": {
          "value": "0",
          "precision": 20
        },
        "deleted": false
      }
    ]
  },
  "buyback": {
    "credits": [
      {
        "customer_id": "cus_g_bb",
        "amount": "90",
        "reason": "buyback",
        "pull_id": "<pull#0>",
        "reference": null,
        "external_funded_cents": null,
        "source_transaction_id": null,
        "bonus_cents": null,
        "raw_amount": {
          "value": "90",
          "precision": 20
        },
        "deleted": false
      },
      {
        "customer_id": "cus_g_bb",
        "amount": "90",
        "reason": "buyback",
        "pull_id": "<pull#1>",
        "reference": null,
        "external_funded_cents": 4500,
        "source_transaction_id": null,
        "bonus_cents": null,
        "raw_amount": {
          "value": "90",
          "precision": 20
        },
        "deleted": false
      }
    ],
    "ledger": [
      {
        "type": "SE",
        "customer_id": "cus_g_bb",
        "wallet_delta": "90",
        "vault_delta": "-100",
        "payload": {
          "rate": 0.9,
          "type": "SE",
          "price": 100,
          "sp_ref_id": null,
          "card_handle": "g-bb-card",
          "playthrough": 45
        },
        "ref_id": "<ct#1>",
        "raw_wallet_delta": {
          "value": "90",
          "precision": 20
        },
        "raw_vault_delta": {
          "value": "-100",
          "precision": 20
        },
        "deleted": false
      },
      {
        "type": "SE",
        "customer_id": "cus_g_bb",
        "wallet_delta": "90",
        "vault_delta": "-100",
        "payload": {
          "rate": 0.9,
          "type": "SE",
          "price": 100,
          "sp_ref_id": null,
          "card_handle": "g-bb-card"
        },
        "ref_id": "<ct#0>",
        "raw_wallet_delta": {
          "value": "90",
          "precision": 20
        },
        "raw_vault_delta": {
          "value": "-100",
          "precision": 20
        },
        "deleted": false
      }
    ]
  },
  "coinFlip": {
    "credits": [
      {
        "customer_id": "cus_g_cf_loss",
        "amount": "-10",
        "reason": "pack_open",
        "pull_id": null,
        "reference": null,
        "external_funded_cents": -1000,
        "source_transaction_id": null,
        "bonus_cents": null,
        "raw_amount": {
          "value": "-10",
          "precision": 20
        },
        "deleted": false
      },
      {
        "customer_id": "cus_g_cf_loss",
        "amount": "10",
        "reason": "topup",
        "pull_id": null,
        "reference": null,
        "external_funded_cents": 1000,
        "source_transaction_id": null,
        "bonus_cents": null,
        "raw_amount": {
          "value": "10",
          "precision": 20
        },
        "deleted": false
      },
      {
        "customer_id": "cus_g_cf_win",
        "amount": "-10",
        "reason": "pack_open",
        "pull_id": null,
        "reference": null,
        "external_funded_cents": -1000,
        "source_transaction_id": null,
        "bonus_cents": null,
        "raw_amount": {
          "value": "-10",
          "precision": 20
        },
        "deleted": false
      },
      {
        "customer_id": "cus_g_cf_win",
        "amount": "10",
        "reason": "topup",
        "pull_id": null,
        "reference": null,
        "external_funded_cents": 1000,
        "source_transaction_id": null,
        "bonus_cents": null,
        "raw_amount": {
          "value": "10",
          "precision": 20
        },
        "deleted": false
      },
      {
        "customer_id": "cus_g_cf_win",
        "amount": "100",
        "reason": "coin_flip_win",
        "pull_id": null,
        "reference": "<round#0>",
        "external_funded_cents": 0,
        "source_transaction_id": "coin-flip:<round#0>",
        "bonus_cents": 0,
        "raw_amount": {
          "value": "100",
          "precision": 20
        },
        "deleted": false
      }
    ],
    "ledger": [
      {
        "type": "CF",
        "customer_id": "cus_g_cf_loss",
        "wallet_delta": "0",
        "vault_delta": "-100",
        "payload": {
          "type": "CF",
          "cards": [
            {
              "value": 100,
              "pull_id": "<pull#1>",
              "card_handle": "cus_g_cf_loss"
            }
          ],
          "value": 100,
          "outcome": "lost",
          "pull_id": "<pull#1>",
          "round_id": "<round#1>",
          "card_handle": "cus_g_cf_loss",
          "chosen_side": "head",
          "landed_side": "tail",
          "published_win_percent": 50
        },
        "ref_id": "<round#1>",
        "raw_wallet_delta": {
          "value": "0",
          "precision": 20
        },
        "raw_vault_delta": {
          "value": "-100",
          "precision": 20
        },
        "deleted": false
      },
      {
        "type": "CF",
        "customer_id": "cus_g_cf_win",
        "wallet_delta": "100",
        "vault_delta": "0",
        "payload": {
          "type": "CF",
          "cards": [
            {
              "value": 100,
              "pull_id": "<pull#0>",
              "card_handle": "cus_g_cf_win"
            }
          ],
          "value": 100,
          "outcome": "won",
          "pull_id": "<pull#0>",
          "round_id": "<round#0>",
          "card_handle": "cus_g_cf_win",
          "chosen_side": "head",
          "landed_side": "head",
          "published_win_percent": 50
        },
        "ref_id": "<round#0>",
        "raw_wallet_delta": {
          "value": "100",
          "precision": 20
        },
        "raw_vault_delta": {
          "value": "0",
          "precision": 20
        },
        "deleted": false
      }
    ]
  },
  "referral": {
    "credits": [
      {
        "customer_id": "cus_g_ref_r",
        "amount": "5",
        "reason": "referral_commission",
        "pull_id": null,
        "reference": null,
        "external_funded_cents": null,
        "source_transaction_id": null,
        "bonus_cents": null,
        "raw_amount": {
          "value": "5",
          "precision": 20
        },
        "deleted": false
      }
    ],
    "ledger": [
      {
        "type": "RF",
        "customer_id": "cus_g_ref_r",
        "wallet_delta": "5",
        "vault_delta": null,
        "payload": {
          "type": "RF",
          "rate_bp": 50,
          "week_start": "<week>",
          "basis_cents": 100000
        },
        "ref_id": "<line#0>",
        "raw_wallet_delta": {
          "value": "5",
          "precision": 20
        },
        "raw_vault_delta": null,
        "deleted": false
      }
    ],
    "line": {
      "status": "paid",
      "paid": true
    }
  }
};
