'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import {
  ArrowLeft,
  ArrowRight,
  Clock,
  Info,
  Minus,
  Play,
  Plus,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useDragScroll } from '@/lib/use-drag-scroll';
import { rm, affordable } from '@/lib/format';
import { useAuth } from '@/components/auth/AuthProvider';
import { openAuth } from '@/components/AuthButton';
import Reveal from '@/components/Reveal';
import type { PackDetail, RecentPull } from '@/lib/data/packs';
import {
  type Pack,
  type ResolvedPack,
  type PackCard,
  CATALOG_GROUP_HEADING,
  FLAT_BUYBACK_PERCENT,
  FREE_WELCOME_CATEGORY,
  FREE_PULL_LOCKED_MESSAGE,
  factoryVideo,
  groupPacks,
} from '@/lib/packs-data';
import { AmbientVideo } from '@/components/AmbientVideo';
import { Pill } from '@/components/ui/pill';
import { PublishedOddsList, hasPublishedOddsContent } from './OddsSheet';
import { PoolByRarity } from './PoolByRarity';
import {
  publishedOddsRows,
  poolValueRange,
  tierValueRanges,
} from '@/lib/packs-format';
import { isTopRarity } from '@/lib/rarity';
import { useLiveRecentPulls } from '@/lib/use-recent-pulls';
import { useTopUp } from '@/components/app-shell/TopUpProvider';
import { CardTile } from '@/components/cards/CardTile';
import {
  CardDetailOverlay,
  type CardSeed,
} from '@/components/cards/CardDetailOverlay';
import { usePackDetailPoll } from '@/lib/use-pack-detail-poll';
import { SlabImage } from '@/components/SlabImage';

/**
 * Shown where the gift offer would be, when this visitor cannot claim it.
 *
 * DELIBERATELY does not say "already claimed". The ineligible state is
 * `canClaimFreePack` → false, which covers a spent claim AND a failed
 * eligibility read (backend down, breaker open) — the storefront cannot tell
 * them apart, so any wording asserting a past claim is a lie to a first-time
 * visitor whose read simply failed. This sentence is true in both.
 *
 * Storefront-only copy (unlike FREE_PULL_LOCKED_MESSAGE, which the backend also
 * throws): nothing server-side refuses with this wording — the open's refusal
 * is the backend's own, and this page never gets that far.
 */
const FREE_PACK_UNAVAILABLE_MESSAGE =
  "This welcome pack isn't available on this account.";

/**
 * One composition group's sibling tiles (Graded / Raw Cards / More Packs) as a
 * horizontally-swipeable rail: three across, the rest a swipe away. Replaces
 * the old flat 3-col grid, which mixed graded and raw tiers into one block —
 * the /slots catalog already sections by the SAME backend-derived composition
 * (catalogGroupOf), so the selector now reads the same way.
 */
