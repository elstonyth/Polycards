import { MedusaError } from '@medusajs/framework/utils';
import PacksModuleService from '../service';

/**
 * transitionDeliveryOrderStatus — the atomic, per-order-serialized status
 * seam (day-3 sim HIGH: concurrent double-cancel diverged an order to
 * 'requested' while its pulls were already re-vaulted, letting one physical
 * card be delivered into a SECOND live order).
 *
 * The contract pinned here, without a DB (same fake-`this` technique as
 * credit-balance.unit.spec.ts — @InjectTransactionManager reuses a provided
 * `sharedContext.transactionManager` and calls the original method):
 *
 *  1. A per-order `delivery:<id>` advisory lock is taken BEFORE the fresh
 *     status re-read, so concurrent transitions serialize.
 *  2. The transition is validated against the FRESH read under the lock —
 *     the losing double-cancel sees 'canceled' and refuses with a clean
 *     NOT_ALLOWED, writing NOTHING (no order write, no pull flip, no revert).
 *  3. A winning cancel writes the order row and re-vaults the pulls in the
 *     SAME transaction (shared context on both writes).
 *  4. A pull-flip failure propagates with exactly ONE order write issued —
 *     rollback owns the undo; there is no manual revert that could land
 *     after another run's terminal write.
 */

type OrderRow =
  | { id: string; status: string; customer_id?: string; is_reward?: boolean }
  | undefined;

// hasDebit models whether the CREATE-time OD debit row exists for this order.
// The cancel-side credit is gated on that row's EXISTENCE (never on a field of
// the order), so the fake has to answer the lookup honestly or every
// "recordLedgerEntry not called" assertion below would pass vacuously.
//
// The fake row carries a real vault_delta because the cancel arm now REVERSES
// that stored amount; a row without the column would make the reversal read
// undefined and every assertion here pass on a -0 write.
const DEBIT_VAULT_DELTA = -141.55;
// The CREATE-time wallet charge (shipping + insurance, 2026-08-25). The cancel
// arm refunds its NEGATION via mutateCreditAtomic — like the vault reversal,
// never recomputed.
const DEBIT_WALLET_DELTA = -15;

const fakeService = (order: OrderRow, hasDebit = true) => {
  const svc = Object.create(PacksModuleService.prototype) as PacksModuleService;
  const ops: string[] = [];
  const em = {
    // Wide row type so per-test mockImplementations can model degenerate rows
    // (missing/NULL wallet_delta on pre-fee entries, corrupted values).
    execute: jest.fn(
      async (
        q: string,
        _params?: unknown[],
      ): Promise<Record<string, unknown>[]> => {
        ops.push('sql');
        if (q.includes('ledger_entry')) {
          // numeric comes back from pg as a STRING — mirror that, so the
          // Number() coercion in the reversal is exercised, not bypassed.
          return hasDebit
            ? [
                {
                  id: 'led_od_debit',
                  vault_delta: String(DEBIT_VAULT_DELTA),
                  wallet_delta: String(DEBIT_WALLET_DELTA),
                },
              ]
            : [];
        }
        return [];
      },
    ),
  };
  const listDeliveryOrders = jest.fn(async () => {
    ops.push('read');
    return order ? [order] : [];
  });
  const updateDeliveryOrders = jest.fn(async () => {
    ops.push('write');
    return [];
  });
  const transitionPullStatus = jest.fn(async () => {
    ops.push('flip');
  });
  // Task 8's cancel-reversal OD write. The cancel arm no longer values cards
  // at all (it negates the stored debit), so listPulls feeds only the
  // payload's handle tally and no listCards fake is needed — same reason
  // ledger-service.integration.spec.ts, not this file, is where
  // recordLedgerEntry's own internals are pinned.
  const listPulls = jest.fn(async () => {
    ops.push('listPulls');
    return [];
  });
  const recordLedgerEntry = jest.fn(async () => {
    ops.push('ledger');
    return { id: 'led_1', display_id: 'OD26Q3A0001', replayed: false };
  });
  // The fee refund writer. Fake answers only what the cancel arm reads.
  const mutateCreditAtomic = jest.fn(async () => {
    ops.push('refund');
    return {
      id: 'ct_1',
      balance: 0,
      amount: -DEBIT_WALLET_DELTA,
      replayed: false,
      reference: null,
    };
  });
  Object.assign(svc, {
    listDeliveryOrders,
    updateDeliveryOrders,
    transitionPullStatus,
    listPulls,
    recordLedgerEntry,
    mutateCreditAtomic,
  });
  const ctx = { transactionManager: em } as never;
  return {
    svc,
    em,
    ops,
    ctx,
    listDeliveryOrders,
    updateDeliveryOrders,
    transitionPullStatus,
    listPulls,
    recordLedgerEntry,
    mutateCreditAtomic,
  };
};

