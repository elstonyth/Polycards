import { Migration } from '@mikro-orm/migrations';

// Adds the two payout-forensics columns (plan 095).
//
// Production context: on 2026-08-11 eight payouts were created at GlobePay and
// immediately marked statusId 5 (Fail), and two more were refused before any
// record existed. By the next morning the only account of WHY — the
// `[globepay] withdrawal refused: codes=…` line #423 had just added — had
// already aged out of DigitalOcean's run logs, which cover the current
// deployment only. Nothing in the database said anything beyond `status =
// 'failed'`.
//
// `verify_outcome` is stamped on EVERY Payout Verification hit, success
// included, because its ABSENCE is the finding that matters most: their
// verification is active on the production merchant, so a NULL after a failed
// payout means their call never arrived, which points at URL/reachability
// config rather than at our code.
//
// `failure_reason` carries the gateway's own codes and message from a definite
// submit refusal. Both are plain nullable text — no backfill, forward-only:
// the ten existing rows genuinely have no recorded cause and must not be given
// a fabricated one.
export class Migration20260812120000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table if exists "globepay_withdrawal" add column if not exists "verify_outcome" text null;`,
    );
    this.addSql(
      `alter table if exists "globepay_withdrawal" add column if not exists "failure_reason" text null;`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `alter table if exists "globepay_withdrawal" drop column if exists "failure_reason";`,
    );
    this.addSql(
      `alter table if exists "globepay_withdrawal" drop column if exists "verify_outcome";`,
    );
  }
}
