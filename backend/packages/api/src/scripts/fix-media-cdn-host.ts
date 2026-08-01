/**
 * fix-media-cdn-host.ts
 *
 * Finish the 2026-07-15 infra-rename runbook Phase 3c: the sweep rewrote
 * image URLs to the polycards-media bucket but missed several columns
 * (pixel_pokemon.image_url, image.url, card.sprite_image,
 * site_settings.avatar_frames). The old CDN endpoint
 * pokenic-media.sgp1.cdn.digitaloceanspaces.com is NXDOMAIN (DO retired
 * Spaces CDN endpoints), so every remaining reference is a broken image.
 * The same object keys serve 200 from the polycards-media CDN endpoint,
 * so a pure host rewrite is the whole fix.
 *
 * Rather than hardcoding the four known columns, this scans EVERY
 * text/varchar/jsonb column in the public schema for the dead host and
 * rewrites all hits — any occurrence is broken by definition, so the
 * rewrite is safe universally (and catches columns the audit missed).
 *
 * RUN (dry-run by default — prints per-column hit counts, writes nothing):
 *   corepack yarn medusa exec ./src/scripts/fix-media-cdn-host.ts
 * APPLY:
 *   APPLY=1 corepack yarn medusa exec ./src/scripts/fix-media-cdn-host.ts
 *
 * Idempotent: re-running after a successful apply finds 0 hits.
 */
import { ExecArgs } from '@medusajs/framework/types';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';

const OLD_HOST = 'pokenic-media.sgp1.cdn.digitaloceanspaces.com';
const NEW_HOST = 'polycards-media.sgp1.cdn.digitaloceanspaces.com';

export default async function fixMediaCdnHost({
  container,
}: ExecArgs): Promise<void> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const pg = container.resolve(ContainerRegistrationKeys.PG_CONNECTION);
  const apply = process.env.APPLY === '1';
  // Audit trails stay immutable — report hits there but never rewrite them
  // (a dead host inside a historical audit payload breaks nothing).
  const SKIP_TABLES = new Set(['admin_action_audit']);

  const { rows: columns } = await pg.raw(
    `SELECT table_name, column_name, data_type
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND data_type IN ('text', 'character varying', 'jsonb')
       ORDER BY table_name, column_name`,
  );

  let totalHits = 0;
  for (const col of columns) {
    const t = `"${col.table_name}"`;
    const c = `"${col.column_name}"`;
    const expr = col.data_type === 'jsonb' ? `${c}::text` : c;
    let hits: number;
    try {
      const res = await pg.raw(
        `SELECT count(*)::int AS n FROM ${t} WHERE ${expr} LIKE ?`,
        [`%${OLD_HOST}%`],
      );
      hits = res.rows[0].n;
    } catch {
      continue; // views / permission oddities — nothing to fix there
    }
    if (!hits) continue;
    totalHits += hits;
    logger.info(
      `[fix-media-cdn-host] ${col.table_name}.${col.column_name} (${col.data_type}): ${hits} row(s)`,
    );
    if (!apply) continue;
    if (SKIP_TABLES.has(col.table_name)) {
      logger.info('[fix-media-cdn-host]   -> skipped (audit table, immutable)');
      continue;
    }
    const set =
      col.data_type === 'jsonb'
        ? `${c} = REPLACE(${c}::text, ?, ?)::jsonb`
        : `${c} = REPLACE(${c}, ?, ?)`;
    const updated = await pg.raw(
      `UPDATE ${t} SET ${set} WHERE ${expr} LIKE ?`,
      [OLD_HOST, NEW_HOST, `%${OLD_HOST}%`],
    );
    logger.info(`[fix-media-cdn-host]   -> rewrote ${updated.rowCount} row(s)`);
  }

  logger.info(
    totalHits === 0
      ? '[fix-media-cdn-host] Clean — no references to the dead host.'
      : `[fix-media-cdn-host] ${totalHits} total hit(s) ${apply ? 'rewritten' : 'found (dry run — set APPLY=1 to rewrite)'}.`,
  );
}
