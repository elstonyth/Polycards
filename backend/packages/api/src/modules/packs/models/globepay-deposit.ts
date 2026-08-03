import { model } from '@medusajs/framework/utils';

// GlobePayDeposit — the outstanding-deposit record for the GlobePay365 gateway.
//
// WHY this table has to exist (it is not bookkeeping-for-its-own-sake): the
// deposit callback echoes MerchantTransactionId but NOT MerchantClientId
// (§1.2.3). Without a row written at SubmitDeposit time there is no way to
// answer "which customer does this settled deposit belong to" except by
// smuggling our customer_id into MerchantTransactionId — which would publish an
// internal id into their back office, and still leave us unable to requery
// outstanding deposits (their own guidance: never trust a lost callback).
//
// This row is NOT the ledger. Credit is appended to credit_transaction only
// when a verified callback reports status 6; this table tracks intent and
// settlement so the two can be reconciled.
export const GlobePayDeposit = model
  .define('globepay_deposit', {
    id: model.id().primaryKey(),
    // OUR reference, sent as MerchantTransactionId. Unique because a duplicate
    // is what their PMT10000 rejects — enforce it on our side too rather than
    // discovering it at the gateway.
    merchant_transaction_id: model.text().unique(),
    // THEIR deposit id, known only after SubmitDeposit returns. Also the
    // idempotency anchor for crediting, since it is globally unique on their
    // side and is what a retried callback repeats.
    gateway_transaction_id: model.text().nullable(),
    customer_id: model.text(),
    // RM (MYR) decimal, matching credit_transaction.amount. What we ASKED for —
    // the customer may pay a different sum, so the credited amount comes from
    // the callback, not from here. Kept to detect and investigate mismatches.
    amount_requested: model.bigNumber(),
    // What we actually credited, from the verified callback. Null until settled.
    amount_settled: model.bigNumber().nullable(),
    payment_method_code: model.text(),
    // Our own lifecycle, NOT their numeric status: 'pending' covers every
    // non-final state (including their status 4 "VerifyFail", which the doc
    // marks explicitly non-final and which must never be read as failure).
    status: model.enum(['pending', 'settled', 'failed']).default('pending'),
    // Their raw numeric status from the last callback/requery, for support.
    gateway_status: model.number().nullable(),
    settled_at: model.dateTime().nullable(),
  })
  .indexes([
    // Callback lookup path: they hand us a MerchantTransactionId and we must
    // find the row on every single callback.
    { on: ['merchant_transaction_id'] },
    // Reconciliation sweep: "everything still pending, oldest first".
    { on: ['status', 'created_at'] },
  ]);

export default GlobePayDeposit;
