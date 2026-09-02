import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import PacksModuleService from '../../../../modules/packs/service';
import { PACKS_MODULE } from '../../../../modules/packs';
import { RARITY_ORDER, type Rarity } from '../../../../modules/packs/rarity';
import { normalizePublishedOdds } from '../../../../workflows/steps/create-pack';
import { ANONYMOUS_PULLER, loadPullerProfiles } from '../pullers';

// GET /store/pulls/gaps?rarity=<tier>[&pack_id=<Pack.slug>] — the pull-history
// STATS chart: for one tier, the gap (pulls since the previous hit) behind
// each recent hit of that tier, who hit it, and the header numbers:
//
//  pct       the pack's PUBLISHED odds for the tier (admin-set display rate,
//            never the secret weight); null on the global feed / unset odds
//  expected  1 / pct in draws — the "Avg: 91 draws" the chart's reference
//            line sits on; null when pct is
//  avg       the OBSERVED mean gap over every hit on record (the line's
//            fallback when there is no published rate)
//  last20    the observed mean over the newest 20 hits
//  current   pulls since the newest hit — the drought bar at the top
//
// Public, publishable-key scoped, same PII stance as /store/pulls/recent: a
// hit row carries the winner's first_name, handle, avatar and frame — the
// leaderboard's display set — never email/id. A DISABLED player's hit stays
// on the chart (removing it would corrupt every neighbouring gap) but is
// anonymised: no name, no face, no link. An unknown or DRAFT pack_id answers
// the empty chart before any ledger query (a draft pack's odds and ledger are
// not public until it is active).
const HITS_LIMIT = 20;
const CACHE_TTL_MS = 5_000;
const MAX_ENTRIES = 256;
const gapsCache = new Map<string, { expires: number; body: unknown }>();

/** Test seam — see clearRecentPullsCache. */
export function clearPullGapsCache(): void {
  gapsCache.clear();
}

export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const packId =
    typeof req.query.pack_id === 'string' && req.query.pack_id.trim()
      ? req.query.pack_id.trim()
      : null;
  // The chart always shows SOME tier — an unknown/absent value reads as the
  // apex tier rather than 400ing a public route.
  const rarity: Rarity =
    typeof req.query.rarity === 'string' &&
    (RARITY_ORDER as readonly string[]).includes(req.query.rarity)
      ? (req.query.rarity as Rarity)
      : RARITY_ORDER[0];
  const cacheKey = `${packId ?? ''}|${rarity}`;

  const cached = gapsCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    res.json(cached.body);
    return;
  }

  const packs: PacksModuleService = req.scope.resolve(PACKS_MODULE);

  // Gate the slug BEFORE the two full-ledger scans below — same reason as the
  // recent route: caller-supplied, public key, so garbage slugs must cost one
  // indexed pack lookup, not a window-function pass over every pull.
  const pack = packId
    ? (
        await packs.listPacks({ slug: packId, status: 'active' }, { take: 1 })
      )[0]
    : null;
  if (packId && !pack) {
    const empty = {
      rarity,
      pct: null,
      expected: null,
      avg: null,
      last20: null,
      current: 0,
      hits: [],
    };
    remember(cacheKey, empty);
    res.json(empty);
    return;
  }

  const gaps = await packs.pullGaps({ packId, rarity, limit: HITS_LIMIT });
  const pct = pack
    ? (normalizePublishedOdds(pack.published_odds)?.tiers[rarity] ?? null)
    : null;
  const expected = pct != null && pct > 0 ? Math.round(100 / pct) : null;

  const pullers = await loadPullerProfiles(
    req,
    packs,
    gaps.hits.map((h) => h.customer_id),
  );
  const hits = gaps.hits.map((h) => ({
    id: h.id,
    gap: h.gap,
    rolled_at: h.rolled_at,
    ...(h.customer_id && pullers.disabled.has(h.customer_id)
      ? ANONYMOUS_PULLER
      : pullers.profileOf(h.customer_id, h.id)),
  }));

  const body = {
    rarity,
    pct,
    expected,
    avg: gaps.avg,
    last20: gaps.last20,
    current: gaps.current,
    hits,
  };
  remember(cacheKey, body);
  res.json(body);
}

// ponytail: same bounded map as the recent route — see its `remember`.
function remember(key: string, body: unknown): void {
  if (gapsCache.size > MAX_ENTRIES) {
    gapsCache.delete(gapsCache.keys().next().value as string);
  }
  gapsCache.set(key, { expires: Date.now() + CACHE_TTL_MS, body });
}
