import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// A coin flip can stake Lucky Draw tickets alone or beside cards. Tickets alone
// have no Pull and no RM value, and their win pays tickets rather than Credit, so
// the round checks that assumed cards now allow for that. Hand-written.
// Runs after master's Migration20261030100000 and rewrites the same CHECK, so it
// must keep pack_spin or every Lucky Pack spin (and this deploy) fails.
const REASONS = ['task_claim', 'entry', 'refund', 'admin_grant', 'pack_spin'];

export class Migration20261103100200 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`set local lock_timeout = '5s';`);
    this.addSql('alter table "coin_flip_round" add column if not exists "ticket_stake" integer not null default 0;');
    this.addSql('alter table "coin_flip_round" alter column "pull_id" drop not null;');
    this.addSql('alter table "coin_flip_round" drop constraint if exists "coin_flip_round_stake_cents_check";');
    this.addSql('alter table "coin_flip_round" drop constraint if exists "coin_flip_round_stake_kind_check";');
    this.addSql(`alter table "coin_flip_round" add constraint "coin_flip_round_stake_kind_check" check (
      stake_cents >= 0 and ticket_stake between 0 and 10000 and
      (stake_cents > 0 or ticket_stake > 0) and
      (stake_cents > 0) = (pull_id is not null));`);
    this.settlementCheck('(credit_transaction_id is not null) = (stake_cents > 0)');
    this.ticketReasons([...REASONS, 'coin_flip']);
  }

  override async down(): Promise<void> {
    this.addSql(`do $$ begin
      if exists (select 1 from coin_flip_round where ticket_stake > 0) or
         exists (select 1 from lucky_draw_ticket where reason = 'coin_flip')
      then raise exception 'Ticket flips exist; pause coin flip instead of rolling back their records.';
      end if;
    end $$;`);
    this.ticketReasons(REASONS);
    this.settlementCheck('credit_transaction_id is not null');
    this.addSql('alter table "coin_flip_round" drop constraint if exists "coin_flip_round_stake_kind_check";');
    this.addSql('alter table "coin_flip_round" add constraint "coin_flip_round_stake_cents_check" check ("stake_cents" > 0);');
    this.addSql('alter table "coin_flip_round" alter column "pull_id" set not null;');
    this.addSql('alter table "coin_flip_round" drop column if exists "ticket_stake";');
  }

  private settlementCheck(wonCredit: string): void {
    this.addSql('alter table "coin_flip_round" drop constraint if exists "coin_flip_round_settlement_check";');
    this.addSql(`alter table "coin_flip_round" add constraint "coin_flip_round_settlement_check" check (
      (status = 'quoted' and settled_at is null and roll is null and credit_transaction_id is null) or
      (status = 'won' and settled_at is not null and roll is not null and ${wonCredit}) or
      (status = 'lost' and settled_at is not null and roll is not null and credit_transaction_id is null));`);
  }

  private ticketReasons(values: string[]): void {
    this.addSql('alter table if exists "lucky_draw_ticket" drop constraint if exists "lucky_draw_ticket_reason_check";');
    this.addSql(`alter table if exists "lucky_draw_ticket" add constraint "lucky_draw_ticket_reason_check" check ("reason" in (${values.map((v) => `'${v}'`).join(', ')}));`);
  }
}
