import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// Mirror GlobePay365's settlement facts into this database, so the monthly and
// weekly money question is answerable here instead of in their back office.
//
// Every column below carries a value the gateway ALREADY sends us — on the
// settlement callback and again on requery — and that four separate call sites
// have been declaring on their payload types and dropping on the floor:
//
//   net_amount           the gross MINUS their fee. Without it, `topups` and
//                        `cashout` on /admin/economy are gross figures and the
//                        real cost of processing exists nowhere in this app.
//   bank_reference_no    the BANK's references, as opposed to
//   unique_reference_no  gateway_transaction_id which is GlobePay's. These are
//                        what a bank quotes in a dispute.
//   amount_settled       (withdrawals only) what they say they actually paid.
//                        Deposits have had this since the table shipped; the
//                        payout side wrote a settled-amount disagreement to the
//                        log and nowhere else, and DigitalOcean run logs do not
//                        outlive the deployment.
//
// EVERY ONE IS NULLABLE AND STAYS NULLABLE. Rows that settled before this
// migration have no net and no bank reference, and no backfill can invent one:
// a requery only answers while the provider retains the transaction, and for
// the already-settled population that window is largely gone. NULL therefore
// means "unknown", and a reader that treats it as zero fee reports a profit that
// was never earned. The settlement report counts those rows separately for
// exactly this reason.
//
// net_amount and amount_settled are `model.bigNumber()`, which is TWO physical
// columns — the numeric one and a `raw_<field>` jsonb sidecar the ORM reads the
// value back out of. A hand-written migration that adds only the numeric half
// passes every mocked test and fails on the first real insert with
// 'column "raw_net_amount" does not exist'. Both halves are added here, matching
// credit_transaction.amount / raw_amount and the deposit table's own
// amount_settled / raw_amount_settled (Migration20260721140000).
//
// No index is added. The settlement report groups settled rows by settled_at,
// and both tables already carry ('status', 'created_at'); at the volumes this
// integration has seen (low thousands of rows) the status prefix is enough, and
// an index nobody has measured a need for is a write cost paid on every deposit.
export class Migration20260817090000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`alter table if exists "globepay_deposit"
      add column if not exists "net_amount" numeric null,
      add column if not exists "raw_net_amount" jsonb null,
      add column if not exists "bank_reference_no" text null,
      add column if not exists "unique_reference_no" text null;`);

    this.addSql(`alter table if exists "globepay_withdrawal"
      add column if not exists "amount_settled" numeric null,
      add column if not exists "raw_amount_settled" jsonb null,
      add column if not exists "net_amount" numeric null,
      add column if not exists "raw_net_amount" jsonb null,
      add column if not exists "bank_reference_no" text null,
      add column if not exists "unique_reference_no" text null;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "globepay_deposit"
      drop column if exists "net_amount",
      drop column if exists "raw_net_amount",
      drop column if exists "bank_reference_no",
      drop column if exists "unique_reference_no";`);

    this.addSql(`alter table if exists "globepay_withdrawal"
      drop column if exists "amount_settled",
      drop column if exists "raw_amount_settled",
      drop column if exists "net_amount",
      drop column if exists "raw_net_amount",
      drop column if exists "bank_reference_no",
      drop column if exists "unique_reference_no";`);
  }
}
