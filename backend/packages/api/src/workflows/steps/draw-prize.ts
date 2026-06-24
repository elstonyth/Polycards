import { Modules, ContainerRegistrationKeys } from "@medusajs/framework/utils";
import type { MedusaContainer } from "@medusajs/framework/types";
import { pickWonRow } from "./roll-pack";
import { getCardStockByHandle } from "../../modules/packs/card-stock";

// RewardOddsRow — the subset of PackOdds fields drawPrize reads.
// Kept minimal so it can be passed from any caller without the full ORM entity.
export type RewardOddsRow = {
  id: string;
  weight: number;
  kind: "product" | "credit" | "nothing";
  product_handle?: string | null;
  credit_amount?: number | null;
};

// DrawnPrize — the discriminated union returned by drawPrize.
// credit carries amount_myr (decimal MYR, matching PackOdds.credit_amount bigNumber).
// ponytail: union kept flat — no base interface, no shared fields between variants.
export type DrawnPrize =
  | { kind: "product"; product_handle: string; title: string; image: string }
  | { kind: "credit"; amount_myr: number }
  | { kind: "nothing" };

// drawPrize — pure weighted pick + product resolution. Writes no rows.
//
// Stock gate (§8): product entries with 0 available inventory are dropped from
// the survivor pool BEFORE the roll so a sold-out prize can never be won.
// Untracked products (stock=null) pass through as infinite-stock.
// If all entries are gated out → returns {kind:'nothing'} (graceful dead-end,
// never throws, so the caller's cap/ordinal logic stays clean).
//
// After the pick:
//   product → resolve title + thumbnail from Modules.PRODUCT (listProducts by handle).
//   credit  → return amount_myr directly from credit_amount (already decimal MYR).
//   nothing → return as-is.
export async function drawPrize(
  container: MedusaContainer,
  rewardOdds: RewardOddsRow[]
): Promise<DrawnPrize> {
  // 1. Stock-gate: filter out 0-stock product entries.
  const productHandles = rewardOdds
    .filter((r) => r.kind === "product" && r.product_handle)
    .map((r) => r.product_handle as string);

  let stockByHandle = new Map<string, number | null>();
  if (productHandles.length > 0) {
    // best-effort: if the stock check fails, allow the entry through (fail-open
    // for stock only — the goal is opportunistic gating, not a hard block).
    try {
      stockByHandle = await getCardStockByHandle(container, productHandles);
    } catch {
      const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
      logger.warn("draw-prize: stock check failed — treating all product entries as in-stock");
    }
  }

  const survivors = rewardOdds.filter((r) => {
    if (r.kind !== "product") return true;
    const handle = r.product_handle;
    if (!handle) return false;
    // Not in the map = product doesn't exist in catalog; drop it.
    if (!stockByHandle.has(handle)) return productHandles.length === 0 || true;
    const qty = stockByHandle.get(handle);
    // null = untracked = pass through; >0 = in stock = pass through; 0 = gated out.
    return qty === null || (qty !== undefined && qty > 0);
  });

  // 2. If no survivors (all gated out), return nothing gracefully.
  if (survivors.length === 0) return { kind: "nothing" };

  const totalWeight = survivors.reduce((s, r) => s + r.weight, 0);
  const won = pickWonRow(survivors, Math.random() * totalWeight);

  // 3. Branch on kind.
  if (won.kind === "credit") {
    return { kind: "credit", amount_myr: Number(won.credit_amount ?? 0) };
  }

  if (won.kind === "nothing") {
    return { kind: "nothing" };
  }

  // product — resolve title + thumbnail from Modules.PRODUCT.
  const productModule = container.resolve(Modules.PRODUCT);
  const [product] = await productModule.listProducts(
    { handle: won.product_handle! },
    { fields: ["title", "thumbnail"] }
  );
  // If the product was deleted between the stock check and now, return nothing.
  if (!product) return { kind: "nothing" };

  return {
    kind: "product",
    product_handle: won.product_handle!,
    title: (product as { title: string }).title,
    image: (product as { thumbnail?: string }).thumbnail ?? "",
  };
}
