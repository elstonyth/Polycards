import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import {
  ContainerRegistrationKeys,
  MedusaError,
} from '@medusajs/framework/utils';
import type { Knex } from 'knex';
import { normalizeCardArtCode, parseCardArtBody } from './parse';

// Clean card art library (owner 2026-11-26): one stamp-free image per card
// printing, keyed by code. The images themselves go up through POST
// /admin/media (kind 'card', same checks and storage); this route keeps the
// code -> URL rows. Auth + RBAC: /admin/card-art is in CUSTOM_ADMIN_RESOURCES.
//
// GET  ?code=OP05-119        every printing of that card (OP05-119, OP05-119_p1, ...)
// GET  ?q=OP05&limit&offset  library page: codes starting with q, plus per-set counts
// POST { items: [{ code, image_url }] }  upsert (re-upload replaces)

const PAGE_MAX = 200;
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const db = req.scope.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
  const code = typeof req.query.code === 'string' ? req.query.code.trim() : '';
  if (code) {
    const base = normalizeCardArtCode(code)?.replace(/_p\d+$/, '');
    if (!base)
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `Not a card code: ${code}`,
      );
    const { rows } = await db.raw(
      `select code, image_url, updated_at from card_art where code = ? or code like ? escape '\\' order by length(code), code`,
      [base, `${escapeLike(base)}\\_p%`],
    );
    res.json({ card_art: rows });
    return;
  }
  const q =
    typeof req.query.q === 'string' ? req.query.q.trim().toUpperCase() : '';
  const limit = Math.min(Math.max(Number(req.query.limit) || 60, 1), PAGE_MAX);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const like = `${escapeLike(q)}%`;
  const [{ rows }, { rows: count }, { rows: sets }] = await Promise.all([
    db.raw(
      `select code, image_url, updated_at from card_art where upper(code) like ? escape '\\' order by code limit ? offset ?`,
      [like, limit, offset],
    ),
    db.raw(
      `select count(*)::int as total from card_art where upper(code) like ? escape '\\'`,
      [like],
    ),
    db.raw(
      `select split_part(code, '-', 1) as set, count(*)::int as count from card_art group by 1 order by 1`,
    ),
  ]);
  res.json({ card_art: rows, total: count[0].total, limit, offset, sets });
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const parsed = parseCardArtBody((req.body ?? {}) as Record<string, unknown>);
  if (!parsed.ok)
    throw new MedusaError(MedusaError.Types.INVALID_DATA, parsed.message);
  const db = req.scope.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
  const values = parsed.value.flatMap((i) => [i.code, i.image_url]);
  await db.raw(
    `insert into card_art (code, image_url) values ${parsed.value.map(() => '(?, ?)').join(', ')}
     on conflict (code) do update set image_url = excluded.image_url, updated_at = now()`,
    values,
  );
  res.json({ saved: parsed.value.length });
}
