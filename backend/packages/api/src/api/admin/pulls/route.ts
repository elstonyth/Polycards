import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { Modules } from "@medusajs/framework/utils";
import PacksModuleService from "../../../modules/packs/service";
import { PACKS_MODULE } from "../../../modules/packs";

// GET /admin/pulls — the gacha Pull ledger for the operator, plus rollups.
// Admin-only (auto-protected /admin/* route), so unlike the PUBLIC recent-pulls
// feed this MAY join the customer email (legitimate operator visibility into who
// pulled what — the PII discipline applies only to customer-facing surfaces).
//
// Returns the most recent LEDGER_LIMIT pulls (card + customer email) and, over a
// wider window, the top cards and rarities by pull count.
const LEDGER_LIMIT = 50;
const ROLLUP_WINDOW = 5000;

export async function GET(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const packs: PacksModuleService = req.scope.resolve(PACKS_MODULE);
  const customerService = req.scope.resolve(Modules.CUSTOMER);

  const allPulls = await packs.listPulls(
    {},
    { order: { rolled_at: "DESC" }, take: ROLLUP_WINDOW }
  );

  const handles = [...new Set(allPulls.map((p) => p.card_id))];
  const cards = handles.length
    ? await packs.listCards({ handle: handles }, { take: handles.length })
    : [];
  const cardByHandle = new Map(cards.map((c) => [c.handle, c]));

  // Rollups over the full window.
  const cardCounts = new Map<string, number>();
  const rarityCounts = new Map<string, number>();
  for (const p of allPulls) {
    cardCounts.set(p.card_id, (cardCounts.get(p.card_id) ?? 0) + 1);
    const rarity = cardByHandle.get(p.card_id)?.rarity;
    if (rarity) rarityCounts.set(rarity, (rarityCounts.get(rarity) ?? 0) + 1);
  }

  const topCards = [...cardCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([handle, count]) => {
      const card = cardByHandle.get(handle);
      return {
        handle,
        name: card?.name ?? handle,
        rarity: card?.rarity ?? null,
        market_value: card ? Number(card.market_value) : null,
        image: card?.image ?? null,
        count,
      };
    });

  const topRarities = [...rarityCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([rarity, count]) => ({ rarity, count }));

  // Ledger rows (recent slice) — join the customer email for these only.
  const ledger = allPulls.slice(0, LEDGER_LIMIT);
  const customerIds = [
    ...new Set(ledger.map((p) => p.customer_id).filter((id): id is string => !!id)),
  ];
  const customers = customerIds.length
    ? await customerService.listCustomers(
        { id: customerIds },
        { take: customerIds.length }
      )
    : [];
  const emailById = new Map(customers.map((c) => [c.id, c.email]));

  const pulls = ledger.map((p) => {
    const card = cardByHandle.get(p.card_id);
    return {
      id: p.id,
      rolled_at: p.rolled_at,
      customer_id: p.customer_id,
      customer_email: p.customer_id ? emailById.get(p.customer_id) ?? null : null,
      pack_id: p.pack_id,
      card: card
        ? {
            handle: card.handle,
            name: card.name,
            rarity: card.rarity,
            market_value: Number(card.market_value),
            image: card.image,
          }
        : null,
    };
  });

  res.json({ total: allPulls.length, pulls, topCards, topRarities });
}