function PackRail({
  packs,
  activeId,
  onPick,
}: {
  packs: Pack[];
  activeId: string;
  onPick: (p: Pack) => void;
}) {
  // Mouse drag-to-scroll: touch swipes natively, but a mouse has no gesture
  // for a horizontal rail (a vertical wheel does nothing here), so the extra
  // packs were unreachable on desktop without a trackpad.
  const drag = useDragScroll<HTMLDivElement>();
  const arrived = useRef<HTMLButtonElement>(null);

  // Centre the pack we arrived on. With only three tiles visible, a deep link
  // to a 6th-place pack would otherwise render a selector that appears not to
  // contain the pack the panel is titled after. scrollLeft, never
  // scrollIntoView: the latter also scrolls the page/sticky column to reach
  // this rail. Mount only — re-centring after a tap yanks the rail under the
  // thumb, and the tapped tile is by definition already on screen.
  useEffect(() => {
    const tile = arrived.current;
    // The rail is the tile's parent. Reached that way rather than through
    // `drag.ref`, because writing scrollLeft through a value a custom hook
    // returned trips react-hooks/immutability (the compiler treats a hook's
    // return as frozen; a local useRef is exempt, a borrowed one is not).
    const r = tile?.parentElement;
    if (!tile || !r) return;
    r.scrollLeft = tile.offsetLeft - (r.clientWidth - tile.clientWidth) / 2;
  }, []);

  return (
    <div
      {...drag}
      data-testid="pack-rail"
      // `relative`: offsetLeft above is measured against the offsetParent, so
      // the rail has to be one. Scrollbar hidden like the catalog's rails.
      className={cn(
        // No scroll-snap: `snap-mandatory` re-settles every rest position
        // with a tile flush to the left edge, which erases the left-hand peek
        // (and undid the mount-centring below). The teaser rail in
        // PoolByRarity scrolls free too.
        'relative flex gap-1.5 overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
        packs.length > 3 && 'cursor-grab active:cursor-grabbing',
      )}
    >
      {packs.map((p) => {
        const selected = p.id === activeId;
        return (
          <button
            key={p.id}
            ref={selected ? arrived : undefined}
            type="button"
            aria-pressed={selected}
            onClick={() => onPick(p)}
            className={cn(
              'flex shrink-0 flex-col items-center gap-0.5 rounded-xl border px-1 py-2 text-center transition-colors',
              // With more packs than fit, tiles are narrowed so a 4th one
              // peeks in from the edge -- the only affordance that tells a
              // user the rail scrolls at all. The mount-centring above then
              // leaves a partial tile on BOTH sides whenever there is one to
              // scroll to. Exactly three (or fewer) still
              // fill the row edge-to-edge: two 0.375rem gaps. The underscores
              // are Tailwind's escape for the spaces CSS `calc()` requires
              // around `-`; without them it parses only by the minifier's
              // leniency.
              packs.length > 3
                ? 'w-[calc((100%_-_1.125rem)/3.7)]'
                : 'w-[calc((100%_-_0.75rem)/3)]',
              selected
                ? 'border-white/40 bg-white/10'
                : 'border-white/10 bg-white/[0.03] hover:border-white/20 hover:bg-white/[0.06]',
            )}
          >
            <Image
              src={p.image}
              alt=""
              aria-hidden
              width={205}
              height={360}
              unoptimized
              className="h-9 w-auto object-contain"
            />
            <span className="w-full truncate text-[11px] font-medium leading-tight text-white">
              {p.name.replace(' Pack', '')}
            </span>
            <span className="text-[11px] font-semibold tabular-nums text-white/55">
              {p.price}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export default function PackDetailClient({
  pack,
  siblings,
  detail,
  recentPulls,
  initialQty = 1,
  freePackEligible = true,
}: {
  pack: ResolvedPack;
  siblings: Pack[];
  /** Backend gacha pool (Top Hits + Pull Odds); null when the backend is down. */
  detail: PackDetail | null;
  /** Live pull ledger feed; empty array when there are no pulls / backend down. */
  recentPulls: RecentPull[];
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
}) {
  const { customer } = useAuth();
  const { balance, openTopUp } = useTopUp();
  const router = useRouter();
  const [active, setActive] = useState<Pack>(pack);
  const [qty, setQty] = useState(initialQty);
  // `openError` surfaces a friendly failure inline (`needsTopUp` adds the
  // top-up entry for credit shortfalls). Real opens happen on the reel, so
  // there is no in-place async open state here.
  const [openError, setOpenError] = useState<string | null>(null);
  const [needsTopUp, setNeedsTopUp] = useState(false);
  // One request refreshes every grid price (60s, visibility-gated). `detail`
  // is the URL pack's (`pack`) server snapshot -- only pass it as the seed
  // when the selected sibling IS the URL pack; otherwise seed null so a
  // sibling switch never renders pack A's pool/Top Hits/odds under pack B's
  // name (the gated-empty sections below render instead until the poll's
  // immediate tick lands).
  const liveDetail = usePackDetailPoll(
    active.id,
    active.id === pack.id ? detail : null,
  );
  const [openCard, setOpenCard] = useState<CardSeed | null>(null);
  const toSeed = (c: PackCard): CardSeed => ({
    handle: c.id,
    name: c.name,
    image: c.image,
    slabImage: c.slabImage,
    value: c.value,
    rarity: c.rarity,
  });
  // Credit balance (A2: opens debit the pack price) — read from the app-shell
  // TopUpProvider (identity-tagged; null = logged out / loading), so this page,
  // the header chip, and the top-up sheet can never disagree.
  // Live Recent Pulls for THIS pack — seeded from the server snapshot, then
  // polled (~4s) so anyone's pull shows up here without a reload. Keyed on the
  // active sibling: the sibling row switches packs in place, no navigation.
  // Deliberately NOT blanked on that switch (unlike usePackDetailPoll above):
  // the previous pack's rows show for the one in-flight poll, but the rows
  // carry no pack label, so nothing on screen contradicts itself — whereas
  // blanking would flash "No pulls yet" on a pack that demonstrably has pulls.
  const recent = useLiveRecentPulls(recentPulls, active.id);

  // The one-time free welcome pack: no price, no quantity, no batch — the claim
  // pays for exactly ONE open (the backend rejects a batch on this category), so
  // every money/quantity control is removed rather than merely zeroed. Its
  // siblings list is empty (it is not in the catalog), so `active` can never
  // become a different, paid pack.
  const isFreePack = pack.categoryId === FREE_WELCOME_CATEGORY;
  // The free pack, reached by someone who cannot claim it — a spent claim OR a
  // failed eligibility read, which the storefront cannot tell apart (hence the
  // neutral copy above; nothing here may assert a past claim). Every gift
  // affordance below turns off together — a half-suppressed state (dock CTA
  // gone, panel copy still promising "nothing charged") reads as a bug, and the
  // promise is the part that is actually false.
  const freeClaimUnavailable = isFreePack && !freePackEligible;

  // Real backend price, never re-parsed from the rounded display string.
  const priceNum = active.priceValue;
  // Baked Polycards tiers animate their factory stage (still poster otherwise).
  const heroVideo = factoryVideo(active.displayImage);

  // Top Hits come from the backend prize pool (highest market_value) — the
  // backend is the source of truth, so a missing/empty pool renders an empty
  // state (no mock fallback). Pull Odds are the SECRET-decoupled, statically-
  // published `ODDS` — they never reflect the admin-tuned win rates (see
  // packs.ts / route.ts).

  // The reel (openBatch) caps a single open at 3 packs.
  const maxQty = 3;
  const setQ = (n: number) => setQty(Math.min(maxQty, Math.max(1, n)));

  // The admin-PUBLISHED odds — the ONLY rates players see. Null (unset) hides
  // the whole Pull Odds panel.
  const publishedRows = liveDetail?.publishedOdds
    ? publishedOddsRows(liveDetail.publishedOdds)
    : null;

  // The full public prize pool (value-sorted) — feeds the odds panel's
  // valueRange/tierRanges, gates the guest demo-spin CTA (pure theater on the
  // reel, /spin?demo=1 — no charge, nothing won), and backs the pool dialog
  // only in the zero-top-hit fallback (PoolByRarity's `full` prop).
  // Memoized so the `?? []` fallback doesn't mint a fresh array every render —
  // that identity churn would make the valueRange memo below recompute always.
  const pool = useMemo(() => liveDetail?.pool ?? [], [liveDetail?.pool]);

  // Top-tier subset for the "Top Hits" section (Immortal/Legendary/Mythical —
  // operator decision 2026-08-08): the rail shows the whole subset, the expand
  // dialog lists the same cards grouped by tier. Order inherited (pool is
  // value-sorted desc). The FULL pool still feeds the demo spin + odds range.
  // Memoized like `pool` above (stable prop identity for PoolByRarity).
  const topPool = useMemo(
    () => pool.filter((c) => isTopRarity(c.rarity)),
    [pool],
  );

  // Sibling selector, sectioned by the SAME backend-derived composition the
  // /slots catalog groups on (catalogGroupOf) — auto-detected, never operator-
  // set. Every group is rendered, not just graded/raw: 'more' holds the
  // uncertain pools (MIX, non-PSA-10 graded, unknown), and dropping it would
  // make those siblings unreachable from this page. Empty groups are skipped.
  const siblingGroups = useMemo(() => groupPacks(siblings), [siblings]);

  // Card-value range over the FULL pool (not topPool) — one derivation feeding
  // both the odds-panel gate and its range row.
  const valueRange = useMemo(() => poolValueRange(pool), [pool]);

  // Same derivation per rarity, so each published tier row can state what a
  // card of THAT tier is worth here. The pack-wide range above spans Common to
  // Immortal and so describes no tier in particular.
  const tierRanges = useMemo(() => tierValueRanges(pool), [pool]);

  // Do NOT open/charge here — navigate to the reel, which performs
  // the single charge via openBatch when the user pulls the lever. Auth + balance
  // are pre-checked so we don't drop into the immersive reel only to bounce to
  // login or a credit shortfall. (Deliberately navigate-then-lever, not
  // auto-spin, so a reel page refresh can never re-charge.)
  function handleGoToReel() {
    if (!customer) {
      openAuth('login');
      return;
    }
    // A free open costs nothing and is always singular — skip the credit gate
    // (a brand-new account has a zero balance by definition) and pin count=1.
    if (isFreePack) {
      setOpenError(null);
      setNeedsTopUp(false);
      router.push(`/slots/${active.id}/spin?count=1`);
      return;
    }
    if (balance !== null && !affordable(balance, priceNum * qty)) {
      setNeedsTopUp(true);
      setOpenError('Not enough credits to open.');
      return;
    }
    setOpenError(null);
    setNeedsTopUp(false);
    router.push(`/slots/${active.id}/spin?count=${qty}`);
  }

  function reset() {
    setOpenError(null);
    setNeedsTopUp(false);
  }

  return (
    // pb clears the mobile sticky buy bar (fixed above the tab bar).
    <div className="mx-auto w-full px-fluid pb-28 pt-4 lg:pb-4">
      {/* Back link */}
      <Link
        href="/slots"
        className="mb-4 inline-flex items-center gap-1.5 text-[13px] font-medium text-white/55 transition-colors hover:text-white"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />
        All packs
      </Link>

      {/* ===== MAIN: stage + configurator + card sections =====
          Mobile order (single column) is stage → configurator → Top Hits →
          pool, so buy/spin is one small swipe away instead of below the whole
          card pool; on lg the configurator becomes the sticky right column. */}
      <div className="grid items-start gap-6 lg:grid-cols-[1.55fr_1fr]">
        {/* ---- Stage ---- */}
        {active.displayImage ? (
          /* Admin-uploaded hero scene (display_image) — a wide render that
             carries its OWN background (e.g. the factory diorama), so it sits
             on the dark shell full-bleed, object-cover (uploads are gated to
             ~6:5–16:9 landscape; a 16:9 crops ~10% per side in this 36:25
             box). unoptimized: the source may be an ANIMATED webp/gif and
             next/image optimization would flatten it to one frame. */
          <div className="relative aspect-[36/25] overflow-hidden rounded-2xl border border-white/10 bg-neutral-900">
            {active.boost && (
              <span className="absolute left-4 top-4 z-20 rounded-md bg-buyback px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-white shadow-sm">
                +{active.buybackPercent ?? FLAT_BUYBACK_PERCENT}% Buyback Boost
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
        ) : (
          /* Uploaded pack photo — compact product shot on the dark surface
             (catalog idiom): rounded so a white-background photo reads as a
             deliberate product card, short enough on phones that the buy
             panel stays in reach. */
          <div className="relative flex items-center justify-center rounded-2xl border border-white/10 bg-neutral-900 py-6 sm:py-10">
            {active.boost && (
              <span className="absolute left-4 top-4 z-20 rounded-md bg-buyback px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-white shadow-sm">
                +{active.buybackPercent ?? FLAT_BUYBACK_PERCENT}% Buyback Boost
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
              className="h-44 w-auto max-w-[80%] rounded-lg object-contain drop-shadow-[0_12px_28px_rgba(0,0,0,0.5)] sm:h-64"
            />
          </div>
        )}

        {/* ---- Configurator (mobile: right after the stage; lg: sticky right column) ---- */}
        <aside className="lg:sticky lg:top-20 lg:col-start-2 lg:row-span-2 lg:row-start-1">
          {/* The whole configurator fits without a VERTICAL scrollbar (like the
              live site): the pack selector's rails scroll sideways, no
              max-height clamp — on mobile the page itself scrolls, on desktop
              it fits the viewport. */}
          <div className="flex flex-col overflow-hidden rounded-2xl border border-white/10 bg-neutral-950">
            {/* Title + buyback */}
            <div className="flex items-center justify-between gap-3 border-b border-white/10 px-5 py-4">
              <h1 className="font-heading text-xl font-bold tracking-tight text-white sm:text-2xl">
                {active.name}
              </h1>
              {isFreePack ? (
                // A free pull can be neither sold nor delivered until the first
                // PAID open, so a buyback rate here would advertise money the
                // sell then refuses. Say what it IS instead — or, when it
                // cannot be claimed, drop to quiet white: not an offer, and
                // not a claim about why (see FREE_PACK_UNAVAILABLE_MESSAGE).
                <span
                  className={cn(
                    'inline-flex shrink-0 items-center rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide',
                    freeClaimUnavailable
                      ? 'bg-white/10 text-white/60'
                      : 'bg-chase/15 text-chase',
                  )}
                >
                  {freeClaimUnavailable ? 'Unavailable' : 'Free'}
                </span>
              ) : (
                <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-buyback/90 px-2.5 py-1 text-[11px] font-bold text-white">
                  {active.buybackPercent ?? 90}% Buyback
                  <Info className="h-3 w-3 opacity-80" aria-hidden />
                </span>
              )}
            </div>

            <div className="flex flex-col gap-4 px-5 py-4">
              {/* Free demo spin — guests only (hidden once logged in; a real
                  account opens real packs). Routes to the slot reel in demo
                  mode: no login, no charge, nothing real won. Neutral ghost
                  styling — buyback green is reserved for money-in actions. */}
              {!customer && pool.length > 0 && (
                <Link
                  href={`/slots/${active.id}/spin?demo=1`}
                  className="group flex h-12 items-center justify-between rounded-xl border border-white/15 bg-white/5 px-4 text-sm font-semibold text-white transition-colors hover:bg-white/10"
                >
                  <span className="flex items-center gap-2.5">
                    <span className="flex h-7 w-7 items-center justify-center rounded-full bg-white/15 text-white transition-transform duration-200 group-hover:scale-110">
                      <Play
                        className="ml-0.5 h-3.5 w-3.5 fill-current"
                        aria-hidden
                      />
                    </span>
                    <span className="flex flex-col leading-tight">
                      Try a free demo spin
                      <span className="text-[11px] font-normal text-white/60">
                        No login · nothing charged
                      </span>
                    </span>
                  </span>
                  <ArrowRight
                    className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5"
                    aria-hidden
                  />
                </Link>
              )}

              {/* Category */}
              <div>
                <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-white/60">
                  Category
                </p>
                <div className="flex h-11 items-center rounded-xl border border-white/10 bg-white/5 px-3 text-sm text-white">
                  <span className="flex items-center gap-2">
                    <Image
                      src={pack.icon}
                      alt=""
                      aria-hidden
                      width={20}
                      height={20}
                      className="h-5 w-5 object-contain"
                    />
                    {pack.categoryName}
                  </span>
                </div>
              </div>

              {/* Pack tiles — an uncataloged pack (the free welcome pack) has
                  no siblings, and an empty selector grid reads as a broken
                  section rather than a choice. */}
              {siblings.length > 0 && (
                <div>
                  <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-white/60">
                    Pack
                  </p>
                  {/* One rail per composition group, three tiles across. The
                      panel still never scrolls VERTICALLY — the rails scroll
                      horizontally, so extra tiers cost a swipe, not height. */}
                  <div
                    data-testid="pack-selector"
                    className="flex flex-col gap-2.5"
                  >
                    {siblingGroups.map((g) => (
                      <div key={g.id} data-testid="pack-selector-group">
                        <div className="mb-1 flex items-baseline justify-between gap-2">
                          <p className="text-[11px] font-semibold text-white/70">
                            {CATALOG_GROUP_HEADING[g.id]}
                          </p>
                          <span className="text-[10px] text-white/40">
                            <span className="tabular-nums">
                              {g.packs.length}
                            </span>{' '}
                            {g.packs.length === 1 ? 'pack' : 'packs'}
                          </span>
                        </div>
                        <PackRail
                          packs={g.packs}
                          activeId={active.id}
                          onPick={(p) => {
                            setActive(p);
                            reset();
                          }}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Quantity — desktop only; on phones it lives in the sticky
                  buy bar so there is a single Open Pack control per zone.
                  Absent on the free pack: the claim buys exactly one open. */}
              <div
                className={cn(
                  'hidden items-center gap-2',
                  !isFreePack && 'lg:flex',
                )}
              >
                <button
                  type="button"
                  aria-label="Decrease quantity"
                  onClick={() => setQ(qty - 1)}
                  disabled={qty <= 1}
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/5 text-white/70 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-40"
                >
                  <Minus className="h-4 w-4" aria-hidden />
                </button>
                <span className="flex h-11 flex-1 items-center justify-center rounded-xl border border-white/10 bg-white/[0.03] text-sm font-medium tabular-nums text-white">
                  {qty} {qty === 1 ? 'Pack' : 'Packs'}
                </span>
                <button
                  type="button"
                  aria-label="Increase quantity"
                  onClick={() => setQ(qty + 1)}
                  disabled={qty >= maxQty}
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/5 text-white/70 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-40"
                >
                  <Plus className="h-4 w-4" aria-hidden />
                </button>
                <button
                  type="button"
                  onClick={() => setQ(maxQty)}
                  className="flex h-11 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/5 px-3 text-[12px] font-bold uppercase tracking-wide text-white/60 transition-colors hover:bg-white/10 hover:text-white"
                >
                  Max
                </button>
              </div>
            </div>

            {/* Open Pack — desktop panel footer (phones use the sticky bar) */}
            <div className="hidden border-t border-white/10 p-4 lg:block">
              {/* DESIGN.md primary: Paper White pill, Ink text — buyback green
                  is a money-IN signal and never a spend CTA. Money in Nekst.
                  Absent when the claim is unavailable: the open would 4xx, so a
                  primary CTA here is an invitation to a refusal. */}
              {!freeClaimUnavailable && (
                <Pill
                  variant="primary"
                  size="lg"
                  onClick={handleGoToReel}
                  className="w-full justify-between px-5"
                >
                  {customer
                    ? isFreePack
                      ? 'Open Free Pack'
                      : 'Open Pack'
                    : 'Log in to open'}
                  <span className="flex items-center gap-1.5 font-heading text-base tracking-tight tabular-nums">
                    {!isFreePack && rm(priceNum * qty)}
                    <ArrowRight className="h-4 w-4" aria-hidden />
                  </span>
                </Pill>
              )}
              {openError && (
                <p
                  role="alert"
                  className="mt-2 text-center text-[11px] text-red-300"
                >
                  {openError}
                  {needsTopUp && (
                    <>
                      {' '}
                      {balance !== null && priceNum * qty - balance > 0 && (
                        <>You&apos;re {rm(priceNum * qty - balance)} short. </>
                      )}
                      <button
                        type="button"
                        onClick={openTopUp}
                        className="font-bold text-buyback-fg underline underline-offset-2 hover:text-buyback-fg"
                      >
                        Top up credits →
                      </button>
                    </>
                  )}
                </p>
              )}
              {/* The quantity selector + total are the live site's purchase framing
                  (cosmetic in this preview); a real open rolls ONE pack and debits
                  its price from the credit balance (A2). Quantity & provably-fair
                  pulls stay out of scope. */}
              <p
                className={cn(
                  'text-center text-[11px] text-white/60',
                  !freeClaimUnavailable && 'mt-2',
                )}
              >
                {freeClaimUnavailable ? (
                  <>{FREE_PACK_UNAVAILABLE_MESSAGE}</>
                ) : isFreePack ? (
                  <>
                    Your one-time welcome pack — nothing charged. The card lands
                    in your vault. {FREE_PULL_LOCKED_MESSAGE}
                  </>
                ) : customer && balance !== null ? (
                  <>
                    Each open costs {rm(priceNum)} in site credits — your
                    balance:{' '}
                    <span
                      className={cn(
                        'font-bold',
                        balance < priceNum ? 'text-red-300' : 'text-white/70',
                      )}
                    >
                      {rm(balance)}
                    </span>
                  </>
                ) : (
                  <>
                    Each open costs the pack price in site credits — one pack
                    per open, recorded to your account.
                  </>
                )}
              </p>
            </div>
          </div>
        </aside>

        {/* ---- Card sections (mobile: below the configurator; lg: under the stage) ----
            min-w-0: the pool rails hold nowrap prices whose min-content width
            would otherwise stretch this grid item past the viewport. */}
        <div className="flex min-w-0 flex-col gap-6 lg:col-start-1 lg:row-start-2">
          {/* The admin-CURATED top-hits grid that used to render here was
              removed 2026-08-08 (operator decision): the rail below is THE
              "Top Hits" section now. `liveDetail.topHits` and the admin
              curation UI (backend/apps/admin packs/[slug]) still exist —
              don't prune them; only the storefront rendering is retired. */}

          {/* Top Hits — Immortal/Legendary/Mythical only, as a swipeable
              rail whose expand button opens a dialog of the SAME top-tier
              subset (rarest first, per-tier pull chance when published) —
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
          {pool.length > 0 && (
            <Reveal as="section">
              <PoolByRarity
                rail={topPool}
                full={pool}
                tierChances={liveDetail?.publishedOdds?.tiers ?? null}
                onOpen={(card) => setOpenCard(toSeed(card))}
              />
            </Reveal>
          )}
        </div>
      </div>

      {/* ===== Pull Odds + Recent Pulls (below the fold) =====
          The odds panel renders ONLY the admin-published rates from the
          backend; a pack with no published odds shows no panel at all. Nor does
          a pack whose published odds carry no per-tier rows AND nothing priced
          — that would be a bare heading over an empty box. */}
      <div className="mb-10 mt-8 grid gap-6 lg:grid-cols-2">
        {hasPublishedOddsContent(publishedRows, valueRange) && (
          <Reveal as="section" className="h-full min-w-0">
            <div className="mb-3 flex items-center gap-2">
              <h2 className="font-heading text-lg font-bold tracking-tight text-white">
                Pull Odds (by rarity)
              </h2>
            </div>
            <PublishedOddsList
              odds={publishedRows}
              range={valueRange}
              tierRanges={tierRanges}
              rounded="2xl"
            />
          </Reveal>
        )}

        <Reveal as="section" delay={90} className="h-full min-w-0">
          <div className="mb-3 flex items-center gap-2">
            <Clock className="h-4 w-4 text-white/50" aria-hidden />
            <h2 className="font-heading text-lg font-bold tracking-tight text-white">
              Recent Pulls
            </h2>
          </div>
          <ul className="divide-y divide-white/5 overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03]">
            {recent.length === 0 ? (
              <li className="px-4 py-8 text-center text-[13px] text-white/60">
                No pulls yet — be the first to open a pack.
              </li>
            ) : (
              recent.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() =>
                      setOpenCard({
                        handle: c.handle,
                        name: c.name,
                        image: c.image,
                        slabImage: c.slabImage,
                        value: c.value,
                        rarity: c.rarity,
                      })
                    }
                    className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-white/[0.04]"
                    // The label carries EVERYTHING sighted users see in the
                    // row — an aria-label REPLACES the content for SR users.
                    aria-label={`View details for ${c.name} — pulled by ${c.who}, ${c.value}, ${c.agoLabel}`}
                  >
                    <SlabImage
                      src={c.image}
                      slabSrc={c.slabImage}
                      alt=""
                      sizes="32px"
                      className="w-8 shrink-0"
                    />
                    <span className="min-w-0 flex-1 truncate text-[13px] text-white/80">
                      {c.name}
                    </span>
                    <span className="shrink-0 text-[11px] text-white/60">
                      {c.who}
                    </span>
                    <span className="shrink-0 text-[12px] tabular-nums text-white/60">
                      {c.value}
                    </span>
                    <span className="hidden shrink-0 text-[11px] text-white/60 sm:inline">
                      {c.agoLabel}
                    </span>
                  </button>
                </li>
              ))
            )}
          </ul>
        </Reveal>
      </div>

      {/* ===== Mobile buy dock =====
          Docked flush onto the tab bar as ONE bottom chrome unit — same ink
          surface, a single hairline seam, no floating card. Total in Nekst
          left (money is the content), quiet capsule stepper, and one
          single-purpose white pill (the panel's own qty/footer are lg-only,
          so there is exactly one CTA per zone). Max = two taps of +. */}
      <div
        data-testid="pack-buy-dock"
        className="fixed inset-x-0 bottom-[calc(4rem+env(safe-area-inset-bottom))] z-40 border-t border-white/10 bg-neutral-950 px-fluid py-2.5 lg:hidden"
      >
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            {/* Free mode states the gift where the total normally sits — the
                slot must not go empty, or the pill drifts left and the dock
                reads like a different component. */}
            <p className="truncate font-heading text-xl font-bold leading-none tracking-tight text-white tabular-nums">
              {freeClaimUnavailable
                ? 'Unavailable'
                : isFreePack
                  ? 'Free'
                  : rm(priceNum * qty)}
            </p>
            <p className="mt-1 text-[11px] leading-none text-white/60">
              {freeClaimUnavailable
                ? 'Not available on this account'
                : isFreePack
                  ? 'Your welcome pack'
                  : `${active.buybackPercent ?? FLAT_BUYBACK_PERCENT}% buyback`}
            </p>
          </div>
          <div
            className={cn(
              'h-11 shrink-0 items-center rounded-full bg-white/5',
              isFreePack ? 'hidden' : 'flex',
            )}
          >
            <button
              type="button"
              aria-label="Decrease quantity"
              onClick={() => setQ(qty - 1)}
              disabled={qty <= 1}
              className="flex h-11 w-10 items-center justify-center rounded-full text-white/70 transition-colors hover:text-white disabled:opacity-40"
            >
              <Minus className="h-4 w-4" aria-hidden />
            </button>
            <span className="w-5 text-center text-sm font-semibold tabular-nums text-white">
              {qty}
            </span>
            <button
              type="button"
              aria-label="Increase quantity"
              onClick={() => setQ(qty + 1)}
              disabled={qty >= maxQty}
              className="flex h-11 w-10 items-center justify-center rounded-full text-white/70 transition-colors hover:text-white disabled:opacity-40"
            >
              <Plus className="h-4 w-4" aria-hidden />
            </button>
          </div>
          {!freeClaimUnavailable && (
            <Pill
              variant="primary"
              size="md"
              onClick={handleGoToReel}
              className="shrink-0 px-5"
            >
              {customer
                ? isFreePack
                  ? 'Open Free Pack'
                  : 'Open Pack'
                : 'Log in'}
            </Pill>
          )}
        </div>
        {openError && (
          <p role="alert" className="mt-2 text-center text-[11px] text-red-300">
            {openError}
            {needsTopUp && (
              <>
                {' '}
                {balance !== null && priceNum * qty - balance > 0 && (
                  <>You&apos;re {rm(priceNum * qty - balance)} short. </>
                )}
                <button
                  type="button"
                  onClick={openTopUp}
                  className="font-bold text-buyback-fg underline underline-offset-2 hover:text-buyback-fg"
                >
                  Top up credits →
                </button>
              </>
            )}
          </p>
        )}
      </div>

      <CardDetailOverlay
        seed={openCard}
        buybackPercent={active.buybackPercent ?? FLAT_BUYBACK_PERCENT}
        onClose={() => setOpenCard(null)}
      />
    </div>
  );
}
