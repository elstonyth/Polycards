import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260623071127 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "vip_member_state" drop constraint if exists "vip_member_state_customer_id_unique";`);
    this.addSql(`create table if not exists "vip_member_state" ("id" text not null, "customer_id" text not null, "lifetime_external_spend_sen" numeric not null default 0, "highest_level_ever" integer not null default 1, "current_level" integer not null default 1, "raw_lifetime_external_spend_sen" jsonb not null default '{"value":"0","precision":20}', "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "vip_member_state_pkey" primary key ("id"));`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_vip_member_state_customer_id_unique" ON "vip_member_state" ("customer_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_vip_member_state_deleted_at" ON "vip_member_state" ("deleted_at") WHERE deleted_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "vip_member_state" cascade;`);
  }

}
