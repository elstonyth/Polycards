import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { MedusaError, Modules } from '@medusajs/framework/utils';
import PacksModuleService from '../../../../modules/packs/service';
import { PACKS_MODULE } from '../../../../modules/packs';
import { HANDLE_RE, seedOf } from '../../../../utils/profile-handle';
import {
  getCachedProfile,
  setCachedProfile,
} from '../../../../utils/profile-cache';
import { findCustomerByHandle } from '../../../../utils/customer-by-handle';
import {
  cardByHandle,
  makeRarityOf,
} from '../../../../modules/packs/card-view';
import { RARITY_ORDER, type Rarity } from '../../../../modules/packs/rarity';
import {
  CHALLENGE_PACK_LIKE,
  isChallengePrizePack,
} from '../../../../modules/packs/challenge-prize';
import { bestLiveTierByHandle } from '../../../../modules/packs/card-tier';
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
// Recent-feed page size: a small multiple of RECENT_N so pulls of
// since-deleted cards (skipped below) rarely under-fill the feed in one page;
// a bounded loop (max 3 pages) covers the pathological case.
const RECENT_PAGE = RECENT_N * 3;
// Showcase ceiling — the same 20k aggregation cap the old in-route derivation
// inherited from MAX_PULLS. The query is showcased-filtered (explicit opt-in
// rows only), so this is a semantic ceiling, not a working-set size.
const SHOWCASE_MAX = 20_000;

type PullRow = Awaited<ReturnType<PacksModuleService['listPulls']>>[number];
type CardRow = Awaited<ReturnType<PacksModuleService['listCards']>>[number];

