import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { PACKS_MODULE } from "../../../modules/packs";
import type PacksModuleService from "../../../modules/packs/service";
import {
  ledgerTotals,
  packTheoreticalRtp,
  type LedgerRow,
} from "../../../modules/packs/economy";

const PAGE = 1000;

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
  // exact at any ledger size.
  const rows: LedgerRow[] = [];
  for (let skip = 0; ; skip += PAGE) {
    const page = await packs.listCreditTransactions(
      {},
      { skip, take: PAGE, order: { created_at: "ASC" } },
    );
    rows.push(
      ...page.map((t) => ({ reason: t.reason, amount: Number(t.amount) })),
    );
    if (page.length < PAGE) break;
  }
  const totals = ledgerTotals(rows);

  // Vault liability: FMV of every card customers still hold (paged).
  const vaultedByCard = new Map<string, number>();
  for (let skip = 0; ; skip += PAGE) {
    const page = await packs.listPulls(
      { status: "vaulted" },
      { skip, take: PAGE },
    );
    for (const p of page) {
      vaultedByCard.set(p.card_id, (vaultedByCard.get(p.card_id) ?? 0) + 1);
    }
    if (page.length < PAGE) break;
  }
  const allCards = await packs.listCards({}, { take: PAGE });
  const valueByHandle = new Map(
    allCards.map((c) => [c.handle, Number(c.market_value)]),
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
  const allPacks = await packs.listPacks({ status: "active" }, { take: PAGE });
  const allOdds = await packs.listPackOdds({}, { take: 10_000 });
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
        Number(p.price),
      );
      return {
        slug: p.slug,
        title: p.title,
        category: p.category,
        price: Number(p.price),
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
