import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { PACKS_MODULE } from "../../../modules/packs";
import type PacksModuleService from "../../../modules/packs/service";
import {
  ledgerTotals,
  packTheoreticalRtp,
  type LedgerRow,
} from "../../../modules/packs/economy";
import { pageAll } from "../../utils/page-all";
import { toMoney } from "../../../modules/packs/money";

// GET /admin/economy — the operator's money report: lifetime ledger totals
// (revenue / payouts / top-ups / adjustments / net), the outstanding vault
// liability (FMV of every vaulted pull), and a per-active-pack theoretical
// RTP table from the CURRENT odds × FMVs. Reads only; pure math lives in
// modules/packs/economy.ts.
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);

  // Lifetime ledger totals — paged like creditBalance so the report stays
  // exact at any ledger size (id tiebreaker: batch inserts share created_at).
  const ledger = await pageAll(
    (opts) => packs.listCreditTransactions({}, opts),
    { created_at: "ASC", id: "ASC" },
  );
  const rows: LedgerRow[] = ledger.map((t) => ({
    reason: t.reason,
    amount: Number(t.amount),
  }));
  const totals = ledgerTotals(rows);

  // Vault liability: FMV of every card customers still hold. Pull.card_id IS
  // Card.handle (the stable join key, same as the vault route).
  const vaultedPulls = await pageAll((opts) =>
    packs.listPulls({ status: "vaulted" }, opts),
  );
  const vaultedByCard = new Map<string, number>();
  for (const p of vaultedPulls) {
    vaultedByCard.set(p.card_id, (vaultedByCard.get(p.card_id) ?? 0) + 1);
  }
  const allCards = await pageAll((opts) => packs.listCards({}, opts));
  const valueByHandle = new Map(
    allCards.map((c) => [c.handle, toMoney(c.market_value)]),
  );
  let liabilityCents = 0;
  let liabilityCount = 0;
  for (const [handle, count] of vaultedByCard) {
    const value = valueByHandle.get(handle);
    if (value === undefined || !Number.isFinite(value)) continue; // card removed
    liabilityCents += Math.round(value * 100) * count;
    liabilityCount += count;
  }

  // Per-pack theoretical RTP from current odds (active packs only — drafts
  // aren't sellable, so their RTP is operator-noise).
  const allPacks = await pageAll((opts) =>
    packs.listPacks({ status: "active" }, opts),
  );
  const allOdds = await pageAll((opts) => packs.listPackOdds({}, opts));
  const oddsByPack = new Map<
    string,
    { weight: number; market_value: number }[]
  >();
  for (const o of allOdds) {
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
    liability: { count: liabilityCount, market_value: liabilityCents / 100 },
    packs: packRows,
  });
}
