import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// Payment-pair fees as a percentage of the mid, one per direction, behind an
// on/off switch (payment-fx.ts). They replace the absolute RM `markup`, which
// stays on the row untouched so a rollback still prices at the old spread.
//
// The backfill keeps today's prices: a row with a markup gets fee_enabled and
// both percentages = markup / effective mid x 100 (4 dp). A row without one
// keeps fee_enabled NULL, which payment-fx.ts reads as "never configured":
// that rail stays paused until an admin saves its fee once.
//
// bigNumber is TWO physical columns, the numeric one and its raw_<field>
// jsonb sidecar (see Migration20261012120000).
export class Migration20261013090000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`alter table if exists "fx_rate"
      add column if not exists "fee_enabled" boolean null,
      add column if not exists "deposit_fee_percent" numeric not null default 0,
      add column if not exists "raw_deposit_fee_percent" jsonb not null default '{"value":"0","precision":20}',
      add column if not exists "payout_fee_percent" numeric not null default 0,
      add column if not exists "raw_payout_fee_percent" jsonb not null default '{"value":"0","precision":20}';`);
    this.addSql(`with m as (
        select id, round(markup / (case when manual_override and manual_rate > 0 then manual_rate else rate end) * 100, 4) as pct
          from "fx_rate"
         where markup > 0 and fee_enabled is null
           and (case when manual_override and manual_rate > 0 then manual_rate else rate end) > 0
      )
      update "fx_rate" f set
        fee_enabled = true,
        deposit_fee_percent = m.pct,
        raw_deposit_fee_percent = jsonb_build_object('value', m.pct::text, 'precision', 20),
        payout_fee_percent = m.pct,
        raw_payout_fee_percent = jsonb_build_object('value', m.pct::text, 'precision', 20)
      from m where f.id = m.id;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "fx_rate"
      drop column if exists "fee_enabled",
      drop column if exists "deposit_fee_percent",
      drop column if exists "raw_deposit_fee_percent",
      drop column if exists "payout_fee_percent",
      drop column if exists "raw_payout_fee_percent";`);
  }
}
