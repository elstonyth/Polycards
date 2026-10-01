import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { PACKS_MODULE } from '../../../../modules/packs';
import type PacksModuleService from '../../../../modules/packs/service';
import { describeScope, loadGroupScope, parseWindow } from '../../params';
import { and, reportDb, scopeFilter, windowFilter } from '../../sql';
import { packSales } from '../queries';

// GET /reports/finance/pack-sales: per-pack packs opened and revenue in the
// window, largest revenue first, plus the unattributed remainder, so the
// packs plus unattributed equal economy revenue for the same window.
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const window = parseWindow(req.query);
  const scope = await loadGroupScope(req);
  const { bySlug, unattributedCents } = await packSales(
    reportDb(req),
    and(
      windowFilter(window, 'ct.created_at'),
      scopeFilter(scope, 'ct.customer_id'),
    ),
    and(
      windowFilter(window, 'p.rolled_at'),
      scopeFilter(scope, 'p.customer_id'),
    ),
  );
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const slugs = [...bySlug.keys()];
  const titles = new Map(
    slugs.length === 0
      ? []
      : (await packs.listPacks({ slug: slugs }, { take: slugs.length })).map(
          (p) => [p.slug, p.title],
        ),
  );
  const rows = [...bySlug]
    .map(([slug, s]) => ({
      pack: slug,
      title: titles.get(slug) ?? slug,
      packs_opened: s.opened,
      revenue: s.cents / 100,
    }))
    .sort((a, b) => b.revenue - a.revenue || a.pack.localeCompare(b.pack));
  const totalCents =
    [...bySlug.values()].reduce((sum, s) => sum + s.cents, 0) +
    unattributedCents;
  res.json({
    currency: 'MYR',
    window: { from: window.from ?? null, to: window.to ?? null },
    scope: describeScope(scope),
    packs: rows,
    unattributed_revenue: unattributedCents / 100,
    total_revenue: totalCents / 100,
  });
}
