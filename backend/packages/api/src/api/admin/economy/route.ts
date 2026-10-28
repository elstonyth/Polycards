import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../modules/packs';
import type PacksModuleService from '../../../modules/packs/service';
import { ledgerTotals } from '../../../modules/packs/economy';
import { resolveFxRate } from '../../../modules/packs/pricing';
import { packRtpRows } from './pack-rtp';

// Accept an ISO date string only when it parses; anything else → undefined (no
// bound). ponytail: invalid input silently degrades to "no filter" — the admin
// UI only ever sends valid ISO, and the SQL param is parameterized regardless.
function isoOrUndefined(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 && !Number.isNaN(Date.parse(v))
    ? v
    : undefined;
}

// GET /admin/economy — the operator's money report: ledger totals
// (revenue / payouts / top-ups / adjustments / net) for an optional [from, to)
// period window (omit both = all time), the outstanding vault liability, and a
// per-active-pack theoretical RTP table from the CURRENT odds. Liability, EV
// and RTP all read card DISPLAY values (FMV × markup — the buyback basis), so
// the report no longer shows two bases side by side (issue #263).
// Only the ledger totals are period-scoped; liability and
// RTP are current-state snapshots. Reads only; pure math lives in
// modules/packs/economy.ts.
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);

  // Ledger totals — one GROUP BY in SQL instead of paging the whole ledger to
  // Node (audit 2026-07-07 #5b), optionally scoped to a [from, to) date window.
  // Synthetic per-reason rows keep feeding the same unit-tested ledgerTotals
  // fold (incl. its loud throw on an unrecognized reason).
  const from = isoOrUndefined(req.query.from);
  const to = isoOrUndefined(req.query.to);
  const reasonRows = await packs.ledgerReasonTotals(from, to);
  let totals: ReturnType<typeof ledgerTotals>;
  try {
    totals = ledgerTotals(reasonRows);
  } catch (err) {
    // Keep the tripwire loud, but say WHY: UNEXPECTED_STATE is a 500 whose
    // message survives the framework's error handler (a bare Error is masked
    // as "An unknown error occurred.").
    throw new MedusaError(
      MedusaError.Types.UNEXPECTED_STATE,
      `Economy report cannot be built (${(err as Error).message}); add the reason to ledgerTotals.`,
    );
  }

  // Vault liability: display value of every card customers still hold, summed
  // in SQL (audit 2026-07-07 #5b) instead of paging every vaulted pull into
  // Node. Same basis as the EV/RTP rows (card FMV is USD; MYR at the live FX).
  const fx = await resolveFxRate(packs);
  const { count: liabilityCount, liability } =
    await packs.vaultLiabilityMyr(fx);

  // Outstanding voucher liability: sum of amount_myr across GRANTED, unfulfilled
  // voucher reward grants. Off-ledger obligation the economy report must surface.
  const outstanding_voucher_liability_myr =
    await packs.outstandingVoucherLiabilityMyr();

  // Per-pack theoretical RTP from current odds (pack-rtp.ts, shared with the
  // profit report).
  const packRows = await packRtpRows(packs, fx);

  res.json({
    totals,
    liability: { count: liabilityCount, market_value: liability },
    outstanding_voucher_liability_myr,
    packs: packRows,
  });
}
