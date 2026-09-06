import { model } from '@medusajs/framework/utils';

// The globepay_withdrawal.status domain — single source of truth for the
// model's enum below, the admin route's STATUS_FILTERS
// (api/admin/globepay/withdrawals/route.ts), and the service's
// WithdrawalStatus type (modules/packs/service.ts). The migration's CHECK
// constraint (Migration20260811220000) is FROZEN HISTORY and cannot derive
// from this — it carries its own pointer comment back here instead.
export const WITHDRAWAL_STATUSES = [
  'pending',
  'settled',
  'failed',
  'held',
] as const;

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
    // What the gateway says it ACTUALLY paid, from the settlement callback or
    // requery. The deposit table has had this since it shipped; the payout side
    // never did, so a callback settling at a figure other than the one we
    // instructed was written to the log and nowhere else (see the settle branch
    // in api/hooks/tgpay/withdrawal/route.ts) — and DigitalOcean run logs do
    // not outlive the deployment. Never a ledger input: the debit was priced at
    // submit time and is not retro-adjusted. This is the column a reconciliation
    // compares against it.
    amount_settled: model.bigNumber().nullable(),
    // Settled amount MINUS their payout fee, same provenance and same rules as
    // globepay_deposit.net_amount — see that model for why the fee is derived
    // rather than stored and why NULL means "unknown", never "no fee".
    net_amount: model.bigNumber().nullable(),
    // The BANK's references for the transfer (GlobePay's own id is
    // gateway_transaction_id). This is what a receiving bank quotes when a payout
    // is disputed, and it was arriving on every callback and being dropped.
    bank_reference_no: model.text().nullable(),
    unique_reference_no: model.text().nullable(),
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
    status: model.enum([...WITHDRAWAL_STATUSES]).default('pending'),
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
    // FORENSICS (plan 095). Both columns exist because a payout that dies at
    // the gateway leaves nothing behind that outlives DigitalOcean's log
    // retention: the run logs only cover the CURRENT deployment, and the
    // 2026-08-11 production failures (8 payouts created at GlobePay and
    // immediately marked statusId 5) were already unreadable the next morning.
    // A row that records its own cause is the difference between "we know
    // within one attempt" and "wait for another customer to lose a day".
    //
    // Their Payout Verification is ACTIVE on the production merchant, so every
    // payout is offered to /hooks/globepay/payout-verify BEFORE they execute
    // it, and anything but the literal "success" rejects it. NULL therefore
    // carries real information: their verification never reached us at all
    // (wrong URL their side, blocked egress, a timeout shorter than our
    // answer) — a config fault, not a code one. Written on EVERY invocation,
    // 'success' included, precisely so that distinction survives.
    verify_outcome: model.text().nullable(),
    // Why the payout died on OUR side of the wire: the gateway's own codes and
    // message from a definite submit refusal. Never the request envelope
    // (signed and encrypted) and never the account number or holder name.
    failure_reason: model.text().nullable(),
    // Which gateway this row was created under. The sweeps and the admin
    // approve route talk to THIS gateway, not the active one, so switching
    // gateways never strands money already in flight on the old one. The
    // orchestration always sets it; the column default ('globepay', from the
    // 2026-09-05 migration) only ever applied to rows that predate it, and a
    // row that somehow lands with a retired gateway is skipped by every sweep.
    gateway: model.text().default('tgpay'),
    // Gateway audit (plan 130): when the audit sweep last requeried the
    // gateway for this row, and what it disagreed about. NULL note = the
    // gateway agrees with the row. The audit is a second, independent check
    // on top of the reconcile sweep: it re-reads rows that are already final.
    audited_at: model.dateTime().nullable(),
    audit_note: model.text().nullable(),
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
      where:
        "idempotency_key is not null and deleted_at is null and status <> 'failed'",
    },
  ]);

export default GlobePayWithdrawal;
