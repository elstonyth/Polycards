import { Migration } from '@medusajs/framework/mikro-orm/migrations';

const reasons = ['buyback', 'topup', 'pack_open', 'adjustment', 'cashout', 'voucher_claim', 'reward_credit', 'daily_reward', 'referral_commission', 'delivery_fee', 'bonus_grant'];
const statuses = ['vaulted', 'bought_back', 'delivering', 'delivered'];
const ledgerTypes = ['TP', 'SP', 'SE', 'OD', 'AD', 'WP', 'WD', 'RF'];
const entities = [
  'customer', 'commission', 'rewards_settings', 'credit', 'reward_pool',
  'daily_reward_settings', 'daily_box', 'voucher_ladder', 'fx', 'site_settings',
  'vip_levels', 'challenge_stages', 'challenge_settings', 'delivery_order',
  'purchase_invoice', 'tier_settings', 'referral_settings', 'weekly_settlement',
  'task_definition', 'customer_group', 'gateway_withdrawal', 'pack', 'card',
  'announcement', 'pack_gift', 'gateway_deposit', 'lucky_draw_event', 'lucky_draw_prize',
  'goods_receive_note',
];
const list = (values: string[]) => values.map((v) => `'${v}'`).join(', ');

export class Migration20261031100000 extends Migration {
  override async up(): Promise<void> {
    // Runs in the pre-deploy job against live traffic, and these ALTERs queue every
    // later pull and credit query behind them: fail the deploy fast and retry. Their
    // checks are NOT VALID so none of them scans a money table under that lock;
    // Migration20261031100400 validates them afterwards.
    this.addSql(`set local lock_timeout = '5s';`);
    this.addSql(`create table if not exists "coin_flip_config" (
      "id" text not null primary key,
      "enabled" boolean not null default false,
      "max_stake_cents" integer null check ("max_stake_cents" > 0),
      "win_units" integer null check ("win_units" between 0 and 1000000),
      "win_units_2" integer null check ("win_units_2" between 0 and 1000000),
      "win_units_3" integer null check ("win_units_3" between 0 and 1000000),
      "published_win_units" integer null check ("published_win_units" between 0 and 1000000),
      "revision" integer not null default 0,
      "created_at" timestamptz not null default now(),
      "updated_at" timestamptz not null default now(),
      "deleted_at" timestamptz null,
      constraint "coin_flip_config_enabled_check" check (not enabled or
        (max_stake_cents is not null and win_units is not null and published_win_units is not null))
    );`);
    this.addSql(`create index if not exists "IDX_coin_flip_config_deleted_at" on "coin_flip_config" ("deleted_at") where deleted_at is null;`);
    this.addSql(`insert into "coin_flip_config" ("id") values ('coin-flip') on conflict do nothing;`);
    this.addSql(`create table if not exists "coin_flip_round" (
      "id" text not null primary key,
      "customer_id" text not null,
      "pull_id" text not null,
      "status" text not null default 'quoted',
      "stake_cents" integer not null check ("stake_cents" > 0),
      "flip_version" integer not null,
      "config_revision" integer not null,
      "expires_at" timestamptz not null,
      "settled_at" timestamptz null,
      "snapshot" jsonb not null,
      "roll" integer null check ("roll" between 0 and 999999),
      "credit_transaction_id" text null,
      "created_at" timestamptz not null default now(),
      "updated_at" timestamptz not null default now(),
      "deleted_at" timestamptz null,
      constraint "coin_flip_round_status_check" check ("status" in ('quoted', 'won', 'lost')),
      constraint "coin_flip_round_settlement_check" check (
        (status = 'quoted' and settled_at is null and roll is null and credit_transaction_id is null) or
        (status = 'won' and settled_at is not null and roll is not null and credit_transaction_id is not null) or
        (status = 'lost' and settled_at is not null and roll is not null and credit_transaction_id is null))
    );`);
    this.addSql(`create index if not exists "IDX_coin_flip_round_deleted_at" on "coin_flip_round" ("deleted_at") where deleted_at is null;`);
    this.addSql(`create index if not exists "IDX_coin_flip_round_customer_created" on "coin_flip_round" ("customer_id", "created_at") where deleted_at is null;`);
    this.addSql(`create index if not exists "IDX_coin_flip_round_pull" on "coin_flip_round" ("pull_id") where deleted_at is null;`);
    this.addSql(`create index if not exists "IDX_coin_flip_round_status_created" on "coin_flip_round" ("status", "created_at") where deleted_at is null;`);
    this.addSql(`alter table "pull" add column if not exists "flip_version" integer not null default 0;`);
    this.addSql(`alter table "pull" add column if not exists "flip_eligible_at" timestamptz null;`);
    this.replaceCheck('pull', 'status', [...statuses, 'forfeited']);
    this.replaceCheck('credit_transaction', 'reason', [...reasons, 'coin_flip_win']);
    this.replaceCheck('ledger_entry', 'type', [...ledgerTypes, 'CF']);
    this.replaceCheck('admin_action_audit', 'entity_type', [...entities, 'coin_flip_config']);
    this.addSql('alter table "credit_transaction" drop constraint if exists "credit_coin_flip_basis_check";');
    this.addSql(`alter table "credit_transaction" add constraint "credit_coin_flip_basis_check" check (reason <> 'coin_flip_win' or
      (amount > 0 and pull_id is null and source_transaction_id is not null and
       coalesce(bonus_cents, 0) = 0 and coalesce(external_funded_cents, 0) = 0)) not valid;`);
  }

  override async down(): Promise<void> {
    this.addSql(`do $$ begin
      if exists (select 1 from coin_flip_round) or
         exists (select 1 from credit_transaction where reason = 'coin_flip_win') or
         exists (select 1 from ledger_entry where type = 'CF') or
         exists (select 1 from pull where status = 'forfeited') or
         exists (select 1 from admin_action_audit where entity_type = 'coin_flip_config')
      then raise exception 'Coin flip history exists; pause the feature instead of rolling back its records.';
      end if;
    end $$;`);
    this.addSql('alter table "credit_transaction" drop constraint if exists "credit_coin_flip_basis_check";');
    this.addSql('drop index if exists "IDX_credit_coin_flip_round";');
    this.replaceCheck('pull', 'status', statuses);
    this.replaceCheck('credit_transaction', 'reason', reasons);
    this.replaceCheck('ledger_entry', 'type', ledgerTypes);
    this.replaceCheck('admin_action_audit', 'entity_type', entities);
    this.addSql('alter table "pull" drop column if exists "flip_version";');
    this.addSql('alter table "pull" drop column if exists "flip_eligible_at";');
    this.addSql('drop table if exists "coin_flip_round";');
    this.addSql('drop table if exists "coin_flip_config";');
  }

  private replaceCheck(table: string, column: string, values: string[]): void {
    this.addSql(`alter table "${table}" drop constraint if exists "${table}_${column}_check";`);
    this.addSql(`alter table "${table}" add constraint "${table}_${column}_check" check ("${column}" in (${list(values)})) not valid;`);
  }
}
