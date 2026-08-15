import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { Modules } from "@medusajs/framework/utils";
import PacksModuleService from "../../../modules/packs/service";
import { PACKS_MODULE } from "../../../modules/packs";
import {
  resolveFxRate,
  displayMarketPrice,
} from "../../../modules/packs/pricing";
import { parsePaginationParams } from "../../../utils/pagination";

// GET /admin/pulls — the gacha Pull ledger for the operator, plus rollups.
// Admin-only (auto-protected /admin/* route), so unlike the PUBLIC recent-pulls
// feed this MAY join the customer email (legitimate operator visibility into who
// pulled what — the PII discipline applies only to customer-facing surfaces).
//
// Returns a paginated page of the ledger (card + customer email + pack title)
// and, over a wider window, the top cards and rarities by pull count. Rarity is
// PER-PACK (PackOdds), so each pull's tier comes from its (pack_id, card_id)
// odds row; pulls whose odds row no longer exists show rarity null.
//
// The rollups count PURCHASED pulls only (source='pack'), matching the public
// boards: reward-economy and free-welcome pulls are giveaways, and letting them
// inflate "top cards / top rarities" would misreport what players actually pull
// for money. The LEDGER half stays all-source (that is the operator's full
// audit trail) unless ?source= narrows it.
const ROLLUP_WINDOW = 5000;
// Pull.source enum — mirrors models/pull.ts and the sibling customer-pulls route.
const PULL_SOURCES = ["pack", "reward", "free"];

