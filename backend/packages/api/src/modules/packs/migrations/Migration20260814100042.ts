import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260814100042 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "pull" drop constraint if exists "pull_source_check";`);

    this.addSql(`alter table if exists "customer_account_state" add column if not exists "free_pack_available_at" timestamptz null, add column if not exists "free_pack_claimed_at" timestamptz null;`);

    this.addSql(`alter table if exists "pull" add constraint "pull_source_check" check("source" in ('pack', 'reward', 'free'));`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "pull" drop constraint if exists "pull_source_check";`);

    this.addSql(`alter table if exists "customer_account_state" drop column if exists "free_pack_available_at", drop column if exists "free_pack_claimed_at";`);

    this.addSql(`alter table if exists "pull" add constraint "pull_source_check" check("source" in ('pack', 'reward'));`);
  }

}
