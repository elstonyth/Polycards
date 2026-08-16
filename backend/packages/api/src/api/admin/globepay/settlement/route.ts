import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { PACKS_MODULE } from '../../../../modules/packs';
import type PacksModuleService from '../../../../modules/packs/service';
import {
  mergeSettlementPeriods,
  settlementSince,
} from '../../../../modules/packs/globepay-settlement';

// GET /admin/globepay/settlement — the gateway's weekly/monthly result, read
// from OUR database (money-path-accuracy-audit-2026-08-17 B4). Calendar MYT
// buckets — deliberately unlike /admin/economy's rolling presets — so a row of
// this report lines up with a GlobePay365 statement month instead of almost
// lining up.
//
// Per period, per direction: count, settled gross, known net, the fee those
// two imply, and how many settled rows have NO net on file (pre-mirror rows —
// NULL means unknown, never zero, so the fee is a floor whenever that count is
// non-zero). Beside them, the credit ledger's own topup/cashout sums for the
// same period and the gateway-vs-ledger delta (audit B5) — the first place the
// two independent records of the same money are compared anywhere in the app.
//
// Read-only, like every other /admin/globepay/* surface: this reports money,
// it never moves it. Admin-only (auto-protected /admin/* route).

const GRANULARITIES = ['week', 'month'] as const;
type Granularity = (typeof GRANULARITIES)[number];

/** Unknown/absent granularity falls back to 'month' — the statement view. */
export function parseGranularity(raw: unknown): Granularity {
  return typeof raw === 'string' &&
    (GRANULARITIES as readonly string[]).includes(raw)
    ? (raw as Granularity)
    : 'month';
}

/**
 * How many periods back to report. Defaults chosen for the two questions the
 * screen answers ("this month vs recent months", "this week vs recent weeks");
 * capped so a typo cannot ask for a decade of GROUP BY.
 */
export function parsePeriods(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return 12;
  return Math.min(n, 60);
}

export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);

  const granularity = parseGranularity(req.query.granularity);
  const periods = parsePeriods(req.query.periods);
  const since = settlementSince(granularity, periods, new Date());

  const rows = await packs.globepaySettlementRows(granularity, since);
  const report = mergeSettlementPeriods(
    rows.deposits,
    rows.withdrawals,
    rows.ledger,
  );

  // Money data varying by nothing but the admin session — same cache rule as
  // the deposits list.
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    granularity,
    periods_requested: periods,
    since: since.toISOString(),
    periods: report,
  });
}
