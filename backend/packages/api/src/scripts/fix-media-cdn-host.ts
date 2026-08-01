/**
 * fix-media-cdn-host.ts
 *
 * Finish the 2026-07-15 infra-rename runbook Phase 3c: the sweep rewrote
 * image URLs to the polycards-media bucket but missed several columns
 * (pixel_pokemon.image_url, image.url, card.sprite_image,
 * site_settings.avatar_frames, product.thumbnail). The old CDN endpoint
 * pokenic-media.sgp1.cdn.digitaloceanspaces.com is NXDOMAIN (DO retired
 * Spaces CDN endpoints), so every remaining reference is a broken image.
 * The same object keys serve 200 from the polycards-media CDN endpoint,
 * so a pure host rewrite is the whole fix.
 *
 * Rather than hardcoding the known columns, this scans EVERY text/varchar/
 * jsonb column of every base table in the public schema for the dead host
 * and rewrites all hits — any occurrence is broken by definition, so the
 * rewrite is safe universally (and catches columns the audit missed).
 * Audit tables are report-only: history stays immutable, and a dead host
 * inside an old audit payload breaks nothing rendered.
 *
 * RUN (dry-run by default — prints per-column hit counts, writes nothing):
 *   corepack yarn medusa exec ./src/scripts/fix-media-cdn-host.ts
 * APPLY:
 *   APPLY=1 corepack yarn medusa exec ./src/scripts/fix-media-cdn-host.ts
 *
 * Idempotent: re-running after a successful apply finds 0 non-audit hits.
 * Compare the dry-run total against expectations before APPLY=1, and rerun
 * the dry run afterwards expecting only the audit-table hits to remain.
 */
import { ExecArgs } from '@medusajs/framework/types';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';

const OLD_HOST = 'pokenic-media.sgp1.cdn.digitaloceanspaces.com';
const NEW_HOST = 'polycards-media.sgp1.cdn.digitaloceanspaces.com';

// Audit trails stay immutable — report hits there but never rewrite them.
const SKIP_TABLES = new Set(['admin_action_audit']);

export default async function fixMediaCdnHost({
  container,
}: ExecArgs): Promise<void> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const pg = container.resolve(ContainerRegistrationKeys.PG_CONNECTION);
  const apply = process.env.APPLY === '1';

  // Base tables only (views would UPDATE their base table or abort), and
  // never generated columns (an UPDATE on those always throws).
  const { rows: columns } = await pg.raw(
    `SELECT c.table_name, c.column_name, c.data_type
       FROM information_schema.columns c
       JOIN information_schema.tables t
         ON t.table_schema = c.table_schema AND t.table_name = c.table_name
       WHERE c.table_schema = 'public'
         AND t.table_type = 'BASE TABLE'
         AND c.is_generated = 'NEVER'
         AND c.data_type IN ('text', 'character varying', 'jsonb')
       ORDER BY c.table_name, c.column_name`,
  );

  const pattern = `%${OLD_HOST}%`;
  let found = 0;
  let rewritten = 0;
  let auditHits = 0;
  for (const col of columns) {
    const jsonb = col.data_type === 'jsonb';
    const where = jsonb ? 'CAST(?? AS text) LIKE ?' : '?? LIKE ?';
    try {
      const res = await pg.raw(
        `SELECT count(*)::int AS n FROM ?? WHERE ${where}`,
        [col.table_name, col.column_name, pattern],
      );
      const hits: number = res.rows[0].n;
      if (!hits) continue;
      found += hits;
      logger.info(
        `[fix-media-cdn-host] ${col.table_name}.${col.column_name} (${col.data_type}): ${hits} row(s)`,
      );
      if (SKIP_TABLES.has(col.table_name)) {
        auditHits += hits;
        logger.info(
          '[fix-media-cdn-host]   -> skipped (audit table, immutable)',
        );
        continue;
      }
      if (!apply) continue;
      const set = jsonb
        ? '?? = CAST(REPLACE(CAST(?? AS text), ?, ?) AS jsonb)'
        : '?? = REPLACE(??, ?, ?)';
      const updated = await pg.raw(`UPDATE ?? SET ${set} WHERE ${where}`, [
        col.table_name,
        col.column_name,
        col.column_name,
        OLD_HOST,
        NEW_HOST,
        col.column_name,
        pattern,
      ]);
      rewritten += updated.rowCount ?? 0;
      logger.info(
        `[fix-media-cdn-host]   -> rewrote ${updated.rowCount} row(s)`,
      );
    } catch (e) {
      // Keep scanning, but never silently: a swallowed error here would let a
      // dry run report "clean" while having checked nothing.
      logger.warn(
        `[fix-media-cdn-host] SKIPPED ${col.table_name}.${col.column_name}: ${(e as Error).message}`,
      );
    }
  }

  if (found === 0) {
    logger.info('[fix-media-cdn-host] Clean — no references to the dead host.');
  } else if (apply) {
    logger.info(
      `[fix-media-cdn-host] ${found} hit(s) found; ${rewritten} row(s) rewritten, ${auditHits} audit hit(s) left untouched.`,
    );
  } else {
    logger.info(
      `[fix-media-cdn-host] ${found} hit(s) found (dry run — set APPLY=1 to rewrite; ${auditHits} of them are audit-table hits that stay untouched).`,
    );
  }
}
