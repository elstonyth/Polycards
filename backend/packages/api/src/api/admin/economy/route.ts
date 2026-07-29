import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { PACKS_MODULE } from '../../../modules/packs';
import type PacksModuleService from '../../../modules/packs/service';
import { ledgerTotals, packTheoreticalRtp } from '../../../modules/packs/economy';
import { pageAll } from '../../utils/page-all';
import { toMoney } from '../../../modules/packs/money';
import {
  resolveFxRate,
  displayMarketPrice,
  DEFAULT_MARKET_MULTIPLIER,
} from '../../../modules/packs/pricing';

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
// period window (omit both = all time), the outstanding vault liability (raw
// FMV of every vaulted pull), and a per-active-pack theoretical RTP table from
// the CURRENT odds × card DISPLAY values (FMV × markup — the buyback basis).
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
  const totals = ledgerTotals(await packs.ledgerReasonTotals(from, to));

  // Vault liability: FMV of every card customers still hold, summed in SQL
  // (audit 2026-07-07 #5b) instead of paging every vaulted pull into Node.
  const allCards = await pageAll((opts) => packs.listCards({}, opts));
  const fx = await resolveFxRate(packs);
  // Card FMV is stored in USD; the economy report shows MYR at the live FX rate.
  // EV/RTP use each card's DISPLAY value (FMV × market_multiplier, default +20%)
  // because that is the value buyback percents apply to — multiplier 1 here
  // understated the real payout per open by the markup (operator request
  // 2026-07-23). RTP stays like-for-like: MYR EV ÷ MYR pack price.
  const valueByHandle = new Map(
    allCards.map((c) => [
      c.handle,
      displayMarketPrice(
        toMoney(c.market_value),
        fx,
        toMoney(c.market_multiplier ?? DEFAULT_MARKET_MULTIPLIER),
      ),
    ]),
  );
  const { count: liabilityCount, liability } =
    await packs.vaultLiabilityMyr(fx);

  // Outstanding voucher liability: sum of amount_myr across GRANTED, unfulfilled
  // voucher reward grants. Off-ledger obligation the economy report must surface.
  const outstanding_voucher_liability_myr =
    await packs.outstandingVoucherLiabilityMyr();

  // Per-pack theoretical RTP from current odds (active packs only — drafts
  // aren't sellable, so their RTP is operator-noise).
  const allPacks = await pageAll((opts) =>
    packs.listPacks({ status: 'active' }, opts),
  );
  const allOdds = await pageAll((opts) => packs.listPackOdds({}, opts));
  const oddsByPack = new Map<
    string,
    { weight: number; market_value: number }[]
  >();
  for (const o of allOdds) {
    if (o.card_id == null) continue; // reward row — not a card, no FMV
    const value = valueByHandle.get(o.card_id);
    if (value === undefined) continue; // orphaned odds row
    const list = oddsByPack.get(o.pack_id) ?? [];
    list.push({ weight: o.weight, market_value: value });
    oddsByPack.set(o.pack_id, list);
  }
  const packRows = allPacks
    .map((p) => {
      const rtp = packTheoreticalRtp(
        oddsByPack.get(p.slug) ?? [],
        toMoney(p.price),
      );
      return {
        slug: p.slug,
        title: p.title,
        category: p.category,
        price: toMoney(p.price),
        ev: rtp?.ev ?? null,
        rtp_pct: rtp?.rtp_pct ?? null,
      };
    })
    .sort((a, b) => (b.rtp_pct ?? -1) - (a.rtp_pct ?? -1));

  res.json({
    totals,
    liability: { count: liabilityCount, market_value: liability },
    outstanding_voucher_liability_myr,
    packs: packRows,
  });
}
