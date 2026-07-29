import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import PacksModuleService from "../../../modules/packs/service";
import { PACKS_MODULE } from "../../../modules/packs";
import { createPackWorkflow } from "../../../workflows/create-pack";
import { coercePackBody } from "./validate";
import { clearPackListCache } from "../../store/packs/route";
import type { PublishedOdds } from "../../../workflows/steps/create-pack";
import { pageAll } from "../../utils/page-all";
import { toMoney } from "../../../modules/packs/money";
import {
  packTheoreticalRtp,
  publishedEv,
} from "../../../modules/packs/economy";
import { isGraded } from "../../../modules/packs/card-view";
import { weightForSet, type OddsSet } from "../../../modules/packs/odds-sets";
import {
  resolveFxRate,
  displayMarketPrice,
  DEFAULT_MARKET_MULTIPLIER,
} from "../../../modules/packs/pricing";

const round2 = (n: number): number => Math.round(n * 100) / 100;

// GET /admin/packs — the pack selector list for the win-rate editor. An admin
// route, so it is auto-protected by Medusa's admin auth (session/bearer); no
// custom middleware needed. Returns every pack (active + draft) ordered by
// (category, rank) to mirror the storefront grouping.
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const packsModuleService: PacksModuleService = req.scope.resolve(PACKS_MODULE);

  const packs = await packsModuleService.listPacks({}, { take: 1000 });
  const sorted = [...packs].sort((a, b) =>
    a.category === b.category
      ? a.rank - b.rank
      : a.category.localeCompare(b.category)
  );

  // Stats fan-out — every odds row and every card ONCE, then all the per-pack
  // math in memory (same shape as GET /admin/economy). N packs must not mean
  // N queries: this list renders on every admin pack-page load.
  const allOdds = await pageAll((opts) =>
    packsModuleService.listPackOdds({}, opts)
  );
  const allCards = await pageAll((opts) =>
    packsModuleService.listCards({}, opts)
  );
  const fx = await resolveFxRate(packsModuleService);
  // PRICE, not raw FMV: FMV × live fx × the card's OWN markup multiplier — the
  // same basis the odds editor and /admin/economy use, so the EV an operator
  // reads here matches the one in the editor they opened it from.
  const priceByHandle = new Map(
    allCards.map((c) => [
      c.handle,
      displayMarketPrice(
        toMoney(c.market_value),
        fx,
        toMoney(c.market_multiplier ?? DEFAULT_MARKET_MULTIPLIER)
      ),
    ])
  );
  const graderByHandle = new Map(allCards.map((c) => [c.handle, c.grader]));

  // Reward rows (card_id null) carry no card and no value — drop them here so
  // the per-pack loop below never has to re-check. Narrows card_id to string.
  const cardOdds = allOdds.filter(
    (o): o is typeof o & { card_id: string } => o.card_id != null
  );
  const oddsByPack = new Map<string, typeof cardOdds>();
  for (const o of cardOdds) {
    const list = oddsByPack.get(o.pack_id) ?? [];
    list.push(o);
    oddsByPack.set(o.pack_id, list);
  }

  res.json({
    packs: sorted.map((p) => {
      const price = toMoney(p.price);
      // One pass over the pack's pool feeds all three readouts: the per-set
      // EV/RTP inputs, the RAW/GRADED composition, and the per-tier price
      // averages Published EV is folded over.
      const pool: {
        weight: number;
        weight_2: number | null;
        weight_3: number | null;
        market_value: number;
      }[] = [];
      const tiers = new Map<string, { sum: number; n: number }>();
      let graded = 0;
      for (const o of oddsByPack.get(p.slug) ?? []) {
        const cardPrice = priceByHandle.get(o.card_id);
        const grader = graderByHandle.get(o.card_id);
        // Orphaned odds row (card deleted) — not part of the pool at all.
        if (cardPrice === undefined || grader === undefined) continue;
        if (isGraded({ grader })) graded++;
        const rarity = o.rarity ?? "Common";
        const t = tiers.get(rarity) ?? { sum: 0, n: 0 };
        t.sum += cardPrice;
        t.n += 1;
        tiers.set(rarity, t);
        pool.push({
          weight: o.weight,
          weight_2: o.weight_2,
          weight_3: o.weight_3,
          market_value: cardPrice,
        });
      }

      // Each set resolves its own weights (NULL = inherit 3→2→1 per card), so
      // the three EVs differ exactly as the three draw distributions do.
      const rtpFor = (s: OddsSet) =>
        packTheoreticalRtp(
          pool.map((c) => ({
            weight: weightForSet(c, s),
            market_value: c.market_value,
          })),
          price
        );
      const [r1, r2, r3] = [rtpFor(1), rtpFor(2), rtpFor(3)];

      const tierAvgPrice: Record<string, number> = {};
      for (const [rarity, { sum, n }] of tiers) tierAvgPrice[rarity] = sum / n;
      // What the PLAYER is promised (published tier %) vs. what the secret
      // weights actually pay (ev/rtp above) — the gap is the whole point.
      const pub_ev = publishedEv(
        tierAvgPrice,
        (p.published_odds as PublishedOdds | null)?.tiers
      );

      return {
        slug: p.slug,
        title: p.title,
        category: p.category,
        status: p.status,
        rank: p.rank,
        price: p.price,
        image: p.image,
        display_image: p.display_image ?? null,
        buyback_percent: p.buyback_percent,
        boost: p.boost,
        published_odds: p.published_odds ?? null,
        // §2.4.8 composition — AUTO-DETECTED from the pool, never operator-set.
        // Null = empty pool: nothing to infer from, not "raw".
        group: !pool.length
          ? null
          : graded === pool.length
            ? "GRADED"
            : graded === 0
              ? "RAW"
              : "MIX",
        ev: { s1: r1?.ev ?? null, s2: r2?.ev ?? null, s3: r3?.ev ?? null },
        rtp: {
          s1: r1?.rtp_pct ?? null,
          s2: r2?.rtp_pct ?? null,
          s3: r3?.rtp_pct ?? null,
        },
        pub_ev,
        pub_rtp:
          pub_ev !== null && price > 0 ? round2((pub_ev / price) * 100) : null,
      };
    }),
  });
}

// POST /admin/packs — create a pack listing. A new pack starts with an empty
// prize pool; cards are assigned via the membership editor.
export async function POST(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const slug = typeof body.slug === "string" ? body.slug.trim() : "";
  const input = coercePackBody(body, slug);

  const { result } = await createPackWorkflow(req.scope).run({ input });
  // A pack can be created directly as `active`, so bust the storefront list
  // cache to reflect it now instead of ≤30s later. (No detail bust: this slug
  // was never cached — the store detail route doesn't cache 404s — so there is
  // nothing to evict there.)
  clearPackListCache();
  res.status(201).json({ pack: result });
}
