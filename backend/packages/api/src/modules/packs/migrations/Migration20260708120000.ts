import { Migration } from '@mikro-orm/migrations';

// Prod hotfix (#5 — admin product detail 400 "column ...product_id does not
// exist"). The #93 deploy briefly ran Medusa 2.17.2, whose core
// Migration20251022153442 DROPPED product_option.product_id and moved the
// product↔option relation to a new product_product_option pivot. #102 reverted
// the CODE to 2.13.4, but db:migrate only rolls forward, so the schema stayed
// ahead: 2.13.4's ProductOption still belongsTo(Product) via
// product_option.product_id, and *options is in the DEFAULT admin product field
// set — so every product detail read (and the bare list) 400s on the missing
// column while narrow-field queries dodge it.
//
// This restores the 2.13.4 column from the pivot to reconcile schema with code.
// It is idempotent and best-effort: the essential column + backfill run plainly
// (near-zero failure risk), and the integrity constraints are each wrapped in a
// savepoint that swallows errors so a data edge case can NEVER abort the
// migration and block the deploy. Safe whether or not the 2.17 migration ran
// (all steps become no-ops on an already-2.13.4 schema).
export class Migration20260708120000 extends Migration {
  override async up(): Promise<void> {
    // 1) Essential: restore the column so product reads stop 400ing.
    this.addSql(
      `alter table if exists "product_option" add column if not exists "product_id" text;`,
    );

    // 2) Backfill from the 2.17 pivot (skipped if the pivot never existed).
    this.addSql(`
      do $$
      begin
        if to_regclass('public.product_product_option') is not null then
          update "product_option" po
          set "product_id" = ppo."product_id"
          from "product_product_option" ppo
          where po."id" = ppo."product_option_id"
            and ppo."deleted_at" is null
            and po."product_id" is null;
        end if;
      end $$;
    `);

    // 3) Best-effort integrity to match the 2.13.4 schema. Each in its own
    //    savepoint so a pre-existing constraint / data edge case is swallowed
    //    instead of aborting the migration.
    this.addSql(`
      do $$
      begin
        begin
          create index if not exists "IDX_product_option_product_id"
            on "product_option" (product_id) where deleted_at is null;
        exception when others then null; end;

        begin
          create unique index if not exists "IDX_option_product_id_title_unique"
            on "product_option" (product_id, title) where deleted_at is null;
        exception when others then null; end;

        begin
          alter table "product_option"
            add constraint "product_option_product_id_foreign"
            foreign key ("product_id") references "product" ("id")
            on update cascade on delete cascade;
        exception when others then null; end;
      end $$;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(
      `alter table if exists "product_option" drop constraint if exists "product_option_product_id_foreign";`,
    );
    this.addSql(`drop index if exists "IDX_option_product_id_title_unique";`);
    this.addSql(`drop index if exists "IDX_product_option_product_id";`);
    this.addSql(
      `alter table if exists "product_option" drop column if exists "product_id";`,
    );
  }
}
