import {
  getDraftPackDetail,
  getPackBaseForViewer,
  getPackDetail,
  getRecentPulls,
  type PackDetail,
  type RecentFeed,
} from '@/lib/data/packs';
import {
  canClaimFreePack,
  freePackMissing,
  getFreePackState,
} from '@/lib/data/free-pack';
import {
  FREE_WELCOME_CATEGORY,
  type FreePackRequirement,
  type Pack,
  type PackTab,
  type ResolvedPack,
} from '@/lib/packs-data';

/** Everything /slots/<pack> shows for one pack and one viewer. */
export interface PackPageData {
  pack: ResolvedPack;
  siblings: Pack[];
  /** The category switch's options; empty for an unlisted pack. */
  categoryTabs: PackTab[];
  /** Backend gacha pool (Top Hits + Pull Odds); null when the backend is down. */
  detail: PackDetail | null;
  recentPulls: RecentFeed;
  /** Free pack only: may this viewer still claim it? Absent on a paid pack. */
  freePackEligible?: boolean;
  /** Free pack only: what the account must still do before it can open. */
  freePackMissing: FreePackRequirement[];
}

/**
 * One pack page's data, for the page render and for the picker's in-place
 * switch (/api/pack-page/[slug]) alike, so the two can never show different
 * things. Each read degrades on its own (base → null, so the page 404s; detail
 * → empty gacha depth; pulls → empty).
 *
 * VIEWER-SPECIFIC: a member sees Drafts, and the free pack's eligibility is the
 * account's. Never put the result in a cache shared between visitors.
 */
export async function loadPackPage(slug: string): Promise<PackPageData | null> {
  const [base, publicDetail, recentPulls] = await Promise.all([
    getPackBaseForViewer(slug),
    getPackDetail(slug),
    // This pack's own history — the feed used to be global, so every pack
    // showed identical rows.
    getRecentPulls(slug),
  ]);
  if (!base) return null;
  const detail = base.pack.draft
    ? await getDraftPackDetail(slug)
    : publicDetail;

  // The free welcome pack is hidden from the catalog but NOT from this route, so
  // a shared link / history entry / stale badge lands an ineligible account on a
  // page that would otherwise promise a gift the backend then refuses at the
  // reel. One extra read, and only for that one pack.
  //
  // A rendered free pack is always the ACTIVE one (/store/packs/:slug 404s
  // inactive packs, so this page would not exist otherwise), which is why a
  // guest reliably lands on `signup` here rather than `hidden`. The state →
  // eligibility mapping, including that guest case, is unit-tested in
  // src/lib/data/__tests__/free-pack.test.ts.
  const freeState =
    base.pack.categoryId === FREE_WELCOME_CATEGORY
      ? await getFreePackState()
      : null;

  return {
    pack: base.pack,
    siblings: base.siblings,
    categoryTabs: base.tabs,
    detail,
    recentPulls,
    freePackEligible: freeState ? canClaimFreePack(freeState, slug) : undefined,
    // Spec 2026-10-06: the pack is theirs but waits on verification — the page
    // sends them to Settings instead of letting the reel refuse the open.
    freePackMissing: freeState ? freePackMissing(freeState, slug) : [],
  };
}
