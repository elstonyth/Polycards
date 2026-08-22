import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import PacksModuleService from '../../../modules/packs/service';
import { PACKS_MODULE } from '../../../modules/packs';
import { FREE_WELCOME_CATEGORY } from '../../../modules/packs/free-pack';
import { compositionGroup } from '../../../modules/packs/card-view';

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
const listCache = new Map<string, { expires: number; body: unknown }>();

/** Single-flight guard: concurrent misses during an expiry window share ONE
 *  compute — the catalog query plus the composition aggregate below, which a
 *  miss stampede would otherwise run N times for identical bodies. */
let inFlight: Promise<unknown> | null = null;

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
    res.json(cached.body);
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
  res.json(await inFlight);
}

async function computeCatalogBody(req: MedusaRequest): Promise<unknown> {
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

  // §2.4.8 composition — ONE grouped scan (packPoolComposition) rather than
  // paging every odds row and every card in to fold in Node; it applies the
  // same reward-row + orphan skip-set and the same isGraded/isPsa10 the admin
  // list's poolComposition does, so the two can never disagree.
  // `psa10` is the stricter guarantee gate: the storefront's "Guaranteed
  // PSA 10" section requires EVERY pooled card to be a PSA 10 — an all-graded
  // pack holding a PSA 9 or a BGS slab is GRADED but NOT psa10, so the
  // heading can never overclaim.
  const comp = await packsModuleService.packPoolComposition();
  const groupOf = (slug: string): 'GRADED' | 'RAW' | 'MIX' | null => {
    const t = comp.get(slug);
    return compositionGroup(t?.graded ?? 0, t?.total ?? 0);
  };
  const psa10Of = (slug: string): boolean => {
    const t = comp.get(slug);
    return t !== undefined && t.total > 0 && t.psa10 === t.total;
  };
  // Explicit public shape — `price` is bigNumber now, so a raw spread would
  // leak the internal `raw_price` jsonb sidecar (and id/timestamps) into a
  // public payload. `price` serializes as a JSON number (RM — all pack
  // prices and ledger money are Ringgit).
  const body = {
    packs: packs.map((p) => ({
      slug: p.slug,
      title: p.title,
      category: p.category,
      price: p.price,
      image: p.image,
      display_image: p.display_image ?? null,
      boost: p.boost,
      buyback_percent: p.buyback_percent,
      in_stock: p.in_stock,
      group: groupOf(p.slug),
      psa10: psa10Of(p.slug),
      rank: p.rank,
      status: p.status,
    })),
  };
  return body;
}
