import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260623072259 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`create table if not exists "vip_reward_grant" ("id" text not null, "customer_id" text not null, "level" integer not null, "kind" text check ("kind" in ('voucher', 'frame', 'box', 'prize')) not null, "payload" jsonb not null, "status" text check ("status" in ('granted', 'fulfilled', 'revoked')) not null default 'granted', "source_open_id" text null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "vip_reward_grant_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_vip_reward_grant_deleted_at" ON "vip_reward_grant" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_vip_reward_grant_customer_level_kind" ON "vip_reward_grant" ("customer_id", "level", "kind") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_vip_reward_grant_customer" ON "vip_reward_grant" ("customer_id") WHERE deleted_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "vip_reward_grant" cascade;`);
  }

}
