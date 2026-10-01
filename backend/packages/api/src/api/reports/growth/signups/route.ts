import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { PACKS_MODULE } from '../../../../modules/packs';
import type PacksModuleService from '../../../../modules/packs/service';
import { parseWindow } from '../../params';
import { reportDb, windowFilter } from '../../sql';

// GET /reports/growth/signups?from&to: new accounts per Malaysia day, counted
// exactly like the admin Stats page (signupTopupStats: has_account, deleted
// accounts included, staff-made accounts left out), plus first top-ups, the
// first payment a new player makes. Bounded like the daily report.
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const window = parseWindow(req.query, { required: true, maxDays: 93 });
  const from = new Date(window.from!);
  const to = new Date(window.to!);
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const stats = await packs.signupTopupStats(from, to);
  const filter = windowFilter(window, 'c.created_at');
  const { rows } = await reportDb(req).raw<{ day: string; n: number }>(
    "SELECT to_char(c.created_at AT TIME ZONE 'Asia/Kuala_Lumpur', 'YYYY-MM-DD') AS day, " +
      'count(*)::int AS n FROM customer c ' +
      "WHERE c.has_account AND c.metadata -> 'partner_credential' IS NULL" +
      filter.sql +
      ' GROUP BY 1 ORDER BY 1',
    filter.params,
  );
  res.json({
    window: { from: window.from, to: window.to },
    signups: stats.signups,
    days: rows.map((r) => ({ day: r.day, signups: Number(r.n) })),
    first_topups: {
      count: stats.first_topup_count,
      amount_myr: stats.first_topup_amount,
    },
    note: "Counted like the admin Stats page: new accounts, including ones since deleted; accounts made by staff are left out. Days are Malaysia days; days with no sign-ups are left out. first_topups counts players whose first-ever deposit settled in the window, whenever they signed up; it is not a conversion rate of this window's sign-ups.",
  });
}
