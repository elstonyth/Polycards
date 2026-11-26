'use client';

import { useEffect, useMemo } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import { ArrowLeft, Info } from 'lucide-react';
import { cn } from '@/lib/utils';
import { trackPixel } from '@/lib/pixel';
import CategoryIcon from '@/components/CategoryIcon';
import type { PackDetail, RecentFeed } from '@/lib/data/packs';
import {
  type Pack,
  type PackTab,
  type ResolvedPack,
  FLAT_BUYBACK_PERCENT,
  factoryVideo,
  packFacts,
  packHref,
  type FreePackRequirement,
} from '@/lib/packs-data';
import { AmbientVideo } from '@/components/AmbientVideo';
import { FIELD_LABEL, PackPicker } from './PackPicker';
import { packTiersOf } from '@/lib/pack-tiers';
import { usePackDetailPoll } from '@/lib/use-pack-detail-poll';
import { usePackBuy } from './use-pack-buy';
import { PackBuyControls } from './PackBuyControls';
import {
  PackCardOverlay,
  PackPullOdds,
  PackRecentPulls,
  PackTopHits,
  usePackCardOverlay,
} from './PackDetailSections';

export default function PackDetailClient({
  pack,
  siblings,
  categoryTabs = [],
  detail,
  recentPulls,
  initialQty = 1,
  freePackEligible = true,
  freePackMissing = [],
  onPick,
  onIntent,
  pendingPack = null,
  pendingCategory = null,
}: {
  pack: ResolvedPack;
  siblings: Pack[];
  /** The category dropdown's options. Under two (an unlisted pack, one franchise)
   *  the category is a plain label: nothing to switch to. */
  categoryTabs?: PackTab[];
  /** Backend gacha pool (Top Hits + Pull Odds); null when the backend is down. */
  detail: PackDetail | null;
  /** Live pull history for this pack; an empty feed when there are no pulls /
   *  backend down. */
  recentPulls: RecentFeed;
  /** Clamped 1–3 from the URL's `?count=` (the catalog stepper's choice). */
  initialQty?: number;
  /**
   * Free pack ONLY: may this visitor still claim it? The route is public (the
   * pack is merely uncataloged), so a shared link / history entry / stale badge
   * lands an ineligible account here — and the backend refuses the open at the
   * reel. Defaults true so every paid pack, for which page.tsx passes nothing,
   * renders exactly as before.
   *
   * Logged-out visitors are eligible=true on purpose: page.tsx maps the
   * `signup` badge state to true, so the offer that brought them here still
   * shows and `handleGoToReel` prompts login.
   */
  freePackEligible?: boolean;
  /**
   * Free pack ONLY (spec 2026-10-06): what the account must still do before
   * the backend lets it open — verify a phone, add a real name. Non-empty
   * turns the open into a prompt with a Settings link, instead of a trip to
   * the reel that ends in a refusal.
   */
  freePackMissing?: FreePackRequirement[];
  /**
   * Switch to another pack in place (PackPage): a plain click on a pack tile or
   * a category tab calls this instead of loading the pack's address as a new
   * page. Absent, a tile is an ordinary link and a tab an ordinary navigation.
   */
  onPick?: (id: string, href: string, categoryId?: string) => void;
  /** The pointer came to rest on a tile: its pack may be fetched early. */
  onIntent?: (id: string) => void;
  /** The pack (and, for a tab, the category) a switch is fetching. */
  pendingPack?: string | null;
  pendingCategory?: string | null;
}) {
  const router = useRouter();
  // The address owns selection so the address bar, shared links and browser
  // history always describe the pack being shown. PackPage switches packs in
  // place, so ONE instance of this component lives across packs: anything it
  // remembers about a pack has to be reset when `pack` changes (the buy model
  // and the card overlay each do).
  const active = pack;
  // Ads funnel (lib/pixel.ts): a pack page view. Keyed on the pack, not the
  // mount — switching to a sibling pack reuses this component.
  useEffect(() => {
    // A pack nobody can buy yet has no business in the ads funnel.
    if (active.draft) return;
    trackPixel('ViewContent', {
      content_ids: [active.id],
      content_name: active.name,
      content_type: 'product',
      value: active.priceMyr,
      currency: 'MYR',
    });
  }, [active.id, active.name, active.priceMyr, active.draft]);
  // One request refreshes every grid price (60s, visibility-gated), seeded
  // with this route's server snapshot.
  // A Draft keeps its seed: the poll reads the public route, which finds nothing
  // for a draft and would blank the page a minute after it loads.
  const polledDetail = usePackDetailPoll(active.id, detail);
  const liveDetail = active.draft ? detail : polledDetail;
  // Quantity (from the address), gifts, balance, sold out, the free pack's
  // prompt and the trip to the reel: one model for the panel and the dock.
  const buy = usePackBuy(active, liveDetail, {
    initialQty,
    freePackEligible,
    freePackMissing,
  });
  const { qty, isFreePack, ticketPack, noun, freeClaimUnavailable } = buy;
  // The card open over the page (Top Hits and Recent Pulls both open it).
  const overlay = usePackCardOverlay(active.id);
  // The per-tier view the odds board reads: the same projection the homepage
  // flow fetches from /api/pack-tiers, computed here from the live detail.
  const tiers = useMemo(
    () => packTiersOf(active, liveDetail),
    [active, liveDetail],
  );
  // Baked Polycards tiers animate their factory stage (still poster otherwise).
  const heroVideo = factoryVideo(active.displayImage);

  // A franchise's page is a pack of it, so the switch lands on its first one.
  // The franchise already on the page is not a move: its tab would otherwise
  // swap the pack being read for the franchise's first.
  const switchCategory = (id: string) => {
    if (id === pack.categoryId) return;
    const first = categoryTabs.find((t) => t.id === id)?.firstPackId;
    if (!first) return;
    if (onPick) onPick(first, packHref(first, qty), id);
    else router.push(packHref(first, qty), { scroll: false });
  };

  // What the header states about this pack: franchise, type, language, grading.
  const facts = packFacts(pack);

  return (
    // The phone's buy bar floats over the tab dock; the site footer under this
    // page ends above it (globals.css, data-buy-bar).
    // The look is the catalog's "soft" direction (DESIGN.md, Soft pack page):
    // the stage, the configurator, the top hit, the odds and the pull ledger
    // sit in double-bezel trays.
    <div className="relative isolate mx-auto w-full px-fluid pb-28 pt-4 lg:pb-12">
      {/* Two soft pools of neutral light behind the header: plain gradients,
          no filter, and no colour that would have to mean something. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[32rem] bg-[radial-gradient(50%_60%_at_12%_0%,rgba(255,255,255,0.07),transparent_70%),radial-gradient(40%_50%_at_88%_8%,rgba(255,255,255,0.04),transparent_70%)]"
      />
      {/* Back link — to this pack's franchise tab */}
      <Link
        href={`/slots?category=${encodeURIComponent(pack.categoryId)}`}
        className="-mt-2.5 mb-1.5 inline-flex min-h-11 items-center gap-1.5 rounded-lg text-[13px] font-medium text-neutral-400 outline-none focus-visible:ring-2 focus-visible:ring-white/40 transition-colors hover:text-white"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />
        All {noun}s
      </Link>

      {/* ===== MAIN: stage + configurator + card sections =====
          Mobile order (single column) is stage → configurator → Top Hits →
          pool, so buy/spin is one small swipe away instead of below the whole
          card pool; on lg the configurator becomes the sticky right column. */}
      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[1.55fr_1fr] lg:gap-8">
        <div className="flex min-w-0 flex-col gap-4">
          {/* ===== Pack header =====
          The name at display size, then what KIND of pack this is, stated as
          facts a collector can read at a glance: its franchise, the admin's
          pack type, an original pack's language, and whether the cards are
          graded. The page used to say none of it (the type and language tags
          never left the admin). Heads the stage column, so a phone reads the name before
          the art and on desktop the configurator starts level with it. */}
          <header className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
              <div className="flex min-w-0 items-center gap-3">
                <h1 className="font-heading text-[clamp(2rem,5.5vw,4rem)] font-bold leading-none tracking-[-0.03em] text-white">
                  {active.name}
                </h1>
                {active.draft && (
                  <span className="shrink-0 rounded-full bg-neutral-800 px-2.5 py-1 text-xs font-bold uppercase tracking-wide text-neutral-300">
                    Draft
                  </span>
                )}
              </div>
              {isFreePack ? (
                // A free pull can be neither sold nor delivered until the first
                // PAID open, so a buyback rate here would advertise money the
                // sell then refuses. Say what it IS instead — or, when it
                // cannot be claimed, drop to quiet white: not an offer, and
                // not a claim about why (see FREE_PACK_UNAVAILABLE_MESSAGE).
                <span
                  className={cn(
                    'inline-flex shrink-0 items-center rounded-full px-2.5 py-1 text-xs font-bold uppercase tracking-wide',
                    freeClaimUnavailable
                      ? 'bg-neutral-800 text-neutral-400'
                      : 'bg-chase/15 text-chase',
                  )}
                >
                  {freeClaimUnavailable ? 'Unavailable' : 'Free'}
                </span>
              ) : (
                !ticketPack && (
                  <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-buyback px-3 py-1.5 text-xs font-bold text-white">
                    {active.buybackPercent ?? FLAT_BUYBACK_PERCENT}% instant
                    buyback
                    <Info className="h-3 w-3 opacity-80" aria-hidden />
                  </span>
                )
              )}
            </div>
            <dl
              data-testid="pack-facts"
              className="flex flex-wrap gap-x-6 gap-y-2"
            >
              {facts.map((fact) => (
                <div key={fact.label} className="flex flex-col gap-0.5">
                  <dt className={FIELD_LABEL}>{fact.label}</dt>
                  <dd className="flex items-center gap-1.5 text-sm font-semibold text-white">
                    {fact.label === 'Category' && (
                      <CategoryIcon
                        src={pack.icon}
                        size={20}
                        className="h-5 w-5"
                      />
                    )}
                    {fact.value}
                  </dd>
                </div>
              ))}
            </dl>
          </header>
          {/* ---- Stage ---- */}
          {active.displayImage ? (
            /* Admin-uploaded hero scene (display_image) — a wide render that
             carries its OWN background (e.g. the factory diorama), so it sits
             on the dark shell full-bleed, object-cover (uploads are gated to
             ~6:5–16:9 landscape; a 16:9 crops ~10% per side in this 36:25
             box). unoptimized: the source may be an ANIMATED webp/gif and
             next/image optimization would flatten it to one frame. */
            <div className="rounded-[2rem] bg-white/[0.04] p-1.5 ring-1 ring-white/10">
              <div className="relative aspect-[36/25] overflow-hidden bg-neutral-900 rounded-[calc(2rem-0.375rem)] shadow-[inset_0_1px_1px_rgba(255,255,255,0.12)]">
                {active.boost && (
                  <span className="absolute left-4 top-4 z-20 rounded-full bg-buyback px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-white">
                    {active.buybackPercent ?? FLAT_BUYBACK_PERCENT}% Instant
                    Buyback
                  </span>
                )}
                {heroVideo ? (
                  /* Baked factory scene — animated loop (robots + conveyor +
                 forklift). Poster is the clip's own first frame, so the still
                 that paints first (and the reduced-motion fallback) matches
                 the video exactly. */
                  <AmbientVideo
                    key={active.id}
                    mp4={heroVideo.mp4}
                    webm={heroVideo.webm}
                    poster={heroVideo.poster}
                    testId="pack-hero-image"
                    className="absolute inset-0 z-10 h-full w-full"
                  />
                ) : (
                  /* Arbitrary uploaded hero (no matching loop) — still render.
                 unoptimized: the source may be an ANIMATED webp/gif and
                 next/image optimization would flatten it to one frame. */
                  <Image
                    key={active.id}
                    data-testid="pack-hero-image"
                    src={active.displayImage}
                    alt={active.name}
                    fill
                    priority
                    unoptimized
                    sizes="(max-width: 1024px) 100vw, 60vw"
                    className="z-10 object-cover"
                  />
                )}
              </div>
            </div>
          ) : (
            /* Uploaded pack photo — compact product shot on the dark surface
             (catalog idiom): rounded so a white-background photo reads as a
             deliberate product card, short enough on phones that the buy
             panel stays in reach. */
            <div className="rounded-[2rem] bg-white/[0.04] p-1.5 ring-1 ring-white/10">
              <div className="relative flex items-center justify-center bg-neutral-900 py-6 sm:py-10 rounded-[calc(2rem-0.375rem)] shadow-[inset_0_1px_1px_rgba(255,255,255,0.12)]">
                {active.boost && (
                  <span className="absolute left-4 top-4 z-20 rounded-full bg-buyback px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-white">
                    {active.buybackPercent ?? FLAT_BUYBACK_PERCENT}% Instant
                    Buyback
                  </span>
                )}
                <Image
                  key={active.id}
                  data-testid="pack-hero-image"
                  src={active.image}
                  alt={active.name}
                  width={205}
                  height={360}
                  priority
                  unoptimized
                  className="h-44 w-auto max-w-[80%] rounded-lg object-contain sm:h-64"
                />
              </div>
            </div>
          )}
        </div>

        {/* ---- Configurator (mobile: right after the stage; lg: sticky right column) ---- */}
        <aside className="lg:sticky lg:top-20 lg:col-start-2 lg:row-span-2 lg:row-start-1">
          {/* One panel, three zones split by hairlines: choose the pack, read
              the terms of the open, open it. It fits the viewport without a
              vertical scrollbar on a normal catalog; a franchise with enough
              packs to outgrow the screen scrolls INSIDE the panel (lg only),
              because a sticky column taller than the viewport would park its
              Open button below the fold. On mobile the page itself scrolls. */}
          <div className="rounded-[2rem] bg-white/[0.04] p-1.5 ring-1 ring-white/10">
            <div className="flex flex-col overflow-hidden bg-neutral-950 rounded-[calc(2rem-0.375rem)] shadow-[inset_0_1px_1px_rgba(255,255,255,0.12)] [scrollbar-color:#404040_transparent] [scrollbar-width:thin] lg:max-h-[calc(100svh-6.75rem)] lg:overflow-y-auto">
              {/* No key: the picker stays mounted across a switch, so the
                  tile just tapped keeps focus and nothing in it flickers. It
                  follows the pack itself (see PackPicker). */}
              <PackPicker
                pack={pack}
                siblings={siblings}
                categoryTabs={categoryTabs}
                qty={qty}
                onCategory={switchCategory}
                onPick={onPick}
                onIntent={onIntent}
                pendingPack={pendingPack}
                pendingCategory={pendingCategory}
              />

              <PackBuyControls model={buy} variant="panel" />
            </div>
          </div>
        </aside>

        {/* ---- Card sections (mobile: below the configurator; lg: under the stage) ----
            min-w-0: the pool rails hold nowrap prices whose min-content width
            would otherwise stretch this grid item past the viewport. */}
        <div className="mt-6 flex min-w-0 flex-col gap-6 lg:col-start-1 lg:row-start-2 lg:mt-10">
          {/* The admin-CURATED top-hits grid that used to render here was
              removed 2026-08-08 (operator decision): the rail below is THE
              "Top Hits" section now. `liveDetail.topHits` and the admin
              curation UI (backend/apps/admin packs/[slug]) still exist —
              don't prune them; only the storefront rendering is retired. */}

          {/* Top Hits — Immortal/Legendary/Mythical only, as a swipeable
              rail whose expand button opens a dialog of the SAME top-tier
              subset (rarest first, per-tier pull chance when the pack has
              Pull Odds) —
              operator decision 2026-08-08; lower tiers are catalogue noise
              in the expanded view too. The odds panel below still quotes
              value ranges over the FULL pool — a deliberate,
              operator-accepted mismatch (see PoolByRarity's header note
              before "fixing" it). Header lives inside the component (the
              expand button sits in it). Gated on `pool`, not `topPool`: a
              pack with no top-tier cards has an empty subset but a
              non-empty pool — PoolByRarity drops the rail strip and falls
              back to the full pool under an "All cards" header, so the pool
              keeps an entry point instead of vanishing under an odds panel
              with nothing to point at. */}
          <PackTopHits
            pack={active}
            detail={liveDetail}
            onOpenCard={overlay.open}
          />
        </div>
      </div>

      {/* ===== Pull Odds, then Recent Pulls (below the fold) =====
          Two full-width boards, each a side column (its heading and headline
          figures) beside its content; on a phone the side column simply comes
          first. The odds board renders ONLY the staff-entered Pull Odds from the
          backend; a pack with no Pull Odds shows no board at all. Nor does
          a pack whose Pull Odds carry no per-tier rows AND nothing priced:
          that would be a bare heading over an empty box. */}
      <div className="mb-10 mt-14 flex flex-col gap-14 lg:mt-24 lg:gap-24">
        <PackPullOdds pack={active} tiers={tiers} />

        <PackRecentPulls
          pack={active}
          initial={recentPulls}
          onOpenCard={overlay.open}
        />
      </div>

      {/* ===== Phone buy bar =====
          One slim pill floating over the tab dock: total in Nekst left (money
          is the content), quiet capsule stepper, and one single-purpose white
          pill (the panel's own qty/footer are lg-only, so there is exactly
          one CTA per zone). Max = two taps of +. */}
      <PackBuyControls model={buy} variant="dock" />

      <PackCardOverlay pack={active} overlay={overlay} />
    </div>
  );
}
