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
import {
  DEFAULT_MARKET_MULTIPLIER,
  displayMarketPrice,
  resolveFxRate,
} from '../../../../modules/packs/pricing';

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

const RARITIES = ['Immortal', 'Legendary', 'Mythical', 'Rare', 'Uncommon', 'Common'] as const;
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
  // C1: exclude reward Pulls from the public profile (leaderboard, collection,
  // recent feed) — they are private vault items only visible in /store/vault.
  // Filter IN the query (source='pack', the positive of source!='reward', which
  // every non-reward row carries: the column is NOT NULL DEFAULT 'pack'). A
  // post-`.filter()` would run AFTER the MAX_PULLS cap, so a collector with many
  // recent reward pulls would lose older real pulls to the truncation.
  const pulls = await packs.listPulls(
    { customer_id: customer.id, source: 'pack' },
    { take: MAX_PULLS, order: { rolled_at: 'DESC' } },
  );

  // Lookup tables, leaderboard-style: card display/value by handle, pack
  // price by slug, per-pack rarity by (pack, card) odds row.
  const cardIds = [...new Set(pulls.map((p) => p.card_id))];
  const packIds = [...new Set(pulls.map((p) => p.pack_id))];
  const cards = cardIds.length
    ? await packs.listCards({ handle: cardIds }, { take: cardIds.length })
    : [];
  const odds =
    cardIds.length && packIds.length
      ? await packs.listPackOdds(
          { pack_id: packIds, card_id: cardIds },
          { take: packIds.length * cardIds.length },
        )
      : [];

  const byHandle = cardByHandle(cards);
  // Reward rows (card_id null) carry no card rarity — exclude before the lookup.
  const cardOdds = odds.filter(
    (o): o is typeof o & { card_id: string } => o.card_id != null,
  );
  const rarityOf = makeRarityOf(cardOdds) as (p: string, c: string) => Rarity;

  // Stats — same definitions as the leaderboard: points = real pack_open
  // spend from the credit ledger × 100 (spend is RM, so the ledger's sen ARE
  // the points — exact match with the board). volume = Σ won-card MYR display
  // value (FMV × multiplier × FX); it can drift from the board by cents
  // (per-card rounding here vs one sum-level round there) and is computed
  // over the MAX_PULLS-capped list (pre-existing cap).
  const fxRate = await resolveFxRate(packs);
  const cardMyr = (card: (typeof cards)[number]): number =>
    displayMarketPrice(
      toMoney(card.market_value),
      fxRate,
      Number(card.market_multiplier ?? DEFAULT_MARKET_MULTIPLIER),
    );
  let volume = 0;
  const points = await packs.packOpenSpendCents(customer.id);
  const byRarity = Object.fromEntries(RARITIES.map((r) => [r, 0])) as Record<
    Rarity,
    number
  >;
  for (const p of pulls) {
    const card = byHandle.get(p.card_id);
    volume += card ? cardMyr(card) : 0;
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
            marketPriceMyr: cardMyr(card),
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
        p.status === 'vaulted',
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
          marketPriceMyr: cardMyr(card),
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
