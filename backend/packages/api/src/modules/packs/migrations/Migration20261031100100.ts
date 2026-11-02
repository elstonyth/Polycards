import { Migration } from '@medusajs/framework/mikro-orm/migrations';

export class Migration20261031100100 extends Migration {
  override async up(): Promise<void> {
    this.addSql('alter table "coin_flip_config" drop constraint if exists "coin_flip_config_enabled_check";');
    this.addSql(`alter table "coin_flip_config" add constraint "coin_flip_config_enabled_check"
      check (not enabled or (win_units is not null and published_win_units is not null));`);
    this.addSql('update "coin_flip_config" set max_stake_cents = null, revision = revision + 1, updated_at = now();');
    this.addSql('alter table "coin_flip_round" alter column "stake_cents" type numeric using "stake_cents"::numeric;');
    this.addSql('alter table "coin_flip_round" add column if not exists "raw_stake_cents" jsonb;');
    this.addSql(`update "coin_flip_round" set "raw_stake_cents" = jsonb_build_object('value', stake_cents::text, 'precision', 20)
      where "raw_stake_cents" is null;`);
    this.addSql('alter table "coin_flip_round" alter column "raw_stake_cents" set not null;');
    this.addSql('alter table "coin_flip_round" drop constraint if exists "coin_flip_round_stake_precision_check";');
    this.addSql(`alter table "coin_flip_round" add constraint "coin_flip_round_stake_precision_check"
      check (stake_cents = trunc(stake_cents) and stake_cents <= 9007199254740991);`);
  }

  override async down(): Promise<void> {
    this.addSql(`do $$ begin
      if exists (select 1 from coin_flip_config where enabled and max_stake_cents is null) or
         exists (select 1 from coin_flip_round where stake_cents > 2147483647)
      then raise exception 'Uncapped coin flips exist; pause and use a forward repair instead of restoring stake caps.';
      end if;
    end $$;`);
    this.addSql('alter table "coin_flip_config" drop constraint if exists "coin_flip_config_enabled_check";');
    this.addSql(`alter table "coin_flip_config" add constraint "coin_flip_config_enabled_check"
      check (not enabled or (max_stake_cents is not null and win_units is not null and published_win_units is not null));`);
    this.addSql('alter table "coin_flip_round" drop constraint if exists "coin_flip_round_stake_precision_check";');
    this.addSql('alter table "coin_flip_round" alter column "stake_cents" type integer using "stake_cents"::integer;');
    this.addSql('alter table "coin_flip_round" drop column if exists "raw_stake_cents";');
  }
}
