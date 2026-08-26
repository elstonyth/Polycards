// Pre-migrate repair: replay the DATA half of @medusajs/product's
// Migration20251022153442 on databases that recorded it but never got its
// effects.
//
// How production ended up there: #93 briefly deployed Medusa 2.17.2, whose
// Migration20251022153442 moved the product<->option relation onto the
// `product_product_option` / `product_product_option_value` pivots and dropped
// `product_option.product_id`. #102 reverted the CODE to 2.13.4, and the repo
// hotfix `Migration20260708120000` restored `product_option.product_id` so
// 2.13.4's ProductOption model would stop 400ing. db:migrate only rolls
// forward, so the ledger kept `Migration20251022153442` marked as applied.
// Every option written by 2.13.4 since then carries `product_id`, is absent
// from both pivots, and has `is_exclusive = false`.
//
// Medusa 2.19's `Migration20260623180000` then adds
//   CREATE UNIQUE INDEX ... ON product_option (title)
//   WHERE deleted_at IS NULL AND is_exclusive = false
// which fails on the duplicated "Format" title and rolls the whole deploy back
// — the state the backend was stuck in from #496 onwards.
//
// This runs as a plain node script (no Medusa boot) BEFORE `medusa db:migrate`,
// because module migrators run concurrently: a packs-module migration has no
// guaranteed ordering against the core product module's.
//
// It is idempotent and self-skipping: on a fresh database (CI, e2e, a clean
// clone) the tables or the legacy column do not exist yet and it exits 0
// without touching anything.
//
// ponytail: delete this script and its `deploy:migrate-user` step once every
// live database has been through it — the drift it repairs cannot recur.

const { Client } = require('pg');

const url = process.env.DATABASE_URL;

// DO Managed Postgres presents a self-signed CA, exactly as
// `productionDatabaseDriverOptions` documents; local/CI Postgres speaks plain
// TCP and rejects an SSL handshake outright.
const isLocal = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url ?? '');
const ssl = isLocal ? false : { rejectUnauthorized: false };

const log = (msg) => console.log(`[repair-product-option-pivots] ${msg}`);

async function main() {
  if (!url) {
    log('DATABASE_URL unset — nothing to do.');
    return;
  }

  const c = new Client({ connectionString: url, ssl });
  await c.connect();
  try {
    const scalar = async (sql, params) =>
      (await c.query(sql, params)).rows[0].n;

    const missingTable = (
      await c.query(
        `select unnest($1::text[]) t
         except
         select table_name from information_schema.tables
         where table_schema = 'public'`,
        [
          [
            'product_option',
            'product_option_value',
            'product_product_option',
            'product_product_option_value',
          ],
        ],
      )
    ).rows.map((r) => r.t);
    if (missingTable.length) {
      log(`skip — tables not present yet: ${missingTable.join(', ')}`);
      return;
    }

    const hasLegacyColumn = await scalar(
      `select count(*)::int n from information_schema.columns
       where table_name = 'product_option' and column_name = 'product_id'`,
    );
    if (!hasLegacyColumn) {
      log('skip — product_option.product_id already gone; nothing to replay.');
      return;
    }

    const legacy = await scalar(
      `select count(*)::int n from product_option
       where product_id is not null and deleted_at is null`,
    );
    if (!legacy) {
      log('skip — no legacy option rows carry product_id.');
      return;
    }

    await c.query('BEGIN');

    const values = await scalar(
      `select count(*)::int n from product_option_value where deleted_at is null`,
    );

    const options = await c.query(`
      insert into product_product_option (id, product_id, product_option_id)
      select gen_random_uuid(), po.product_id, po.id
      from product_option po
      where po.product_id is not null
        and po.deleted_at is null
        and not exists (
          select 1 from product_product_option ppo
          where ppo.product_option_id = po.id
            and ppo.product_id = po.product_id
        )
    `);

    const optionValues = await c.query(`
      insert into product_product_option_value (id, product_product_option_id, product_option_value_id)
      select gen_random_uuid(), ppo.id, pov.id
      from product_option_value pov
      join product_product_option ppo
        on ppo.product_option_id = pov.option_id
       and ppo.deleted_at is null
      where pov.deleted_at is null
        and not exists (
          select 1 from product_product_option_value x
          where x.product_product_option_id = ppo.id
            and x.product_option_value_id = pov.id
        )
    `);

    const exclusive = await c.query(`
      update product_option set is_exclusive = true
      where product_id is not null
        and is_exclusive = false
        and deleted_at is null
    `);

    // The three counts the failing migration actually depends on. Assert them
    // inside the transaction so a partial repair rolls back rather than
    // half-committing and failing the deploy a second time.
    const linkedOptions = await scalar(
      `select count(*)::int n from product_product_option where deleted_at is null`,
    );
    const linkedValues = await scalar(
      `select count(*)::int n from product_product_option_value where deleted_at is null`,
    );
    const stillGlobal = await scalar(
      `select count(*)::int n from product_option
       where deleted_at is null and is_exclusive = false`,
    );

    if (linkedOptions < legacy) {
      throw new Error(
        `product_product_option has ${linkedOptions} rows, expected at least ${legacy}`,
      );
    }
    if (linkedValues < values) {
      throw new Error(
        `product_product_option_value has ${linkedValues} rows, expected at least ${values}`,
      );
    }
    if (stillGlobal) {
      throw new Error(
        `${stillGlobal} option rows are still is_exclusive = false; ` +
          `Migration20260623180000 would fail on their titles`,
      );
    }

    if (process.env.REPAIR_DRY_RUN === '1') {
      await c.query('ROLLBACK');
      log(
        `DRY RUN (rolled back) — would link ${options.rowCount} options, ` +
          `${optionValues.rowCount} option values, mark ${exclusive.rowCount} exclusive.`,
      );
      return;
    }

    await c.query('COMMIT');
    log(
      `repaired — linked ${options.rowCount} options, ${optionValues.rowCount} option values, ` +
        `marked ${exclusive.rowCount} exclusive.`,
    );
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(`[repair-product-option-pivots] FAILED: ${e.message}`);
  process.exit(1);
});
