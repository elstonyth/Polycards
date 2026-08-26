import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// Finishes the product-option move that #503 could only half-apply.
//
// Medusa core's Migration20251022153442 moved the product<->option relation
// onto `product_product_option` / `product_product_option_value` and then
// dropped the legacy `product_option.product_id`. Production recorded that
// migration during the brief 2.17.2 window in #93, #102 reverted the code to
// 2.13.4, and the repo hotfix Migration20260708120000 re-added `product_id` so
// 2.13.4's ProductOption model would stop 400ing. `db:migrate` only rolls
// forward, so the vendor migration can never re-run and finish the job.
//
// #503 replayed the DATA half (both pivots + `is_exclusive`) from a pre-migrate
// script but deliberately left the legacy column alone: the previous release
// was still serving on 2.13.4 while the migrate job ran, and that model needed
// it. 2.19 is live now, nothing reads `product_option.product_id` any more, and
// leaving it in place keeps an ON DELETE CASCADE foreign key on a column the
// ORM does not manage. This drops the legacy shape, mirroring the tail of
// Migration20251022153442.up().
//
// The guard is the point. `product_id` is the ONLY mapping from an option back
// to its product on a database that never got the pivot backfill — dropping it
// there destroys data with no way back. So the migration refuses to run unless
// every legacy row is already represented in both pivots. In the deploy path
// that is guaranteed: `deploy:migrate-user` runs
// `repair-product-option-pivots.cjs` immediately before `db:migrate`. A bare
// `medusa db:migrate` against an unrepaired database aborts here instead, which
// is the intended outcome — run the repair script first.
export class Migration20260826120000 extends Migration {
  override async up(): Promise<void> {
    // Everything that touches `product_id` goes through EXECUTE so plpgsql
    // never plans a reference to a column that may not exist.
    this.addSql(`
      DO $$
      DECLARE
        unlinked_options bigint;
        unlinked_values bigint;
      BEGIN
        -- Already cleaned up, or a fresh database whose product module has not
        -- been migrated yet: nothing to do either way.
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'product_option'
            AND column_name = 'product_id'
        ) THEN
          RETURN;
        END IF;

        -- A database still on the pre-2.16 shape: the pivots do not exist, so
        -- the core migration has not run here yet and will do the move itself.
        IF to_regclass('public.product_product_option') IS NULL
           OR to_regclass('public.product_product_option_value') IS NULL THEN
          RETURN;
        END IF;

        EXECUTE $q$
          SELECT count(*) FROM product_option po
          WHERE po.deleted_at IS NULL
            AND po.product_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM product_product_option ppo
              WHERE ppo.product_option_id = po.id
                AND ppo.product_id = po.product_id
                AND ppo.deleted_at IS NULL
            )
        $q$ INTO unlinked_options;

        IF unlinked_options > 0 THEN
          RAISE EXCEPTION
            'refusing to drop product_option.product_id: % option row(s) are not in product_product_option — run repair-product-option-pivots.cjs first',
            unlinked_options;
        END IF;

        EXECUTE $q$
          SELECT count(*) FROM product_option_value pov
          JOIN product_option po
            ON po.id = pov.option_id
           AND po.deleted_at IS NULL
           AND po.product_id IS NOT NULL
          WHERE pov.deleted_at IS NULL
            AND NOT EXISTS (
              SELECT 1
              FROM product_product_option_value ppov
              JOIN product_product_option ppo
                ON ppo.id = ppov.product_product_option_id
               AND ppo.deleted_at IS NULL
              WHERE ppov.product_option_value_id = pov.id
                AND ppo.product_option_id = po.id
                AND ppov.deleted_at IS NULL
            )
        $q$ INTO unlinked_values;

        IF unlinked_values > 0 THEN
          RAISE EXCEPTION
            'refusing to drop product_option.product_id: % option value(s) are not in product_product_option_value — run repair-product-option-pivots.cjs first',
            unlinked_values;
        END IF;

        -- The drops live INSIDE the guard on purpose. As separate statements
        -- they would still fire after either RETURN above — and on a pre-2.16
        -- database, where the pivots do not exist yet, that would destroy the
        -- only option->product mapping there is.
        EXECUTE 'alter table if exists "product_option" drop constraint if exists "product_option_product_id_foreign"';
        EXECUTE 'drop index if exists "IDX_product_option_product_id"';
        EXECUTE 'drop index if exists "IDX_option_product_id_title_unique"';
        EXECUTE 'alter table if exists "product_option" drop column if exists "product_id"';
      END $$;
    `);
  }

  override async down(): Promise<void> {
    // Mirrors Migration20260708120000's original body: the pivot still holds
    // the mapping, so the legacy column can be rebuilt from it.
    this.addSql(
      `alter table if exists "product_option" add column if not exists "product_id" text;`,
    );
    this.addSql(`
      DO $$
      BEGIN
        IF to_regclass('public.product_product_option') IS NOT NULL THEN
          UPDATE "product_option" po
          SET "product_id" = ppo."product_id"
          FROM "product_product_option" ppo
          WHERE po."id" = ppo."product_option_id"
            AND ppo."deleted_at" IS NULL
            AND po."product_id" IS NULL;
        END IF;
      END $$;
    `);
    this.addSql(`
      DO $$
      BEGIN
        BEGIN
          CREATE INDEX IF NOT EXISTS "IDX_product_option_product_id"
            ON "product_option" (product_id) WHERE deleted_at IS NULL;
        EXCEPTION WHEN others THEN NULL; END;

        BEGIN
          CREATE UNIQUE INDEX IF NOT EXISTS "IDX_option_product_id_title_unique"
            ON "product_option" (product_id, title) WHERE deleted_at IS NULL;
        EXCEPTION WHEN others THEN NULL; END;

        BEGIN
          ALTER TABLE "product_option"
            ADD CONSTRAINT "product_option_product_id_foreign"
            FOREIGN KEY ("product_id") REFERENCES "product" ("id")
            ON UPDATE CASCADE ON DELETE CASCADE;
        EXCEPTION WHEN others THEN NULL; END;
      END $$;
    `);
  }
}
