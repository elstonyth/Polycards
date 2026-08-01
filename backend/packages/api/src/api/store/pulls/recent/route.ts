import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { Modules } from '@medusajs/framework/utils';
import PacksModuleService from '../../../../modules/packs/service';
import { PACKS_MODULE } from '../../../../modules/packs';
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

// GET /store/pulls/recent — the most recent pulls across all packs, for the
// "Recent Pulls" live feed. A plain publishable-key-scoped store route (no
// customer auth). PUBLIC-feed PII policy (operator decision 2026-08-01,
// reversing the 2026-07-04 masking): each row carries the puller's FULL
// display name (first_name only — the same field the leaderboard already
// shows in full; never email, never customer_id), the won card, the source
// pack's title/image, and when it was rolled. Each pull is joined to its Card
// by handle; orphaned rows (card removed) are dropped.
const RECENT_LIMIT = 12;

// ponytail: per-process 5s cache — mirrors the leaderboard's boardCache. This
// feed is polled every 4s per open tab (use-recent-pulls); a 5s TTL collapses
// ~6 queries/poll to one compute per 5s window PER PROCESS, regardless of how
// many tabs poll. The feed has no per-request inputs, so a single key suffices.
// A new pull surfaces ≤5s later than before — invisible on a "recent" feed.
const CACHE_TTL_MS = 5_000;
const RECENT_KEY = 'recent';
const recentCache = new Map<string, { expires: number; body: unknown }>();

/** Test seam: module state outlives a test's fixtures — one jest process is one
 *  module instance, so a prior test's feed would be served to the next. */
export function clearRecentPullsCache(): void {
  recentCache.clear();
}

// Full display name; blank/missing first_name → "Anonymous".
const displayName = (name: string | null | undefined): string => {
  const n = (name ?? '').trim();
  return n || 'Anonymous';
};

export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const cached = recentCache.get(RECENT_KEY);
  if (cached && cached.expires > Date.now()) {
    res.json(cached.body);
    return;
  }

  const packs: PacksModuleService = req.scope.resolve(PACKS_MODULE);
  const fxRate = await resolveFxRate(packs);

  const pulls = await packs.listPulls(
    // ponytail: $ne filter mirrors the leaderboard SQL exclusion — reward prizes
    // are private vault items, not public feed entries.
    { source: { $ne: 'reward' } } as Parameters<typeof packs.listPulls>[0],
    { order: { rolled_at: 'DESC' }, take: RECENT_LIMIT },
  );

  const handles = [...new Set(pulls.map((p) => p.card_id))];
  const cards = handles.length
    ? await packs.listCards({ handle: handles }, { take: handles.length })
    : [];
  const byHandle = cardByHandle(cards);

  // Rarity is PER-PACK (PackOdds) — join each pull to its (pack, card) odds row.
  // Pulls whose odds row was since removed fall back to Common rather than
  // vanishing from the feed (the storefront drops unknown-rarity rows).
  const oddsRows = handles.length
    ? await packs.listPackOdds({ card_id: handles }, { take: 1000 })
    : [];
  // Reward rows (card_id null) carry no card rarity — exclude before the lookup.
  const cardOdds = oddsRows.filter(
    (o): o is typeof o & { card_id: string } => o.card_id != null,
  );
  const rarityOf = makeRarityOf(cardOdds);

  // Pack labels — resolve title/image from the live catalog (backend is the
  // source of truth; a deleted pack degrades to nulls, not a wrong label).
  const packIds = [...new Set(pulls.map((p) => p.pack_id))];
  const packRows = packIds.length
    ? await packs.listPacks({ slug: packIds }, { take: packIds.length })
    : [];
  const packBySlug = new Map(packRows.map((p) => [p.slug, p]));

  // Puller display names — first_name ONLY (leaderboard's PII rule), shown in
  // full. Missing customer/first_name reads as "Anonymous".
  // ponytail: resolve() is wrapped nullsafe — if the customer module can't be
  // resolved (or resolves to something without listCustomers, e.g. a test
  // harness that only registers this module) the feed degrades to masking
  // every puller as "Anonymous" rather than 500ing.
  const customerIds = [
    ...new Set(pulls.map((p) => p.customer_id).filter((id): id is string => !!id)),
  ];
  let customers: { id: string; first_name: string | null }[] = [];
  if (customerIds.length) {
    try {
      const customerService = req.scope.resolve(Modules.CUSTOMER);
      customers = await customerService.listCustomers(
        { id: customerIds },
        { take: customerIds.length },
      );
    } catch {
      customers = [];
    }
  }
  const firstNameById = new Map(customers.map((c) => [c.id, c.first_name]));

  const recent = pulls
    .map((p) => {
      const card = byHandle.get(p.card_id);
      if (!card) return null;
      const pack = packBySlug.get(p.pack_id);
      return {
        handle: card.handle,
        name: card.name,
        rarity: rarityOf(p.pack_id, p.card_id),
        // market_value is a BigNumber — normalize to a JSON number (USD decimal).
        market_value: toMoney(card.market_value),
        marketPriceMyr: displayMarketPrice(
          toMoney(card.market_value),
          fxRate,
          Number(card.market_multiplier ?? DEFAULT_MARKET_MULTIPLIER),
        ),
        image: card.image,
        slab_image: card.slab_image ?? null,
        // pack the card came from (= Pack.slug) + live catalog label fields.
        pack_id: p.pack_id,
        pack_title: pack?.title ?? null,
        pack_image: pack?.image ?? null,
        // Full display name — never customer_id/email (see header).
        who: displayName(p.customer_id ? firstNameById.get(p.customer_id) : null),
        rolled_at: p.rolled_at,
      };
    })
    .filter((e): e is NonNullable<typeof e> => e !== null);

  const body = { pulls: recent };
  recentCache.set(RECENT_KEY, { expires: Date.now() + CACHE_TTL_MS, body });
  res.json(body);
}
