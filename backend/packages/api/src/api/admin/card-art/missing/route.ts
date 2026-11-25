import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
import type { Knex } from 'knex';

// GET /admin/card-art/missing — the printings in the stored card list that
// have no clean art yet, grouped by set (the code before the dash: OP05,
// EB02, P), with each set's total. Empty card list = never refreshed.
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const db = req.scope.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
  const [{ rows: totals }, { rows: missing }, { rows: meta }] =
    await Promise.all([
      db.raw(
        `select split_part(code, '-', 1) as set, count(*)::int as total from card_list group by 1`,
      ),
      db.raw(
        `select l.code, l.name from card_list l left join card_art a on a.code = l.code where a.code is null order by l.code`,
      ),
      db.raw(
        `select count(*)::int as total, max(fetched_at) as fetched_at from card_list`,
      ),
    ]);
  const bySet = new Map<string, { code: string; name: string }[]>();
  for (const m of missing as { code: string; name: string }[]) {
    const set = m.code.split('-')[0];
    (bySet.get(set) ?? bySet.set(set, []).get(set)!).push(m);
  }
  res.json({
    total: meta[0].total,
    missing: missing.length,
    fetched_at: meta[0].fetched_at,
    sets: (totals as { set: string; total: number }[])
      .filter((t) => bySet.has(t.set))
      .sort((a, b) => a.set.localeCompare(b.set))
      .map((t) => ({
        ...t,
        missing: bySet.get(t.set)!.length,
        cards: bySet.get(t.set)!,
      })),
  });
}
