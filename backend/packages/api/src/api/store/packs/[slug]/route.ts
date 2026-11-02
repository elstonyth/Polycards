import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import PacksModuleService from '../../../../modules/packs/service';
import { PACKS_MODULE } from '../../../../modules/packs';
import { withLossless } from '../../../../modules/packs/lossless';
import { losslessWindowsForDisplay } from '../lossless-display';
import { packDetailBody } from '../pack-bodies';

// GET /store/packs/:slug — one active pack plus its prize pool (each odds row
// joined to the referenced Card), behind /claw/[slug]'s Top Hits. A plain Medusa
// store route (publishable-key scoped, NOT subject to Mercur's seller-visibility
// product middleware), so no house-seller link is needed. 404 when the slug is
// unknown or inactive. The join is in-module by stable business keys (Pack.slug,
// Card.handle).
//
// 🔒 SECRET ODDS (Phase 6): the per-card `weight` is the real, admin-tuned win
// rate and is DELIBERATELY OMITTED from this public response — it must never
// reach the customer (visible in the network tab under the publishable key).
// Customers see a separate, static published-odds display. Only non-secret card
// display fields (incl. market_value, which drives Top Hits) are exposed here.

// ponytail: per-process 30s cache, keyed by slug — mirrors the leaderboard's
// boardCache. The home page fans out one getPackDetail per featured pack on
// every anonymous (force-dynamic) view; this collapses that ~4-query build to
// once per slug per 30s window. Only the 200 body is cached (404s fall through
// so a pack going active isn't hidden for ≤30s). The inverse also lags ≤30s: a
// pack going inactive/out-of-stock, or an admin edit to price/odds, keeps
// serving the stale 200 until the window rolls — display-only and acceptable
// (the purchase path re-checks live state; no explicit bust, matches boardCache).
// Prices are ≤30s stale, fine.
// >1 instance since #473: per-process is accepted — N instances = N
// computes per window and ≤TTL cross-instance skew, display-only either
// way. Decision + upgrade path recorded in plan 116.
const CACHE_TTL_MS = 30_000;
// Typed only as far as the Lossless overlay needs; the full body is stored.
type DetailBody = {
  pack: { slug: string; category: string; buyback_percent: unknown };
};
const packCache = new Map<string, { expires: number; body: DetailBody }>();

/** Test seam: module state outlives a test's fixtures — the http suite runs in
 *  one process, so test A's cached pack would be served to test B. */
export function clearPackDetailCache(): void {
  packCache.clear();
}

export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const packsModuleService: PacksModuleService =
    req.scope.resolve(PACKS_MODULE);
  const { slug } = req.params;

  // The cache holds the plain body; Lossless Mode is laid over a copy on every
  // request (see store/packs/route.ts), never cached.
  const send = async (body: DetailBody): Promise<void> => {
    const windows = await losslessWindowsForDisplay(req);
    res.json({ ...body, pack: withLossless(body.pack, windows, Date.now()) });
  };

  const cached = packCache.get(slug);
  if (cached && cached.expires > Date.now()) {
    await send(cached.body);
    return;
  }

  const [pack] = await packsModuleService.listPacks(
    { slug, status: 'active' },
    { take: 1 },
  );
  // reward_box packs are internal draw pools — excluded from the public catalog (B2).
  if (!pack || pack.category === 'reward_box') {
    res.status(404).json({ message: `Pack '${slug}' not found` });
    return;
  }

  const body = await packDetailBody(packsModuleService, pack);
  packCache.set(slug, { expires: Date.now() + CACHE_TTL_MS, body });
  await send(body);
}
