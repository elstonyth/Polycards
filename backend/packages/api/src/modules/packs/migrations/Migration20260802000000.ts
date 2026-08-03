import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// tier_settings — admin-configured RM display-price range per rarity tier
// (singleton, CHECK id='global', same pattern as challenge_settings). Also
// widen the admin_action_audit entity_type CHECK with 'tier_settings' (the
// generic 'edit' action already exists). Full cumulative list carried from
// Migration20260729010000.
export class Migration20260802000000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`create table if not exists "tier_settings" (
      "id" text not null,
      "ranges" jsonb not null default '{}',
      "created_at" timestamptz not null default now(),
      "updated_at" timestamptz not null default now(),
      "deleted_at" timestamptz null,
      constraint "tier_settings_pkey" primary key ("id"),
      constraint "tier_settings_singleton_id_check" check ("id" = 'global')
    );`);
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_tier_settings_deleted_at" ON "tier_settings" ("deleted_at") WHERE deleted_at IS NULL;`,
    );

    this.addSql(
      `alter table if exists "admin_action_audit" drop constraint if exists "admin_action_audit_entity_type_check";`,
    );
    this.addSql(
      `alter table if exists "admin_action_audit" add constraint "admin_action_audit_entity_type_check" check ("entity_type" in ('customer','commission','rewards_settings','credit','reward_pool','daily_reward_settings','daily_box','voucher_ladder','fx','site_settings','vip_levels','challenge_stages','challenge_settings','delivery_order','purchase_invoice','tier_settings'));`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `alter table if exists "admin_action_audit" drop constraint if exists "admin_action_audit_entity_type_check";`,
    );
    this.addSql(
      `delete from "admin_action_audit" where "entity_type" = 'tier_settings';`,
    );
    this.addSql(
      `alter table if exists "admin_action_audit" add constraint "admin_action_audit_entity_type_check" check ("entity_type" in ('customer','commission','rewards_settings','credit','reward_pool','daily_reward_settings','daily_box','voucher_ladder','fx','site_settings','vip_levels','challenge_stages','challenge_settings','delivery_order','purchase_invoice'));`,
    );

    this.addSql(`drop table if exists "tier_settings" cascade;`);
  }
}