const cancelInput = {
  orderId: 'do_1',
  to: 'canceled' as const,
  trackingNumber: null,
  pullIds: ['pull_1', 'pull_2'],
};

describe('PacksModuleService.transitionDeliveryOrderStatus', () => {
  it('takes the per-order advisory lock BEFORE the fresh status read', async () => {
    const f = fakeService({ id: 'do_1', status: 'requested' });
    await f.svc.transitionDeliveryOrderStatus(cancelInput, f.ctx);
    expect(f.em.execute.mock.calls[0][0]).toContain('pg_advisory_xact_lock');
    expect(f.em.execute.mock.calls[0][1]).toEqual(['delivery:do_1']);
    expect(f.ops.indexOf('sql')).toBeLessThan(f.ops.indexOf('read'));
  });

  it('losing double-cancel: fresh read shows canceled → clean NOT_ALLOWED, NOTHING written', async () => {
    const f = fakeService({ id: 'do_1', status: 'canceled' });
    await expect(
      f.svc.transitionDeliveryOrderStatus(cancelInput, f.ctx),
    ).rejects.toMatchObject({
      type: MedusaError.Types.NOT_ALLOWED,
      message: expect.stringMatching(/canceled/),
    });
    // The loser must not touch the order row (the old revert-after-terminal-
    // write is exactly what stranded the order) nor the pulls.
    expect(f.updateDeliveryOrders).not.toHaveBeenCalled();
    expect(f.transitionPullStatus).not.toHaveBeenCalled();
  });

  it('winning cancel: order write + pull re-vault share ONE transaction', async () => {
    const f = fakeService({ id: 'do_1', status: 'requested' });
    const result = await f.svc.transitionDeliveryOrderStatus(
      cancelInput,
      f.ctx,
    );
    expect(result).toEqual({ status: 'canceled' });
    expect(f.updateDeliveryOrders).toHaveBeenCalledWith(
      [expect.objectContaining({ id: 'do_1', status: 'canceled' })],
      f.ctx,
    );
    expect(f.transitionPullStatus).toHaveBeenCalledWith(
      { ids: ['pull_1', 'pull_2'], from: 'delivering', to: 'vaulted' },
      f.ctx,
    );
    // Task 8's OD reversal rides the same transaction — exactly one row, and
    // only because the debit lookup found the CREATE-time row keyed on the
    // order id (this half of the discriminating pair below).
    expect(f.recordLedgerEntry).toHaveBeenCalledTimes(1);
    expect(f.em.execute).toHaveBeenCalledWith(
      expect.stringContaining('ledger_entry'),
      ['do_1'],
    );
    // The reversal is the NEGATED STORED DEBIT, not a fresh valuation. The
    // fake never supplies a card price or an fx rate, so a re-valuing cancel
    // could not produce this number at all — which is the point: create and
    // cancel must never price the same cards at two different instants.
    expect(f.recordLedgerEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'OD',
        refId: 'cancel:do_1',
        walletDelta: -DEBIT_WALLET_DELTA,
        vaultDelta: -DEBIT_VAULT_DELTA,
      }),
      f.ctx,
    );
    // …and the fee comes back to the wallet: the NEGATED STORED wallet_delta,
    // through the same locked credit writer every money mutation uses.
    expect(f.mutateCreditAtomic).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: -DEBIT_WALLET_DELTA,
        reason: 'delivery_fee',
        reference: 'refund:do_1',
      }),
      f.ctx,
    );
  });

  it('fails closed on a corrupt POSITIVE stored wallet_delta (no partial reversal)', async () => {
    // The create arm only ever writes 0 or a negative charge; a positive value
    // is corruption, and skipping it silently would emit the reversal ledger
    // row with no matching credit_transaction (ledger↔credit mirror break).
    const f = fakeService({ id: 'do_1', status: 'requested' });
    f.em.execute.mockImplementation(async (q: string) =>
      q.includes('ledger_entry')
        ? [
            {
              id: 'led_od_debit',
              vault_delta: String(DEBIT_VAULT_DELTA),
              wallet_delta: '15',
            },
          ]
        : [],
    );
    await expect(
      f.svc.transitionDeliveryOrderStatus(cancelInput, f.ctx),
    ).rejects.toMatchObject({ type: MedusaError.Types.UNEXPECTED_STATE });
    expect(f.mutateCreditAtomic).not.toHaveBeenCalled();
    expect(f.recordLedgerEntry).not.toHaveBeenCalled();
  });

  it('skips the wallet refund (but not the vault reversal) on a pre-fee debit row', async () => {
    const f = fakeService({ id: 'do_1', status: 'requested' });
    f.em.execute.mockImplementation(async (q: string) => {
      if (q.includes('ledger_entry')) {
        // Pre-fee CREATE row: wallet_delta 0 (or NULL in even older rows).
        return [
          {
            id: 'led_od_debit',
            vault_delta: String(DEBIT_VAULT_DELTA),
            wallet_delta: null,
          },
        ];
      }
      return [];
    });
    await f.svc.transitionDeliveryOrderStatus(cancelInput, f.ctx);
    expect(f.mutateCreditAtomic).not.toHaveBeenCalled();
    expect(f.recordLedgerEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        walletDelta: 0,
        vaultDelta: -DEBIT_VAULT_DELTA,
      }),
      f.ctx,
    );
  });

  it('refuses to reverse a debit whose vault_delta is not a number', async () => {
    // Fail closed on real data corruption — a NaN written to a money column is
    // worse than a refused cancel (and the create arm always writes a number,
    // so this is unreachable in normal operation).
    const f = fakeService({ id: 'do_1', status: 'requested' });
    f.em.execute.mockImplementation(async (q: string) =>
      q.includes('ledger_entry')
        ? [{ id: 'led_od_debit', vault_delta: 'not-a-number' }]
        : [],
    );
    await expect(
      f.svc.transitionDeliveryOrderStatus(cancelInput, f.ctx),
    ).rejects.toMatchObject({ type: MedusaError.Types.UNEXPECTED_STATE });
    expect(f.recordLedgerEntry).not.toHaveBeenCalled();
  });

  // The OTHER half of the pair: byte-identical order and input, only the
  // debit's existence differs. This is the case the old `!order.is_reward`
  // guard missed — an ordinary (is_reward=false) order created BEFORE this
  // writer shipped has no OD debit, because the rollout is go-forward-only
  // with no backfill. Crediting it would write an unmatched `vault +` and
  // permanently drift cumulative vault_delta.
  it('skips the OD reversal when no CREATE-time debit row exists', async () => {
    const f = fakeService({ id: 'do_1', status: 'requested' }, false);
    await f.svc.transitionDeliveryOrderStatus(cancelInput, f.ctx);
    expect(f.recordLedgerEntry).not.toHaveBeenCalled();
  });

  // The reward case is now a SPECIAL CASE of the rule above, not its own
  // branch: recordRewardWithdrawal creates reward-prize shipments with no OD
  // debit (reward pulls are excluded from ledger/value tracking everywhere),
  // so the existence gate skips them for the same reason. `is_reward: true`
  // here documents the real-world scenario; the gate never reads the field.
  it('skips the OD reversal for a reward-sourced order (it never got a debit)', async () => {
    const f = fakeService(
      { id: 'do_1', status: 'requested', is_reward: true },
      false,
    );
    await f.svc.transitionDeliveryOrderStatus(cancelInput, f.ctx);
    expect(f.recordLedgerEntry).not.toHaveBeenCalled();
  });

  it('completed: stamps delivered_at and flips pulls delivering → delivered', async () => {
    const f = fakeService({ id: 'do_1', status: 'shipped' });
    await f.svc.transitionDeliveryOrderStatus(
      {
        orderId: 'do_1',
        to: 'completed',
        trackingNumber: 'TRK1',
        pullIds: ['pull_1'],
      },
      f.ctx,
    );
    expect(f.updateDeliveryOrders).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          status: 'completed',
          delivered_at: expect.any(Date),
        }),
      ],
      f.ctx,
    );
    // PULL enum is unchanged by the rename — a completed order still flips its
    // pulls to pull-status 'delivered'.
    expect(f.transitionPullStatus).toHaveBeenCalledWith(
      { ids: ['pull_1'], from: 'delivering', to: 'delivered' },
      f.ctx,
    );
    // NOTHING fires on 'completed' (even with a debit row present): those cards
    // are gone for good, so the CREATE-time debit stands permanently.
    expect(f.recordLedgerEntry).not.toHaveBeenCalled();
  });

  it('shipped: stamps shipped_at and does NOT touch pulls', async () => {
    // Only ready_to_ship → shipped is a legal transition post-rename.
    const f = fakeService({ id: 'do_1', status: 'ready_to_ship' });
    await f.svc.transitionDeliveryOrderStatus(
      {
        orderId: 'do_1',
        to: 'shipped',
        trackingNumber: 'TRK1',
        pullIds: ['pull_1'],
      },
      f.ctx,
    );
    expect(f.updateDeliveryOrders).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          status: 'shipped',
          shipped_at: expect.any(Date),
        }),
      ],
      f.ctx,
    );
    expect(f.transitionPullStatus).not.toHaveBeenCalled();
  });

  it('shipped without tracking refuses with INVALID_DATA before any write', async () => {
    // ready_to_ship (not processed) so the transition itself is legal and the
    // tracking-required check is actually exercised.
    const f = fakeService({ id: 'do_1', status: 'ready_to_ship' });
    await expect(
      f.svc.transitionDeliveryOrderStatus(
        {
          orderId: 'do_1',
          to: 'shipped',
          trackingNumber: null,
          pullIds: [],
        },
        f.ctx,
      ),
    ).rejects.toMatchObject({ type: MedusaError.Types.INVALID_DATA });
    expect(f.updateDeliveryOrders).not.toHaveBeenCalled();
  });

  it('a pull-flip failure propagates with exactly ONE order write (rollback owns the undo)', async () => {
    const f = fakeService({ id: 'do_1', status: 'requested' });
    f.transitionPullStatus.mockRejectedValueOnce(
      new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        'One or more cards changed state — refresh and try again.',
      ),
    );
    await expect(
      f.svc.transitionDeliveryOrderStatus(cancelInput, f.ctx),
    ).rejects.toMatchObject({ type: MedusaError.Types.NOT_ALLOWED });
    // No compensating second write — a manual revert here is what produced
    // the requested-order/vaulted-pull divergence.
    expect(f.updateDeliveryOrders).toHaveBeenCalledTimes(1);
  });

  it('proof_images pass through wholesale when provided', async () => {
    const f = fakeService({ id: 'do_1', status: 'requested' });
    await f.svc.transitionDeliveryOrderStatus(
      { ...cancelInput, to: 'processed', pullIds: [], proofImages: ['a.webp'] },
      f.ctx,
    );
    expect(f.updateDeliveryOrders).toHaveBeenCalledWith(
      [expect.objectContaining({ proof_images: ['a.webp'] })],
      f.ctx,
    );
  });

  it('404s an unknown order without writing', async () => {
    const f = fakeService(undefined);
    await expect(
      f.svc.transitionDeliveryOrderStatus(cancelInput, f.ctx),
    ).rejects.toMatchObject({ type: MedusaError.Types.NOT_FOUND });
    expect(f.updateDeliveryOrders).not.toHaveBeenCalled();
  });

  it('empty pullIds on cancel skips the flip (no zero-id UPDATE)', async () => {
    const f = fakeService({ id: 'do_1', status: 'requested' });
    await f.svc.transitionDeliveryOrderStatus(
      { ...cancelInput, pullIds: [] },
      f.ctx,
    );
    expect(f.transitionPullStatus).not.toHaveBeenCalled();
  });
});
