import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { Modules } from '@medusajs/framework/utils';
import PacksModuleService from '../../../../modules/packs/service';
import { PACKS_MODULE } from '../../../../modules/packs';
import { RARITY_ORDER, type Rarity } from '../../../../modules/packs/rarity';
import { publicProfileFields, seedOf } from '../../../../utils/profile-handle';
import { normalizePublishedOdds } from '../../../../workflows/steps/create-pack';

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
// anonymised: no name, no face, no link.
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
  const [gaps, packRows, { avatar_frames: frames }] = await Promise.all([
    packs.pullGaps({ packId, rarity, limit: HITS_LIMIT }),
    packId ? packs.listPacks({ slug: packId }, { take: 1 }) : [],
    packs.siteSettings().catch(() => ({ avatar_frames: {} })),
  ]);
  const pct = packRows[0]
    ? (normalizePublishedOdds(packRows[0].published_odds)?.tiers[rarity] ??
      null)
    : null;
  const expected = pct != null && pct > 0 ? Math.round(100 / pct) : null;

  const customerIds = [
    ...new Set(
      gaps.hits.map((h) => h.customer_id).filter((id): id is string => !!id),
    ),
  ];
  const disabled = await packs.disabledCustomerIds(customerIds);
  let customers: {
    id: string;
    first_name: string | null;
    metadata?: Record<string, unknown> | null;
  }[] = [];
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
  const customerById = new Map(customers.map((c) => [c.id, c]));

  const hits = gaps.hits.map((h) => {
    const hidden = !!h.customer_id && disabled.has(h.customer_id);
    const customer =
      h.customer_id && !hidden ? customerById.get(h.customer_id) : undefined;
    const seed = seedOf(h.customer_id ?? h.id);
    const profile = publicProfileFields(customer, seed);
    const meta = (customer?.metadata ?? {}) as Record<string, unknown>;
    const frameLevel = meta['equipped_frame_level'];
    return {
      id: h.id,
      gap: h.gap,
      rolled_at: h.rolled_at,
      who: hidden ? 'Anonymous' : customer?.first_name?.trim() || 'Anonymous',
      seed: hidden ? null : seed,
      profile_handle: hidden ? null : profile.handle,
      avatar_url: hidden ? null : profile.avatarUrl,
      frame_url:
        !hidden && typeof frameLevel === 'number'
          ? (frames[String(frameLevel)] ?? null)
          : null,
    };
  });

  const body = {
    rarity,
    pct,
    expected,
    avg: gaps.avg,
    last20: gaps.last20,
    current: gaps.current,
    hits,
  };
  if (gapsCache.size > MAX_ENTRIES) {
    gapsCache.delete(gapsCache.keys().next().value as string);
  }
  gapsCache.set(cacheKey, { expires: Date.now() + CACHE_TTL_MS, body });
  res.json(body);
}