// The per-process 30s body cache now lives in utils/profile-cache so the
// showcase toggle can evict this customer's entry (a star that stays invisible
// for 30s reads as broken). Re-exported: the http suite clears it by importing
// from this route.
export { clearProfileCache } from '../../../../utils/profile-cache';

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

  // Only successful bodies are ever stored (404 paths throw before the set
  // below), so a cache hit is always a real profile.
  const cached = getCachedProfile(handle);
  if (cached !== undefined) {
    res.json(cached);
    return;
  }

  const customers = req.scope.resolve(Modules.CUSTOMER);
  const customer = await findCustomerByHandle(customers, handle);
  if (!customer) {
    throw new MedusaError(MedusaError.Types.NOT_FOUND, 'Profile not found');
  }

  const packs: PacksModuleService = req.scope.resolve(PACKS_MODULE);

  // An administratively disabled player is hidden from every public surface,
  // this page included. Checked here rather than above the cache read: a hit
  // can still serve a body built before the disable, for at most the 30s TTL —
  // the same window the boards' own caches carry, and not worth two extra
  // queries on every cache hit to close.
  //
  // 410, NOT 404, and this is load-bearing: the storefront answers a 404 with a
  // deterministic MOCK persona (unknown/legacy handles are a product choice —
  // app/profile/[user]/page.tsx), so 404-ing here would publish a fabricated
  // collector under this real handle instead of hiding anything. The status is
  // written directly because MedusaError has no 410 mapping.
  if (await packs.isAccountDisabled(customer.id)) {
    res.status(410).json({ message: 'Profile unavailable' });
    return;
  }

  // Stats — same definitions as the leaderboard: volume = Σ won-card MYR
  // display value (FMV × multiplier × FX); it can drift from the board by
  // cents (per-card rounding here vs one sum-level round there) and is
  // computed over the newest-20k-capped pull set (pre-existing MAX_PULLS cap
  // — the cap and the C1 source='pack' filter now live inside the SQL
  // aggregate, see PacksModuleService.profileStatsForCustomer).
  const stats = await packs.profileStatsForCustomer(customer.id);
  const byRarity = Object.fromEntries(
    RARITY_ORDER.map((r) => [r, 0]),
  ) as Record<Rarity, number>;
  for (const [rarity, n] of Object.entries(stats.by_rarity)) {
    // pack_odds.rarity is enum-constrained to RARITIES (NULL → 'Common' in
    // the SQL), so every key lands on an initialized bucket.
    byRarity[rarity as Rarity] = (byRarity[rarity as Rarity] ?? 0) + n;
  }

  const fxRate = await resolveFxRate(packs);
  const cardMyr = (card: CardRow): number =>
    displayMarketPrice(
      toMoney(card.market_value),
      fxRate,
      Number(card.market_multiplier ?? DEFAULT_MARKET_MULTIPLIER),
    );

  // Recent pulls: newest first, card display fields only (no vault status,
  // no buyback fields). Pulls whose card metadata is gone are skipped.
  // Filter BEFORE slicing so pulls of since-deleted cards can't under-fill
  // the feed. C1: source='pack' IN the query — reward pulls are private
  // vault items (see /store/vault) and must not consume feed slots.
  // Paged (RECENT_PAGE per page, max 3 pages) instead of the old 20k fetch.
  const recentKept: Array<{ pull: PullRow; card: CardRow }> = [];
  for (let page = 0; page < 3 && recentKept.length < RECENT_N; page++) {
    const rows = await packs.listPulls(
      { customer_id: customer.id, source: 'pack' },
      {
        take: RECENT_PAGE,
        skip: page * RECENT_PAGE,
        order: { rolled_at: 'DESC' },
      },
    );
    if (rows.length === 0) break;
    const handles = [...new Set(rows.map((p) => p.card_id))];
    const cards = await packs.listCards(
      { handle: handles },
      { take: handles.length },
    );
    const byHandle = cardByHandle(cards);
    for (const p of rows) {
      const card = byHandle.get(p.card_id);
      if (card) recentKept.push({ pull: p, card });
    }
    if (rows.length < RECENT_PAGE) break; // short page = no more pulls
  }
  const recentTop = recentKept.slice(0, RECENT_N);

  // Collection: only pulls the customer has opted to showcase (showcased=true,
  // still vaulted). Now its own filtered, bounded query (opt-in rows only)
  // instead of a JS filter over the 20k list. The activity feed (recent)
  // stays ungated as decided at spec time.
  // Weekly-challenge prizes are showcase-able like pulled cards (operator
  // decision) — they are real cards the customer won, not the private
  // reward-box prizes the source filter exists to keep off the profile. The
  // ACTIVITY feed above stays pack-only: a prize is not a pack open, and C1
  // reserves those slots for opens.
  //
  // The LIKE is a coarse pre-filter — it also accepts an admin-authored slug
  // like `challenge-cup-2026`, which is NOT a prize pack. `isChallengePrizePack`
  // is the strict rule (the minted date shape), so a reward pull against such a
  // slug is dropped below rather than being published on a public profile.
  const showcaseCandidates = await packs.listPulls(
    {
      customer_id: customer.id,
      $or: [{ source: 'pack' }, { pack_id: { $like: CHALLENGE_PACK_LIKE } }],
      showcased: true,
      status: 'vaulted',
    } as Parameters<typeof packs.listPulls>[0],
    { take: SHOWCASE_MAX, order: { rolled_at: 'DESC' } },
  );
  const showcasePulls = showcaseCandidates.filter(
    (p) => p.source === 'pack' || isChallengePrizePack(p.pack_id),
  );

  // Per-pack rarity for BOTH the recent rows and the showcased ones (the
  // storefront draws the tier frame around showcased slabs too): rarity
  // belongs to the (pack, card) odds row, not the card.
  //
  // One query PER PACK with only that pack's card ids. A single
  // {pack_id: [...], card_id: [...]} filter is a cross-product — it also
  // matches pairs this customer never pulled, so with a large showcase it can
  // exceed any `take` and get truncated. A truncated fetch is worse than a
  // slow one: makeRarityOf falls back to 'Common' on a miss, which would paint
  // a Legendary slab with a grey Common frame.
  const rarityPulls = [...recentTop.map((k) => k.pull), ...showcasePulls];
  const cardsByPack = new Map<string, Set<string>>();
  for (const p of rarityPulls) {
    // Reward rows (card_id null) carry no card rarity.
    if (!p.card_id) continue;
    const cards = cardsByPack.get(p.pack_id) ?? new Set<string>();
    cards.add(p.card_id);
    cardsByPack.set(p.pack_id, cards);
  }
  // Chunked fan-out: one query per distinct pack, at most ODDS_CONCURRENCY in
  // flight — a showcase spanning many packs must not burst the pg pool on a
  // cache-miss load (this repo has been pool-full-bitten before).
  const ODDS_CONCURRENCY = 5;
  const packEntries = [...cardsByPack];
  const oddsPerPack: Awaited<ReturnType<typeof packs.listPackOdds>>[] = [];
  for (let i = 0; i < packEntries.length; i += ODDS_CONCURRENCY) {
    oddsPerPack.push(
      ...(await Promise.all(
        packEntries.slice(i, i + ODDS_CONCURRENCY).map(([packId, cardIds]) =>
          packs.listPackOdds(
            { pack_id: packId, card_id: [...cardIds] },
            // NOT take: cardIds.size — nothing enforces (pack, card) uniqueness
            // on pack_odds, so an exact-size take would silently drop a row if
            // a duplicate ever existed. The filter is narrow; bound loosely.
            { take: 10_000 },
          ),
        ),
      )),
    );
  }
  const cardOdds = oddsPerPack
    .flat()
    .filter((o): o is typeof o & { card_id: string } => o.card_id != null);
  const rarityOf = makeRarityOf(cardOdds) as (p: string, c: string) => Rarity;
  // Collection items skip the frame on a genuine odds-row miss (an admin
  // removed/re-keyed the odds row after pulls existed): the storefront renders
  // no tier frame for null, whereas rarityOf's 'Common' fallback would paint a
  // WRONG-tier frame — worse than none. `recent` keeps the Common fallback
  // (pre-existing convention, pinned by the stats-parity spec).
  // A challenge prize's synthetic pack has no odds row at all, so the miss
  // above would blank its frame. Resolve those the way the card page and the
  // vault do — best tier among openable packs — from one batched lookup.
  const prizeTier = await bestLiveTierByHandle(
    packs,
    showcasePulls
      .filter((p) => isChallengePrizePack(p.pack_id))
      .map((p) => p.card_id)
      .filter((h): h is string => Boolean(h)),
  );
  const rarityOrNull = (packId: string, cardId: string): Rarity | null =>
    isChallengePrizePack(packId)
      ? (prizeTier.get(cardId) ?? null)
      : cardOdds.some((o) => o.pack_id === packId && o.card_id === cardId)
        ? rarityOf(packId, cardId)
        : null;

  const recent = recentTop.map(({ pull: p, card }) => ({
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
      slab_image: card.slab_image ?? null,
    },
  }));

  const showcaseHandles = [...new Set(showcasePulls.map((p) => p.card_id))];
  const showcaseCards = showcaseHandles.length
    ? await packs.listCards(
        { handle: showcaseHandles },
        { take: showcaseHandles.length },
      )
    : [];
  const showcaseByHandle = cardByHandle(showcaseCards);
  const collection = showcasePulls.flatMap((p) => {
    const card = showcaseByHandle.get(p.card_id);
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
        slab_image: card.slab_image ?? null,
        rarity: rarityOrNull(p.pack_id, p.card_id),
      },
    ];
  });

  const seed = seedOf(customer.id);
  const first = (customer.first_name || '').trim();
  const custMeta = (customer.metadata ?? {}) as Record<string, unknown>;
  const avatarUrl =
    typeof custMeta.avatar_url === 'string' ? custMeta.avatar_url : null;
  const equippedFrameLevel =
    typeof custMeta.equipped_frame_level === 'number'
      ? custMeta.equipped_frame_level
      : null;

  const body = {
    handle,
    name: first.length > 0 ? first : `Collector ${String(seed).slice(0, 4)}`,
    seed,
    avatar_url: avatarUrl,
    equipped_frame_level: equippedFrameLevel,
    joined_at: customer.created_at,
    stats: {
      pulls: stats.pulls,
      volume: Math.round(stats.volume * 100) / 100,
      by_rarity: byRarity,
    },
    collection,
    recent,
  };
  setCachedProfile(handle, body);
  res.json(body);
}
