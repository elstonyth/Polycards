import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260703112544 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`drop table if exists "achievement_def" cascade;`);

    this.addSql(`drop table if exists "achievement_grant" cascade;`);

    this.addSql(`drop table if exists "achievement_member_state" cascade;`);
  }

  override async down(): Promise<void> {
    this.addSql(`create table if not exists "achievement_def" ("id" text not null, "key" text not null, "name" text not null, "description" text not null, "category" text not null, "rarity" text not null, "xp" integer not null, "metric" text not null, "threshold" integer not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "achievement_def_pkey" primary key ("id"));`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_achievement_def_key_unique" ON "achievement_def" ("key") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_achievement_def_deleted_at" ON "achievement_def" ("deleted_at") WHERE deleted_at IS NULL;`);

    this.addSql(`create table if not exists "achievement_grant" ("id" text not null, "customer_id" text not null, "achievement_key" text not null, "xp_awarded" integer not null, "unlocked_at" timestamptz not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "achievement_grant_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_achievement_grant_deleted_at" ON "achievement_grant" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_achievement_grant_unique" ON "achievement_grant" ("customer_id", "achievement_key") WHERE deleted_at IS NULL;`);

    this.addSql(`create table if not exists "achievement_member_state" ("id" text not null, "customer_id" text not null, "peak_cases_opened" integer not null default 0, "peak_collection_size" integer not null default 0, "total_xp" integer not null default 0, "collector_level" integer not null default 1, "highest_level_ever" integer not null default 1, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "achievement_member_state_pkey" primary key ("id"));`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_achievement_member_state_customer_id_unique" ON "achievement_member_state" ("customer_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_achievement_member_state_deleted_at" ON "achievement_member_state" ("deleted_at") WHERE deleted_at IS NULL;`);
  }

}
