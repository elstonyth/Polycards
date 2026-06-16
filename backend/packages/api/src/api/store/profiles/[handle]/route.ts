import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { MedusaError, Modules } from '@medusajs/framework/utils';
import PacksModuleService from '../../../../modules/packs/service';
import { PACKS_MODULE } from '../../../../modules/packs';
import { HANDLE_RE, seedOf } from '../../../../utils/profile-handle';
import { findCustomerByHandle } from '../../../../utils/customer-by-handle';
import {
  cardByHandle,
  makeRarityOf,
} from '../../../../modules/packs/card-view';
import { toMoney } from '../../../../modules/packs/money';

// GET /store/profiles/:handle — PUBLIC profile page data (Task B). A plain
// publishable-key store route (read-only, no workflow), same posture as
// /store/leaderboard.
//
// 🔒 PII: PUBLIC, so the payload is a strict whitelist — display name
// (first_name, else "Collector ####"), avatar seed, join date, pull stats,
// and recent pulls' card display fields. NEVER email, customer id, addresses,
// credit balance, or vault/buyback state.
const RECENT_N = 12;
const MAX_PULLS = 20_000; // same aggregation cap as the leaderboard

const RARITIES = ['Legendary', 'Epic', 'Rare', 'Uncommon', 'Common'] as const;
type Rarity = (typeof RARITIES)[number];

export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const handle = req.params.handle;
  // Malformed params resolve like unknown ones — a 404, never a 500 (and the
  // regex gate keeps junk out of the JSONB lookup).
  if (typeof handle !== 'string' || !HANDLE_RE.test(handle)) {
    throw new MedusaError(MedusaError.Types.NOT_FOUND, 'Profile not found');
  }

  const customers = req.scope.resolve(Modules.CUSTOMER);
  const customer = await findCustomerByHandle(customers, handle);
  if (!customer) {
    throw new MedusaError(MedusaError.Types.NOT_FOUND, 'Profile not found');
  }

  const packs: PacksModuleService = req.scope.resolve(PACKS_MODULE);
  const pulls = await packs.listPulls(
    { customer_id: customer.id },
    { take: MAX_PULLS, order: { rolled_at: 'DESC' } },
  );

  // Lookup tables, leaderboard-style: card display/value by handle, pack
  // price by slug, per-pack rarity by (pack, card) odds row.
  const cardIds = [...new Set(pulls.map((p) => p.card_id))];
  const packIds = [...new Set(pulls.map((p) => p.pack_id))];
  const cards = cardIds.length
    ? await packs.listCards({ handle: cardIds }, { take: cardIds.length })
    : [];
  const packRows = packIds.length
    ? await packs.listPacks({ slug: packIds }, { take: packIds.length })
    : [];
  const odds =
    cardIds.length && packIds.length
      ? await packs.listPackOdds(
          { pack_id: packIds, card_id: cardIds },
          { take: packIds.length * cardIds.length },
        )
      : [];

  const byHandle = cardByHandle(cards);
  const priceBySlug = new Map(packRows.map((p) => [p.slug, p.price]));
  const rarityOf = makeRarityOf(odds) as (p: string, c: string) => Rarity;

  // Stats over the full pull history (same formulas as the leaderboard:
  // volume = Σ won-card FMV, points = Σ pack price × 100).
  let volume = 0;
  let points = 0;
  const byRarity = Object.fromEntries(RARITIES.map((r) => [r, 0])) as Record<
    Rarity,
    number
  >;
  for (const p of pulls) {
    const card = byHandle.get(p.card_id);
    volume += card ? toMoney(card.market_value) : 0;
    points += (priceBySlug.get(p.pack_id) ?? 0) * 100;
    byRarity[rarityOf(p.pack_id, p.card_id)] += 1;
  }

  // Recent pulls: newest first, card display fields only (no vault status,
  // no buyback fields). Pulls whose card metadata is gone are skipped.
  // Filter BEFORE slicing so pulls of since-deleted cards can't under-fill
  // the feed.
  const recent = pulls
    .flatMap((p) => {
      const card = byHandle.get(p.card_id);
      if (!card) return [];
      return [
        {
          pack_id: p.pack_id,
          rarity: rarityOf(p.pack_id, p.card_id),
          rolled_at: p.rolled_at,
          card: {
            handle: card.handle,
            name: card.name,
            set: card.set,
            grader: card.grader,
            grade: card.grade,
            market_value: toMoney(card.market_value),
            image: card.image,
          },
        },
      ];
    })
    .slice(0, RECENT_N);

  // Collection: only pulls the customer has opted to showcase (showcased=true,
  // still vaulted). Computed from the already-loaded pull set — no extra query.
  // The activity feed (recent) stays ungated as decided at spec time.
  const collection = pulls
    .filter(
      (p) =>
        (p as unknown as { showcased: boolean }).showcased &&
        p.status === "vaulted",
    )
    .flatMap((p) => {
      const card = byHandle.get(p.card_id);
      if (!card) return [];
      return [
        {
          handle: card.handle,
          name: card.name,
          set: card.set,
          grader: card.grader,
          grade: card.grade,
          market_value: toMoney(card.market_value),
          image: card.image,
        },
      ];
    });

  const seed = seedOf(customer.id);
  const first = (customer.first_name || '').trim();

  res.json({
    handle,
    name: first.length > 0 ? first : `Collector ${String(seed).slice(0, 4)}`,
    seed,
    joined_at: customer.created_at,
    stats: {
      pulls: pulls.length,
      volume: Math.round(volume * 100) / 100,
      points: Math.round(points),
      by_rarity: byRarity,
    },
    collection,
    recent,
  });
}
