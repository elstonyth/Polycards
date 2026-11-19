'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import Image from 'next/image';
import { ArrowLeft, Info, Minus, Play, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { rm, affordable } from '@/lib/format';
import { trackPixel } from '@/lib/pixel';
import { useAuth } from '@/components/auth/AuthProvider';
import { openAuth } from '@/components/AuthButton';
import Reveal from '@/components/Reveal';
import type { PackDetail, RecentFeed } from '@/lib/data/packs';
import {
  type Pack,
  type PackTab,
  type ResolvedPack,
  type PackCard,
  FLAT_BUYBACK_PERCENT,
  FREE_WELCOME_CATEGORY,
  FREE_PULL_LOCKED_MESSAGE,
  factoryVideo,
  isTicketPack,
  packFacts,
  packHref,
} from '@/lib/packs-data';
import { AmbientVideo } from '@/components/AmbientVideo';
import { Pill } from '@/components/ui/pill';
import { ArrowDisc, SPRING, SectionHead } from '@/components/ui/soft';
import { hasPublishedOddsContent } from './OddsSheet';
import { OddsBoard } from './OddsBoard';
import { PoolByRarity } from './PoolByRarity';
import { FIELD_LABEL, PackPicker } from './PackPicker';
import {
  publishedOddsRows,
  ticketOddsPool,
  ticketTopHits,
  poolValueRange,
  poolExpectedValue,
  tierValueRanges,
} from '@/lib/packs-format';
import { isTopRarity } from '@/lib/rarity';
import { PullHistory } from '@/components/PullHistory';
import { useTopUp } from '@/components/app-shell/TopUpProvider';
import {
  CardDetailOverlay,
  type CardSeed,
} from '@/components/cards/CardDetailOverlay';
import { usePackDetailPoll } from '@/lib/use-pack-detail-poll';
import { usePackGifts } from '@/lib/use-pack-gifts';
import {
  giftsUsed,
  paidCost as costAfterGifts,
  vaultButtonLabel,
  vaultCostLabel,
} from '@/lib/vault-packs';
import {
  freePackVerifyLink,
  freePackVerifyMessage,
  type FreePackRequirement,
} from '@/lib/packs-data';
import { isPokemonPack } from '@/lib/resolve-card-pokemon';

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
  const { customer } = useAuth();
  const { balance, openTopUp } = useTopUp();
  const router = useRouter();
  // The address owns selection so the address bar, shared links and browser
  // history always describe the pack being shown. PackPage switches packs in
  // place, so ONE instance of this component lives across packs: anything it
  // remembers about a pack has to be reset when `pack` changes (below).
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
  // Back can restore a cached server snapshot with an older initialQty, so
  // the live URL owns quantity as well as pack selection.
  const searchParams = useSearchParams();
  const count = Number(searchParams.get('count') ?? initialQty);
  // `openError` surfaces a friendly failure inline (`needsTopUp` adds the
  // top-up entry for credit shortfalls). Real opens happen on the reel, so
  // there is no in-place async open state here.
  // A free pack still waiting on verification (spec 2026-10-06) renders with
  // the prompt already showing, so the customer reads what is left BEFORE
  // tapping a CTA that cannot succeed yet. The tap answers with it again.
  const verifyPrompt =
    pack.categoryId === FREE_WELCOME_CATEGORY && freePackMissing.length > 0
      ? freePackVerifyMessage(freePackMissing)
      : null;
  const [openError, setOpenError] = useState<string | null>(verifyPrompt);
  const [needsTopUp, setNeedsTopUp] = useState(false);
  // The free pack's verification prompt: adds the Settings (or Bank) link
  // under the message.
  const [needsVerify, setNeedsVerify] = useState(verifyPrompt !== null);
  const verifyLink = freePackVerifyLink(freePackMissing);
  // One request refreshes every grid price (60s, visibility-gated), seeded
  // with this route's server snapshot.
  // A Draft keeps its seed: the poll reads the public route, which finds nothing
  // for a draft and would blank the page a minute after it loads.
  const polledDetail = usePackDetailPoll(active.id, detail);
  const liveDetail = active.draft ? detail : polledDetail;
  const [openCard, setOpenCard] = useState<CardSeed | null>(null);
  // A new pack starts clean, as a new page used to: no message about the last
  // pack's balance or verification, no card of it left open.
  const [stateFor, setStateFor] = useState(pack.id);
  if (stateFor !== pack.id) {
    setStateFor(pack.id);
    setOpenError(verifyPrompt);
    setNeedsTopUp(false);
    setNeedsVerify(verifyPrompt !== null);
    setOpenCard(null);
  }
  // A pool card already IS a card seed (one view) — the overlay reads the
  // fields it needs and ignores the rest.
  const toSeed = (c: PackCard): CardSeed => c;
  // Credit balance (A2: opens debit the pack price) — read from the app-shell
  // TopUpProvider (identity-tagged; null = logged out / loading), so this page,
  // the header chip, and the top-up sheet can never disagree.
  // The one-time free welcome pack: no price, no quantity, no batch — the claim
  // pays for exactly ONE open (the backend rejects a batch on this category), so
  // every money/quantity control is removed rather than merely zeroed. Its
  // siblings list is empty (it is not in the catalog), so `active` can never
  // become a different, paid pack.
  const isFreePack = pack.categoryId === FREE_WELCOME_CATEGORY;
  // Pays Lucky Draw tickets: no card to show or sell, so every section below
  // that assumes one goes. The odds panel and Top Hits stay, in ticket amounts.
  const ticketPack = isTicketPack(pack);
  // What this page calls the thing it sells.
  const noun = ticketPack ? 'capsule' : 'pack';
  const Noun = ticketPack ? 'Capsule' : 'Pack';
  // One Piece / sports packs: the prize badges never guess a Pokémon.
  const pokemonPack = isPokemonPack(pack.categoryId);
  // The free pack, reached by someone who cannot claim it — a spent claim OR a
  // failed eligibility read, which the storefront cannot tell apart (hence the
  // neutral copy above; nothing here may assert a past claim). Every gift
  // affordance below turns off together — a half-suppressed state (dock CTA
  // gone, panel copy still promising "nothing charged") reads as a bug, and the
  // promise is the part that is actually false.
  const freeClaimUnavailable = isFreePack && !freePackEligible;

  // Real backend price, never re-parsed from the rounded display string.
  const priceNum = active.priceMyr;

  // Vault packs: packs an admin gifted into this customer's vault apply
  // themselves here, however the player arrived (spec 2026-10-07 §1). Read
  // client-side after mount and only when signed in — the server loader stays
  // customer-free. A failed read shows no gifts here (the spin page says so
  // and offers a Retry before any charge). Never on the free welcome pack.
  // Still reading (giftsPending) or unread (giftsFailed): the price shown may
  // yet drop to a gift, so no credit refusal here (the reel re-reads, offers
  // Retry and re-checks before any charge).
  const {
    held,
    pending: giftsPending,
    failed: giftsFailed,
  } = usePackGifts(isFreePack ? null : (customer?.id ?? null), active.id);
  // Sold out (admin): still listed, but the backend refuses a paid open. Only
  // vault gifts may still open it, so quantity is capped at the gifts held.
  // A Draft card pack can be looked at but not opened: a card open writes pulls
  // into the live feeds, so the backend refuses it. A capsule's spins only reach
  // its own feed, which answers empty while it is a Draft and lists them once it
  // goes Active: nothing marks a spin as a test.
  const previewOnly = active.draft === true && !ticketPack;
  const soldOutPack = active.inStock === false || previewOnly;
  const unavailableLabel = previewOnly ? 'Preview only' : 'Sold out';
  // The reel (openBatch) caps a single open at 3 packs.
  const maxQty = soldOutPack ? Math.min(3, Math.max(1, held)) : 3;
  const qty = Number.isInteger(count)
    ? Math.min(maxQty, Math.max(1, count))
    : 1;
  // Gifts cover rows first; only the rest is paid (gifts → bonus → normal).
  const vaultGifts = giftsUsed(qty, held);
  const paidCost = costAfterGifts(priceNum, qty, held);
  const vaultCost = vaultCostLabel(qty, vaultGifts, priceNum);
  const openLabel = vaultButtonLabel(qty, vaultGifts) ?? `Open ${Noun}`;
  // Nothing this customer holds covers the open: no buy controls at all.
  const soldOut = soldOutPack && vaultGifts < qty;
  // Baked Polycards tiers animate their factory stage (still poster otherwise).
  const heroVideo = factoryVideo(active.displayImage);

  // Top Hits come from the backend prize pool (highest market_value) — the
  // backend is the source of truth, so a missing/empty pool renders an empty
  // state (no mock fallback). Pull Odds are the SECRET-decoupled, statically-
  // published `ODDS` — they never reflect the admin-tuned win rates (see
  // packs.ts / route.ts).

  const setQ = (n: number) => {
    const count = Math.min(maxQty, Math.max(1, n));
    // Replace this history entry so reload, sharing and Back from another
    // pack preserve the chosen quantity without adding an entry per tap.
    const url = new URL(window.location.href);
    url.searchParams.set('count', String(count));
    window.history.replaceState(null, '', url);
  };

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
    () =>
      ticketPack
        ? ticketTopHits(pool)
        : pool.filter((c) => isTopRarity(c.rarity)),
    [ticketPack, pool],
  );

  // What the odds panel sums: card prices, or on a ticket pack the ticket amounts.
  const oddsPool = useMemo(
    () => (ticketPack ? ticketOddsPool(pool) : pool),
    [ticketPack, pool],
  );

  // Card-value range over the FULL pool (not topPool) — one derivation feeding
  // both the odds-panel gate and its range row.
  const valueRange = useMemo(() => poolValueRange(oddsPool), [oddsPool]);

  // Same derivation per rarity, so each published tier row can state what a
  // card of THAT tier is worth here. The pack-wide range above spans Common to
  // Immortal and so describes no tier in particular.
  const tierRanges = useMemo(() => tierValueRanges(oddsPool), [oddsPool]);

  // Expected value of one pull over the PUBLISHED tiers — what the top row of
  // the odds panel states now (the range only ever described the pool's span).
  // The odds are read into a local first: with `liveDetail?.publishedOdds` as a
  // dependency, the React Compiler infers `liveDetail` (a less specific
  // property than the source) and refuses to preserve the memo.
  const publishedOdds = liveDetail?.publishedOdds ?? null;
  const expectedValue = useMemo(
    () =>
      publishedOdds ? poolExpectedValue(oddsPool, publishedOdds.tiers) : null,
    [oddsPool, publishedOdds],
  );

  // What the header states about this pack: franchise, type, language, grading.
  const facts = packFacts(pack);
  // The panel's middle zone, each row's own condition named once.
  const showExplainer = !isFreePack && !ticketPack;
  const showDemo = !customer && pool.length > 0 && !soldOut;
  const showQty = !isFreePack && !soldOut;

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
      setNeedsTopUp(false);
      if (verifyPrompt) {
        setOpenError(verifyPrompt);
        setNeedsVerify(true);
        return;
      }
      setOpenError(null);
      setNeedsVerify(false);
      router.push(`/slots/${active.id}/spin?count=1`);
      return;
    }
    if (
      !giftsPending &&
      !giftsFailed &&
      balance !== null &&
      !affordable(balance, paidCost)
    ) {
      setNeedsTopUp(true);
      setOpenError('Not enough balance to open.');
      return;
    }
    setOpenError(null);
    setNeedsTopUp(false);
    router.push(`/slots/${active.id}/spin?count=${qty}`);
  }

  return (
    // pb clears the mobile sticky buy bar (fixed above the tab bar).
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
                      <Image
                        src={pack.icon}
                        alt=""
                        aria-hidden
                        width={20}
                        height={20}
                        className="h-5 w-5 object-contain"
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

              <div
                className={cn(
                  // Phones read the terms and the guest demo spin BEFORE the
                  // picker, as they did before the redesign: under it the demo
                  // sat a screen further down. Desktop reads choose, terms, open.
                  'order-first flex-col gap-3.5 border-b border-white/10 px-4 py-3 sm:px-5 lg:order-none lg:border-b-0 lg:border-t',
                  // The quantity row is lg-only (phones step in the buy dock), so
                  // with nothing else to say this zone has no phone rendering.
                  showExplainer || showDemo
                    ? 'flex'
                    : showQty
                      ? 'hidden lg:flex'
                      : 'hidden',
                )}
              >
                {showExplainer && (
                  <p className="text-[13px] leading-relaxed text-neutral-400">
                    The pack rate applies during the reveal countdown. Leaving
                    the reveal or letting the timer expire changes buyback to{' '}
                    {FLAT_BUYBACK_PERCENT}% of card value in your vault.
                  </p>
                )}

                {/* Free demo spin — guests only (hidden once logged in; a real
                  account opens real packs). Routes to the slot reel in demo
                  mode: no login, no charge, nothing real won. Neutral ghost
                  styling — buyback green is reserved for money-in actions. */}
                {showDemo && (
                  <Link
                    href={`/slots/${active.id}/spin?demo=1`}
                    className={cn(
                      'group flex min-h-12 items-center justify-between rounded-full bg-white/[0.06] py-1.5 pl-2 pr-1.5 text-sm font-semibold text-white outline-none ring-1 ring-white/10 transition-[background-color,transform] duration-300',
                      SPRING,
                      'hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-white/40 active:scale-[0.99] motion-reduce:transition-[background-color] motion-reduce:active:scale-100',
                    )}
                  >
                    <span className="flex items-center gap-2.5">
                      <span className="flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white">
                        <Play
                          className="ml-0.5 h-3.5 w-3.5 fill-current"
                          aria-hidden
                        />
                      </span>
                      <span className="flex flex-col leading-tight">
                        Try a free demo spin
                        <span className="text-xs font-normal text-neutral-400">
                          No login · nothing charged
                        </span>
                      </span>
                    </span>
                    <ArrowDisc className="bg-white/10 group-hover:-translate-y-px group-hover:translate-x-0.5 group-hover:scale-105 motion-reduce:group-hover:transform-none" />
                  </Link>
                )}

                {/* Quantity — desktop only; on phones it lives in the sticky
                  buy bar so there is a single Open Pack control per zone.
                  Absent on the free pack: the claim buys exactly one open. */}
                <div
                  className={cn(
                    'hidden items-center gap-2',
                    showQty && 'lg:flex',
                  )}
                >
                  <button
                    type="button"
                    aria-label="Decrease quantity"
                    onClick={() => setQ(qty - 1)}
                    disabled={qty <= 1}
                    className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white/[0.06] text-neutral-300 outline-none ring-1 ring-white/10 focus-visible:ring-2 focus-visible:ring-white/40 transition-[background-color,color,transform] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] hover:bg-white/10 hover:text-white active:scale-[0.96] disabled:pointer-events-none disabled:opacity-40 motion-reduce:transition-[background-color,color] motion-reduce:active:scale-100"
                  >
                    <Minus className="h-4 w-4" aria-hidden />
                  </button>
                  <span className="flex h-11 flex-1 items-center justify-center rounded-full bg-white/[0.06] text-sm font-semibold tabular-nums text-white ring-1 ring-white/10">
                    {qty} {qty === 1 ? Noun : `${Noun}s`}
                  </span>
                  <button
                    type="button"
                    aria-label="Increase quantity"
                    onClick={() => setQ(qty + 1)}
                    disabled={qty >= maxQty}
                    className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white/[0.06] text-neutral-300 outline-none ring-1 ring-white/10 focus-visible:ring-2 focus-visible:ring-white/40 transition-[background-color,color,transform] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] hover:bg-white/10 hover:text-white active:scale-[0.96] disabled:pointer-events-none disabled:opacity-40 motion-reduce:transition-[background-color,color] motion-reduce:active:scale-100"
                  >
                    <Plus className="h-4 w-4" aria-hidden />
                  </button>
                  <button
                    type="button"
                    onClick={() => setQ(maxQty)}
                    className="flex h-11 px-3 text-xs font-bold uppercase tracking-wide shrink-0 items-center justify-center rounded-full bg-white/[0.06] text-neutral-400 outline-none ring-1 ring-white/10 focus-visible:ring-2 focus-visible:ring-white/40 transition-[background-color,color,transform] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] hover:bg-white/10 hover:text-white active:scale-[0.96] disabled:pointer-events-none disabled:opacity-40 motion-reduce:transition-[background-color,color] motion-reduce:active:scale-100"
                  >
                    Max
                  </button>
                </div>
              </div>

              {/* Open Pack — desktop panel footer (phones use the sticky bar). Pinned
                to the panel's bottom edge, so it stays in view if the panel
                has to scroll. */}
              <div className="hidden border-t border-white/10 bg-neutral-950 px-4 py-3 lg:sticky lg:bottom-0 lg:block">
                {/* DESIGN.md primary: Paper White pill, Ink text — buyback green
                  is a money-IN signal and never a spend CTA. Money in Nekst.
                  Absent when the claim is unavailable: the open would 4xx, so a
                  primary CTA here is an invitation to a refusal. */}
                {soldOut ? (
                  <Pill
                    variant="secondary"
                    size="lg"
                    disabled
                    className="w-full"
                  >
                    {unavailableLabel}
                  </Pill>
                ) : (
                  !freeClaimUnavailable && (
                    <Pill
                      variant="primary"
                      size="lg"
                      onClick={handleGoToReel}
                      className="group/open w-full justify-between pl-6 pr-2"
                    >
                      {customer
                        ? isFreePack
                          ? 'Open Free Pack'
                          : openLabel
                        : 'Log in to open'}
                      <span className="flex items-center gap-2.5 font-heading text-base tracking-tight tabular-nums">
                        {!isFreePack && (vaultCost ?? rm(priceNum * qty))}
                        <ArrowDisc className="group-hover/open:-translate-y-px group-hover/open:translate-x-0.5 group-hover/open:scale-105 motion-reduce:group-hover/open:transform-none" />
                      </span>
                    </Pill>
                  )
                )}
                {openError && (
                  <p
                    role="alert"
                    className="mt-2 text-center text-xs text-red-300"
                  >
                    {openError}
                    {needsVerify && (
                      <>
                        {' '}
                        <Link
                          href={verifyLink.href}
                          className="font-bold text-white underline underline-offset-2"
                        >
                          {verifyLink.label}
                        </Link>
                      </>
                    )}
                    {needsTopUp && (
                      <>
                        {' '}
                        {balance !== null && paidCost - balance > 0 && (
                          <>You&apos;re {rm(paidCost - balance)} short. </>
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
                    'text-center text-xs text-neutral-400',
                    !freeClaimUnavailable && 'mt-2',
                  )}
                >
                  {freeClaimUnavailable ? (
                    <>{FREE_PACK_UNAVAILABLE_MESSAGE}</>
                  ) : isFreePack ? (
                    <>
                      Your one-time welcome pack — nothing charged. The card
                      lands in your vault. {FREE_PULL_LOCKED_MESSAGE}
                    </>
                  ) : previewOnly ? (
                    <>Draft card packs can be viewed but not opened.</>
                  ) : soldOut ? (
                    <>This {noun} is sold out right now.</>
                  ) : customer && balance !== null ? (
                    <>
                      Each open costs {rm(priceNum)} from your balance — you
                      have{' '}
                      <span
                        className={cn(
                          'font-bold',
                          balance < priceNum
                            ? 'text-red-300'
                            : 'text-neutral-200',
                        )}
                      >
                        {rm(balance)}
                      </span>
                    </>
                  ) : (
                    <>
                      Each open costs the {noun} price from your balance — one{' '}
                      {noun} per open, recorded to your account.
                    </>
                  )}
                </p>
              </div>
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
                // A new pack's row starts at its first card, dialog closed.
                key={active.id}
                rail={topPool}
                full={pool}
                tierChances={liveDetail?.publishedOdds?.tiers ?? null}
                onOpen={(card) => setOpenCard(toSeed(card))}
                pokemon={pokemonPack}
              />
            </Reveal>
          )}
        </div>
      </div>

      {/* ===== Pull Odds, then Recent Pulls (below the fold) =====
          Two full-width boards, each a side column (its heading and headline
          figures) beside its content; on a phone the side column simply comes
          first. The odds board renders ONLY the admin-published rates from the
          backend; a pack with no published odds shows no board at all. Nor does
          a pack whose published odds carry no per-tier rows AND nothing priced:
          that would be a bare heading over an empty box. */}
      <div className="mb-10 mt-14 flex flex-col gap-14 lg:mt-24 lg:gap-24">
        {hasPublishedOddsContent(publishedRows, valueRange) && (
          <Reveal as="section" className="min-w-0">
            <OddsBoard
              heading={
                <SectionHead
                  eyebrow={
                    publishedRows.length > 0
                      ? `${publishedRows.length} ${publishedRows.length === 1 ? 'tier' : 'tiers'}`
                      : undefined
                  }
                  title="Pull Odds (by rarity)"
                />
              }
              odds={publishedRows}
              range={valueRange}
              expectedValue={expectedValue}
              tierRanges={tierRanges}
              tickets={ticketPack}
            />
          </Reveal>
        )}

        {/* Not on a Draft: its ledger isn't public, and the feed proxy answers an
            unlisted slug with the global feed, card pulls under a pack that
            never paid them. */}
        {!active.draft && (
          <Reveal as="section" delay={90} className="min-w-0">
            {/* THIS pack's history — seeded from the server snapshot, then
                polled so anyone's pull shows up here without a reload. A
                switch to a sibling pack brings that pack's own seed. */}
            <PullHistory
              // A new pack's history: its own seed, the tier filter back on All.
              key={active.id}
              variant="board"
              heading={
                <SectionHead
                  eyebrow={
                    <>
                      {/* White dot: live is not a money signal, so no green
                          (Signal Rule). The home feed's LIVE pill, same dot. */}
                      <span
                        aria-hidden
                        className="h-1.5 w-1.5 animate-pulse rounded-full bg-white motion-reduce:animate-none"
                      />
                      Live
                    </>
                  }
                  title="Recent Pulls"
                />
              }
              initial={recentPulls}
              packSlug={active.id}
              // A feed row IS a card seed (one view). Its pokemonDex/spriteImage
              // are null: /store/pulls/recent doesn't send them, so threading
              // them is a backend change, not an omission. The badge falls to
              // name-derivation for a card opened from this feed — visible only
              // on a card whose admin-configured sprite differs from its name.
              onSelect={setOpenCard}
              noun={noun}
            />
          </Reveal>
        )}
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
        {/* A price is never cut short: when it can't fit beside the stepper and
            the pill, the pill takes its own row. The 999 hands the spare width
            of a single row to this block, so the pill only grows once alone. */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-min flex-[999_1_0%]">
            {/* Free mode states the gift where the total normally sits — the
                slot must not go empty, or the pill drifts left and the dock
                reads like a different component. */}
            <p className="whitespace-nowrap font-heading text-xl font-bold leading-none tracking-tight text-white tabular-nums">
              {freeClaimUnavailable
                ? 'Unavailable'
                : isFreePack
                  ? 'Free'
                  : // A vault pack: the long "Vault x1 + RM 300.00" line
                    // would truncate here, so the gifts take the big line
                    // and the paid rows the small one below.
                    vaultGifts > 0
                    ? `Vault x${vaultGifts}`
                    : rm(priceNum * qty)}
            </p>
            <p className="mt-1 text-xs leading-none text-neutral-400">
              {freeClaimUnavailable
                ? 'Not available on this account'
                : isFreePack
                  ? 'Your welcome pack'
                  : soldOut
                    ? 'Not available right now'
                    : vaultGifts > 0
                      ? qty > vaultGifts
                        ? `+ ${rm(paidCost)}`
                        : 'Gift from Polycards'
                      : ticketPack
                        ? 'Lucky Draw tickets'
                        : `${active.buybackPercent ?? FLAT_BUYBACK_PERCENT}% during reveal`}
            </p>
          </div>
          <div
            className={cn(
              'h-11 shrink-0 items-center rounded-full bg-neutral-900',
              isFreePack || soldOut ? 'hidden' : 'flex',
            )}
          >
            <button
              type="button"
              aria-label="Decrease quantity"
              onClick={() => setQ(qty - 1)}
              disabled={qty <= 1}
              className="flex h-11 w-11 items-center justify-center rounded-full text-neutral-300 outline-none focus-visible:ring-2 focus-visible:ring-white/40 transition-[color,transform] hover:text-white active:scale-[0.92] disabled:pointer-events-none disabled:opacity-40 motion-reduce:transition-colors motion-reduce:active:scale-100"
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
              className="flex h-11 w-11 items-center justify-center rounded-full text-neutral-300 outline-none focus-visible:ring-2 focus-visible:ring-white/40 transition-[color,transform] hover:text-white active:scale-[0.92] disabled:pointer-events-none disabled:opacity-40 motion-reduce:transition-colors motion-reduce:active:scale-100"
            >
              <Plus className="h-4 w-4" aria-hidden />
            </button>
          </div>
          {soldOut ? (
            <Pill variant="secondary" size="md" disabled className="px-5">
              {unavailableLabel}
            </Pill>
          ) : (
            !freeClaimUnavailable && (
              <Pill
                variant="primary"
                size="md"
                onClick={handleGoToReel}
                className="shrink-0 grow px-4"
              >
                {customer
                  ? isFreePack
                    ? 'Open Free Pack'
                    : openLabel
                  : 'Log in'}
              </Pill>
            )
          )}
        </div>
        {openError && (
          <p role="alert" className="mt-2 text-center text-xs text-red-300">
            {openError}
            {needsVerify && (
              <>
                {' '}
                <Link
                  href={verifyLink.href}
                  className="font-bold text-white underline underline-offset-2"
                >
                  {verifyLink.label}
                </Link>
              </>
            )}
            {needsTopUp && (
              <>
                {' '}
                {balance !== null && paidCost - balance > 0 && (
                  <>You&apos;re {rm(paidCost - balance)} short. </>
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
        pokemon={pokemonPack}
      />
    </div>
  );
}
