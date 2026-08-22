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
// by handle; orphaned rows (card removed) are dropped. `?pack_id=<Pack.slug>`
// scopes the feed to a single pack — the pack pages show that pack's own
// history, not the global one.
const RECENT_LIMIT = 12;
// Over-fetch, because the disabled filter below runs AFTER the query — same
// reason (and same 2x bound) as the leaderboard's FETCH_N: a disabled puller
// among the latest 12 must not shorten the feed to 11. A window where more than
// half the pulls are disabled players renders short, which is the honest outcome.
const FETCH_LIMIT = RECENT_LIMIT * 2;

// ponytail: per-process 5s cache — mirrors the leaderboard's boardCache. This
// feed is polled every 4s per open tab (use-recent-pulls); a 5s TTL collapses
// ~6 queries/poll to one compute per 5s window PER PROCESS, regardless of how
// many tabs poll. Keyed by the ?pack_id filter (absent = the global feed) —
// a single key would serve one pack's rows to every other pack for the window.
// A new pull surfaces ≤5s later than before — invisible on a "recent" feed.
const CACHE_TTL_MS = 5_000;
const ALL_PACKS_KEY = 'recent';
// ponytail: hard bound on the map's key count — see the eviction check at
// the cache-set site below.
const MAX_ENTRIES = 256;
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
  // ?pack_id=<Pack.slug> scopes the feed to one pack (the /slots/[slug] pages);
  // absent = the global feed (home). An unknown slug yields an empty feed.
  const packId =
    typeof req.query.pack_id === 'string' && req.query.pack_id.trim()
      ? req.query.pack_id.trim()
      : null;
  const cacheKey = packId ?? ALL_PACKS_KEY;

  const cached = recentCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    res.json(cached.body);
    return;
  }

  const packs: PacksModuleService = req.scope.resolve(PACKS_MODULE);
  const fxRate = await resolveFxRate(packs);

  const fetched = await packs.listPulls(
    // ponytail: $nin filter mirrors the leaderboard SQL exclusion — reward
    // prizes are private vault items, and free welcome pulls are a signup gift
    // rather than a played pack; neither is a public feed entry.
    {
      source: { $nin: ['reward', 'free'] },
      // Pull.pack_id IS Pack.slug (see the model), so the query param is the slug.
      ...(packId ? { pack_id: packId } : {}),
    } as Parameters<typeof packs.listPulls>[0],
    { order: { rolled_at: 'DESC' }, take: FETCH_LIMIT },
  );

  // An administratively disabled player is hidden from every public surface —
  // the same rule (and the same helper) the leaderboard applies, so a disable
  // taken in the dashboard removes the player here too. DROPPED, not renamed to
  // "Anonymous": that is what the boards chose, and an anonymised row would
  // still publish the pull. The filter runs BEFORE the response is cached, so a
  // disable can never be served for the rest of a cache window. Pulls with no
  // customer_id are kept — there is nobody to hide.
  const pullerIds = [
    ...new Set(
      fetched.map((p) => p.customer_id).filter((id): id is string => !!id),
    ),
  ];
  const disabled = await packs.disabledCustomerIds(pullerIds);
  const pulls = fetched
    .filter((p) => !p.customer_id || !disabled.has(p.customer_id))
    .slice(0, RECENT_LIMIT);

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
  // ponytail: pack_id is caller-supplied, so the key space is unbounded (the
  // storefront proxy forwards any ?pack=) — cap the map instead of letting
  // unknown slugs accrete entries. Map iterates in insertion order, so this
  // evicts oldest-inserted first — not LRU, but the real catalog is ~10 packs
  // + the global key, so anything evicted under pressure is a garbage key or
  // long-expired (a full clear() would instead thunder-herd every hot key on
  // the same request that trips the bound). Not "don't cache empties": a
  // legitimately quiet pack returns [] too, and that is the case the TTL
  // exists to protect.
  if (recentCache.size > MAX_ENTRIES) {
    recentCache.delete(recentCache.keys().next().value as string);
  }
  recentCache.set(cacheKey, { expires: Date.now() + CACHE_TTL_MS, body });
  res.json(body);
}
