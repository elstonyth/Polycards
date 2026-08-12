import { Migration } from '@mikro-orm/migrations';

// Adds the withdrawal retry token.
//
// POST /store/credits/withdraw minted a fresh merchant_transaction_id per call,
// so a double-submit (or a client retry after the deliberately-successful
// ambiguous-submit response) became a SECOND withdrawal with its own debit and
// its own payout. The money-in sibling has accepted an Idempotency-Key since
// plan 044; this is the money-out parity.
//
// Partial unique index, not a plain one: Postgres ignores NULLs in unique
// indexes but the soft-delete predicate still has to be explicit, and callers
// that send no header must be able to withdraw repeatedly.
//
// 'failed' is excluded so a failed attempt FREES the key. The row is written
// before the withdrawal gate runs, so the common refusals — insufficient
// balance, playthrough not met, the daily cap — consume a key for a request
// that never moved money. The house convention is one key per user INTENT,
// reused across error retries (TopUpSheet.tsx), so a customer who fixes the
// cause and retries must not be turned away. Matches the money-in side, where
// a failed topup writes no ledger row and the same key just proceeds.
export class Migration20260812010000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table if exists "globepay_withdrawal" add column if not exists "idempotency_key" text null;`,
    );
    this.addSql(
      `create unique index if not exists "UQ_globepay_withdrawal_customer_idempotency_key" on "globepay_withdrawal" ("customer_id", "idempotency_key") where "idempotency_key" is not null and "deleted_at" is null and "status" <> 'failed';`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `drop index if exists "UQ_globepay_withdrawal_customer_idempotency_key";`,
    );
    this.addSql(
      `alter table if exists "globepay_withdrawal" drop column if exists "idempotency_key";`,
    );
  }
}
