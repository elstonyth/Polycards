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
    status: model.enum(['pending', 'settled', 'failed']).default('pending'),
    // Their raw numeric status from the last callback/requery (4 = success,
    // 5 = fail, else processing), for support.
    gateway_status: model.number().nullable(),
    settled_at: model.dateTime().nullable(),
  })
  .indexes([
    // Callback lookup path.
    { on: ['merchant_transaction_id'] },
    // Reconciliation sweep: outstanding payouts, oldest first.
    { on: ['status', 'created_at'] },
  ]);

export default GlobePayWithdrawal;
