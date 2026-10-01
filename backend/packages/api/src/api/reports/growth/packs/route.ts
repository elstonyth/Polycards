import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { PACKS_MODULE } from '../../../../modules/packs';
import type PacksModuleService from '../../../../modules/packs/service';
import { describeScope, loadGroupScope, parseWindow } from '../../params';
import { and, reportDb, scopeFilter, windowFilter } from '../../sql';
import { packSales } from '../../finance/queries';

// GET /reports/growth/packs?from&to&group: packs opened per Malaysia day (one
// pull = one pack; paid packs are source 'pack', free welcome packs 'free';
// task and challenge prize draws are not counted) and the most-opened packs,
// from the same packSales query as the Finance pack-sales report. Opens
// only: revenue stays on the Finance desk.
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const window = parseWindow(req.query, { required: true, maxDays: 93 });
  const scope = await loadGroupScope(req);
  const pulls = and(
    windowFilter(window, 'p.rolled_at'),
    scopeFilter(scope, 'p.customer_id'),
  );
  const db = reportDb(req);
  const { rows } = await db.raw<{ day: string; paid: number; free: number }>(
    "SELECT to_char(p.rolled_at AT TIME ZONE 'Asia/Kuala_Lumpur', 'YYYY-MM-DD') AS day, " +
      "count(*) FILTER (WHERE p.source = 'pack')::int AS paid, " +
      "count(*) FILTER (WHERE p.source = 'free')::int AS free " +
      "FROM pull p WHERE p.deleted_at IS NULL AND p.source IN ('pack', 'free')" +
      pulls.sql +
      ' GROUP BY 1 ORDER BY 1',
    pulls.params,
  );
  const { bySlug } = await packSales(
    db,
    and(
      windowFilter(window, 'ct.created_at'),
      scopeFilter(scope, 'ct.customer_id'),
    ),
    pulls,
  );
  const opened = [...bySlug]
    .filter(([, s]) => s.opened > 0)
    .sort(([a, x], [b, y]) => y.opened - x.opened || a.localeCompare(b))
    .slice(0, 10);
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const titles = new Map(
    opened.length === 0
      ? []
      : (
          await packs.listPacks(
            { slug: opened.map(([slug]) => slug) },
            { take: opened.length },
          )
        ).map((p) => [p.slug, p.title]),
  );
  const days = rows.map((r) => ({
    day: r.day,
    packs_opened: Number(r.paid),
    free_packs_opened: Number(r.free),
  }));
  res.json({
    window: { from: window.from, to: window.to },
    scope: describeScope(scope),
    packs_opened: days.reduce((n, d) => n + d.packs_opened, 0),
    free_packs_opened: days.reduce((n, d) => n + d.free_packs_opened, 0),
    days,
    top_packs: opened.map(([slug, s]) => ({
      pack: slug,
      title: titles.get(slug) ?? slug,
      packs_opened: s.opened,
    })),
    note: 'One pull is one pack opened. Free packs are the free welcome packs; task and challenge prize draws are not counted. Days are Malaysia days.',
  });
}
