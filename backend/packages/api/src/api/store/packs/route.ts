import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import PacksModuleService from '../../../modules/packs/service';
import { PACKS_MODULE } from '../../../modules/packs';
import { FREE_WELCOME_CATEGORY } from '../../../modules/packs/free-pack';
import { withLossless } from '../../../modules/packs/lossless';
import { losslessWindowsForDisplay } from './lossless-display';
import { catalogRows } from './pack-bodies';

// GET /store/packs — the gacha pack catalog for /claw and the home "Open Packs"
// tiles. A plain Medusa store route (publishable-key scoped, but NOT subject to
// Mercur's seller-visibility product middleware), so the house-seller machinery
// the marketplace needs does not apply here. Returns active packs ordered by
// (category, rank); the storefront groups them and attaches presentational
// category labels/icons from local assets.
// ponytail: per-process 30s cache — mirrors packCache in [slug]/route.ts and the
// leaderboard's boardCache. /store/packs is a fixed public query (no params),
// identical for every viewer, fetched on every anonymous (force-dynamic) home
// view via getPackCategories; this collapses the multi-row catalog query to one
// compute per 30s window. A pack going active/inactive or a price/stock edit
// lags ≤30s — display-only (the purchase path re-checks live state).
// >1 instance since #473: per-process is accepted — N instances = N
// computes per window and ≤TTL cross-instance skew, display-only either
// way. Decision + upgrade path recorded in plan 116.
const CACHE_TTL_MS = 30_000;
const LIST_KEY = 'list';
type CatalogBody = Awaited<ReturnType<typeof computeCatalogBody>>;
const listCache = new Map<string, { expires: number; body: CatalogBody }>();

/** Single-flight guard: concurrent misses during an expiry window share ONE
 *  compute — the catalog query plus the composition aggregate below, which a
 *  miss stampede would otherwise run N times for identical bodies. */
let inFlight: Promise<CatalogBody> | null = null;

/** Test seam: module state outlives a test's fixtures — one jest process is one
 *  module instance, so a prior test's catalog would be served to the next. */
export function clearPackListCache(): void {
  listCache.clear();
  inFlight = null;
}

export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const cached = listCache.get(LIST_KEY);
  if (cached && cached.expires > Date.now()) {
    res.json(await withLosslessBadges(req, cached.body));
    return;
  }

  if (!inFlight) {
    inFlight = computeCatalogBody(req)
      .then((body) => {
        listCache.set(LIST_KEY, { expires: Date.now() + CACHE_TTL_MS, body });
        return body;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  // A rejected compute rejects every waiter identically — same outcome as
  // each having run it, minus the duplicate work.
  res.json(await withLosslessBadges(req, await inFlight));
}

// The cache holds the plain catalog; Lossless Mode is laid over a copy on every
// request at Date.now() (windows via the 10s display memo), so no cached body
// can carry a stale 100 and a window's start/end flips on time.
async function withLosslessBadges(req: MedusaRequest, body: CatalogBody) {
  const windows = await losslessWindowsForDisplay(req);
  const now = Date.now();
  return {
    ...body,
    packs: body.packs.map((p) => withLossless(p, windows, now)),
  };
}

async function computeCatalogBody(req: MedusaRequest) {
  const packsModuleService: PacksModuleService =
    req.scope.resolve(PACKS_MODULE);

  const packs = await packsModuleService.listPacks(
    // reward_box packs are internal draw pools (B2) and the free welcome pack is
    // reached only via its own claim badge — both excluded from the public catalog.
    {
      status: 'active',
      category: { $nin: ['reward_box', FREE_WELCOME_CATEGORY] },
    } as Parameters<typeof packsModuleService.listPacks>[0],
    // Explicit take so a framework default can't silently cap the catalog.
    { order: { category: 'ASC', rank: 'ASC' }, take: 500 },
  );

  const body = { packs: await catalogRows(packsModuleService, packs) };
  return body;
}
