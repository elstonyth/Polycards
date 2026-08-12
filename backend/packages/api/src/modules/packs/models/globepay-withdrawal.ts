import { model } from '@medusajs/framework/utils';

// GlobePayWithdrawal — the outstanding-payout record for the GlobePay365
// gateway (method WD). Mirrors GlobePayDeposit, inverted: the ledger DEBIT
// happens BEFORE SubmitWithdrawal (money must never leave the gateway without
// having left the balance first), and a failed payout REFUNDS the debit.
//
// Like the deposit table, this row is what maps their callback (which echoes
// MerchantTransactionId but not MerchantClientId) back to a customer — and it
// records the destination account for support/disputes, because their callback
// does not echo it.
export const GlobePayWithdrawal = model
  .define('globepay_withdrawal', {
    id: model.id().primaryKey(),
    // OUR reference, sent as MerchantTransactionId. Unique — their PMT10000
    // rejects duplicates, and the refund idempotency anchor derives from it.
    merchant_transaction_id: model.text().unique(),
    // THEIR withdrawal id (W…), known only after SubmitWithdrawal returns.
    gateway_transaction_id: model.text().nullable(),
    customer_id: model.text(),
    // RM (MYR) decimal. The amount debited from the ledger up front. Unlike
    // deposits there is no "customer paid a different sum" — we instruct the
    // exact figure, so settled == requested unless their callback disagrees
    // (which is logged, never silently absorbed).
    amount: model.bigNumber(),
    // Destination bank account, exactly as submitted. Kept verbatim: a payout
    // dispute is resolved by quoting what we told them to pay, not by memory.
    bank_code: model.text(),
    account_number: model.text(),
    account_holder_name: model.text(),
    // 'pending' covers submitted + processing. 'failed' always means the debit
    // has been refunded (the refund shares the row's idempotency anchor).
    //
    // 'held' — debited, awaiting admin approval, never submitted to the
    // gateway. It has no gateway_transaction_id and the reconcile sweep must
    // never select it for PROCESSING (the sweep does run one read-only
    // staleness log across held rows, plan 094 follow-up, but never
    // requeries, refunds, or writes to one). It leaves only via the admin
    // approve route (-> 'pending') or the admin deny route (-> 'failed',
    // refunded).
    status: model
      .enum(['pending', 'settled', 'failed', 'held'])
      .default('pending'),
    // Their raw numeric status from the last callback/requery (4 = success,
    // 5 = fail, else processing), for support.
    gateway_status: model.number().nullable(),
    settled_at: model.dateTime().nullable(),
    // Client-supplied retry token, scoped to the customer. NULL for callers
    // that send none (the header is optional, so pre-existing clients keep
    // working). A partial unique index on (customer_id, idempotency_key) makes
    // the replay check race-safe; Postgres ignores NULLs in unique indexes, so
    // keyless withdrawals never collide with each other.
    idempotency_key: model.text().nullable(),
  })
  .indexes([
    // Callback lookup path.
    { on: ['merchant_transaction_id'] },
    // Reconciliation sweep: outstanding payouts, oldest first.
    { on: ['status', 'created_at'] },
    // The real guarantee behind the Idempotency-Key replay: the read in
    // startGlobePayWithdrawal only turns the second request into a clean replay
    // instead of a 23505. Declared HERE and not only in
    // Migration20260812010000 because db:generate emits a DROP for any index it
    // cannot see on the model — the same argument
    // docs/plans/postgres-best-practices-audit.md B6 makes for
    // UQ_reward_draw_customer_day_ordinal. Keep the predicate identical to the
    // migration's.
    {
      name: 'UQ_globepay_withdrawal_customer_idempotency_key',
      on: ['customer_id', 'idempotency_key'],
      unique: true,
      where: "idempotency_key is not null and deleted_at is null and status <> 'failed'",
    },
  ]);

export default GlobePayWithdrawal;