export async function GET(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const packs: PacksModuleService = req.scope.resolve(PACKS_MODULE);
  const customerService = req.scope.resolve(Modules.CUSTOMER);
  // FMV is stored USD; the pull ledger + top-cards show MYR at the live rate.
  const fx = await resolveFxRate(packs);

  const { limit, offset } = parsePaginationParams(
    { limit: req.query.limit, offset: req.query.offset },
    { defaultLimit: 50, maxLimit: 100 },
  );

  // Optional ?source= filter (pack | reward | free). The All Orders "Pack
  // purchases" tab passes source=pack so reward-economy and free-welcome pulls
  // never render as purchases; the Pull Ledger stays all-source. This filter is
  // the LEDGER's only — the rollups below are global stats, not a view of the
  // page, and carry their own fixed source='pack' scope.
  const rawSource = req.query.source;
  const source =
    typeof rawSource === "string" && rawSource.length ? rawSource : undefined;
  if (source !== undefined && !PULL_SOURCES.includes(source)) {
    res
      .status(400)
      .json({ message: `source must be one of ${PULL_SOURCES.join(", ")}` });
    return;
  }
  const ledgerFilter: Record<string, unknown> = source ? { source } : {};

  // Optional ?customer_id= — the per-player view. Stricter than ?source=:
  // absent means unscoped, but an empty/blank value 400s instead of silently
  // falling back to every customer's pulls. A repeated param arrives as an
  // array and 400s too.
  const rawCustomerId = req.query.customer_id;
  const customerId =
    typeof rawCustomerId === "string" ? rawCustomerId.trim() : undefined;
  if (rawCustomerId !== undefined && (!customerId || customerId.length > 64)) {
    res
      .status(400)
      .json({ message: "customer_id must be a string of 1-64 characters" });
    return;
  }
  if (customerId) ledgerFilter.customer_id = customerId;

  // Rollups are GLOBAL stats, so a scoped view gets NONE rather than site-wide
  // numbers that read as this one player's — skip the window fetch entirely and
  // let topCards/topRarities fall out empty. Ledger rows still resolve their own
  // card + per-pack rarity below (`handles` also spreads `ledger`).
  // source: 'pack' is a POSITIVE filter (the boards' rule), so a future
  // Pull.source value is excluded by default rather than silently counted.
  const allPulls = customerId
    ? []
    : await packs.listPulls(
        { source: "pack" },
        { order: { rolled_at: "DESC" }, take: ROLLUP_WINDOW }
      );
  // `id` tiebreaker: a batch open (open-batch) stamps every pull in the
  // batch with the same `rolled_at` millisecond, so without a unique
  // secondary sort key, offset pagination can show a row on two pages or on
  // neither. Same rule as inventory/[handle]/route.ts:82.
  const [ledger, total] = await packs.listAndCountPulls(
    ledgerFilter,
    { order: { rolled_at: "DESC", id: "DESC" }, skip: offset, take: limit }
  );

  const handles = [...new Set([...allPulls, ...ledger].map((p) => p.card_id))];
  const cards = handles.length
    ? await packs.listCards({ handle: handles }, { take: handles.length })
    : [];
  const cardByHandle = new Map(cards.map((c) => [c.handle, c]));

  // Per-pack rarity lookup for every (pack, card) pair seen in the window.
  const oddsRows = handles.length
    ? await packs.listPackOdds({ card_id: handles }, { take: 5000 })
    : [];
  const rarityByPair = new Map(
    oddsRows.map((o) => [`${o.pack_id} ${o.card_id}`, o.rarity])
  );
  const pullRarity = (p: { pack_id: string; card_id: string }): string | null =>
    rarityByPair.get(`${p.pack_id} ${p.card_id}`) ?? null;

  // Rollups over the full window. Top-card rarity is the tier the card was most
  // often pulled at (it can differ per pack).
  const cardCounts = new Map<string, number>();
  const rarityCounts = new Map<string, number>();
  const cardRarityCounts = new Map<string, Map<string, number>>();
  for (const p of allPulls) {
    cardCounts.set(p.card_id, (cardCounts.get(p.card_id) ?? 0) + 1);
    const rarity = pullRarity(p);
    if (rarity) {
      rarityCounts.set(rarity, (rarityCounts.get(rarity) ?? 0) + 1);
      const perCard = cardRarityCounts.get(p.card_id) ?? new Map<string, number>();
      perCard.set(rarity, (perCard.get(rarity) ?? 0) + 1);
      cardRarityCounts.set(p.card_id, perCard);
    }
  }

  const dominantRarity = (handle: string): string | null => {
    const perCard = cardRarityCounts.get(handle);
    if (!perCard || perCard.size === 0) return null;
    return [...perCard.entries()].sort((a, b) => b[1] - a[1])[0][0];
  };

  const topCards = [...cardCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([handle, count]) => {
      const card = cardByHandle.get(handle);
      return {
        handle,
        name: card?.name ?? handle,
        rarity: dominantRarity(handle),
        market_value: card
          ? displayMarketPrice(Number(card.market_value), fx, 1)
          : null,
        image: card?.image ?? null,
        count,
      };
    });

  const topRarities = [...rarityCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([rarity, count]) => ({ rarity, count }));

  // Ledger rows (current page) — join the customer email for these only.
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

  // Pull.pack_id is the pack SLUG (= Pack.slug), not the pack id — filter and
  // key the lookup by slug, like the sibling customer-pulls / recent-pulls routes.
  const packIds = [...new Set(ledger.map((p) => p.pack_id))];
  const packRows = packIds.length
    ? await packs.listPacks({ slug: packIds }, { take: packIds.length })
    : [];
  const packTitleBySlug = new Map(packRows.map((pk: any) => [pk.slug, pk.title]));

  const pulls = ledger.map((p) => {
    const card = cardByHandle.get(p.card_id);
    return {
      id: p.id,
      rolled_at: p.rolled_at,
      customer_id: p.customer_id,
      customer_email: p.customer_id ? emailById.get(p.customer_id) ?? null : null,
      pack_id: p.pack_id,
      pack_title: packTitleBySlug.get(p.pack_id) ?? null,
      // Vault lifecycle: vaulted (customer still holds it) vs bought_back
      // (instant sell-back — amount = the MYR (RM) actually credited).
      status: p.status,
      buyback_amount:
        p.buyback_amount === null ? null : Number(p.buyback_amount),
      card: card
        ? {
            handle: card.handle,
            name: card.name,
            rarity: pullRarity(p),
            market_value: displayMarketPrice(Number(card.market_value), fx, 1),
            image: card.image,
          }
        : null,
    };
  });

  res.json({ total, offset, limit, pulls, topCards, topRarities });
}
