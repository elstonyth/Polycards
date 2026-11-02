import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// Lucky Pack ticket spin (spec 2026-10-30): pack.prize_type, the ticket_prize
// and ticket_spin tables, and 'pack_spin' on the ticket ledger's reason CHECK.
// Purely additive: every existing pack defaults to 'cards' and old code never
// reads the rest, so DEPLOY ORDER is the usual migrate-then-serve.
//
// Hand-written (the generator re-emits unrelated snapshot drift), in the shape
// `db:generate` would produce plus the CHECK on ticket_prize.tickets.
export class Migration20261030100000 extends Migration {
  override async up(): Promise<void> {
    // Fail the deploy fast rather than queue pack reads behind the ALTER lock.
    this.addSql(`set local lock_timeout = '5s';`);

    this.addSql(
      `alter table if exists "pack" add column if not exists "prize_type" text check ("prize_type" in ('cards', 'tickets')) not null default 'cards';`,
    );

    this.addSql(
      `create table if not exists "ticket_prize" ("id" text not null, "pack_id" text not null, "tickets" integer not null, "rarity" text check ("rarity" in ('Immortal', 'Legendary', 'Mythical', 'Rare', 'Uncommon', 'Common')) not null, "weight" integer not null, "weight_2" integer null, "weight_3" integer null, "locked" boolean not null default false, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "ticket_prize_pkey" primary key ("id"), constraint "ticket_prize_tickets_check" check ("tickets" >= 1));`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_ticket_prize_deleted_at" ON "ticket_prize" ("deleted_at") WHERE deleted_at IS NULL;`,
    );
    // One row per amount in a pack; also serves the per-pack read.
    this.addSql(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_ticket_prize_pack_tickets" ON "ticket_prize" ("pack_id", "tickets") WHERE deleted_at IS NULL;`,
    );

    this.addSql(
      `create table if not exists "ticket_spin" ("id" text not null, "customer_id" text not null, "pack_id" text not null, "tickets" integer not null, "source" text check ("source" in ('pack', 'reward', 'free', 'gift', 'bonus')) not null, "bonus_bp" integer not null default 0, "open_id" text not null, "rolled_at" timestamptz not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "ticket_spin_pkey" primary key ("id"));`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_ticket_spin_deleted_at" ON "ticket_spin" ("deleted_at") WHERE deleted_at IS NULL;`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_ticket_spin_customer" ON "ticket_spin" ("customer_id") WHERE deleted_at IS NULL;`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_ticket_spin_open" ON "ticket_spin" ("open_id") WHERE deleted_at IS NULL;`,
    );

    this.reasons(['task_claim', 'entry', 'refund', 'admin_grant', 'pack_spin']);
  }

  // Narrowing the CHECK fails against rows that use the new value, and dropping
  // ticket_spin would lose what those tickets were won from: refuse while any
  // exists. A ticket pack with no spins yet survives as an empty card pack; its
  // ticket_prize rows go with the table.
  override async down(): Promise<void> {
    this.addSql(`DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM lucky_draw_ticket WHERE reason = 'pack_spin')
        THEN
          RAISE EXCEPTION 'pack_spin ticket rows exist; refusing to unwind Migration20261030100000';
        END IF;
      END $$;`);
    this.reasons(['task_claim', 'entry', 'refund', 'admin_grant']);
    this.addSql(`drop table if exists "ticket_spin" cascade;`);
    this.addSql(`drop table if exists "ticket_prize" cascade;`);
    this.addSql(
      `alter table if exists "pack" drop column if exists "prize_type";`,
    );
  }

  private reasons(values: string[]): void {
    this.addSql(
      `alter table if exists "lucky_draw_ticket" drop constraint if exists "lucky_draw_ticket_reason_check";`,
    );
    this.addSql(
      `alter table if exists "lucky_draw_ticket" add constraint "lucky_draw_ticket_reason_check" check ("reason" in (${values.map((v) => `'${v}'`).join(', ')}));`,
    );
  }
}
