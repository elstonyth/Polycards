'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import {
  ArrowLeft,
  ArrowRight,
  Clock,
  Flame,
  Info,
  Minus,
  Play,
  Plus,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { rm, rm0 } from '@/lib/format';
import { useAuth } from '@/components/auth/AuthProvider';
import { openAuth } from '@/components/AuthButton';
import Reveal from '@/components/Reveal';
import type { PackDetail, RecentPull } from '@/lib/data/packs';
import {
  type Pack,
  type ResolvedPack,
  type PackCard,
  FLAT_BUYBACK_PERCENT,
  priceNumber,
} from '@/lib/packs-data';
import { Pill } from '@/components/ui/pill';
import { PublishedOddsList } from './OddsSheet';
import { PoolByRarity } from './PoolByRarity';
import { publishedOddsRows } from '@/lib/packs-format';
import { useLiveRecentPulls } from '@/lib/use-recent-pulls';
import { useTopUp } from '@/components/app-shell/TopUpProvider';
import { CardTile } from '@/components/cards/CardTile';
import {
  CardDetailOverlay,
  type CardSeed,
} from '@/components/cards/CardDetailOverlay';
import { usePackDetailPoll } from '@/lib/use-pack-detail-poll';
import { SlabImage } from '@/components/SlabImage';

export default function PackDetailClient({
  pack,
  siblings,
  detail,
  recentPulls,
}: {
  pack: ResolvedPack;
  siblings: Pack[];
  /** Backend gacha pool (Top Hits + Pull Odds); null when the backend is down. */
  detail: PackDetail | null;
  /** Live pull ledger feed; empty array when there are no pulls / backend down. */
  recentPulls: RecentPull[];
}) {
  const { customer } = useAuth();
  const { balance, openTopUp } = useTopUp();
  const router = useRouter();
  const [active, setActive] = useState<Pack>(pack);
  const [qty, setQty] = useState(1);
  // `openError` surfaces a friendly failure inline (`needsTopUp` adds the
  // top-up entry for credit shortfalls). Real opens happen on the reel, so
  // there is no in-place async open state here.
  const [openError, setOpenError] = useState<string | null>(null);
  const [needsTopUp, setNeedsTopUp] = useState(false);
  // One request refreshes every grid price (60s, visibility-gated).
  const liveDetail = usePackDetailPoll(active.id, detail) ?? detail;
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
  // Live Recent Pulls — seeded from the server snapshot, then polled (~4s)
  // so anyone's pull shows up here without a reload.
  const recent = useLiveRecentPulls(recentPulls);

  const priceNum = priceNumber(active.price);

  // Top Hits come from the backend prize pool (highest market_value) — the
  // backend is the source of truth, so a missing/empty pool renders an empty
  // state (no mock fallback). Pull Odds are the SECRET-decoupled, statically-
  // published `ODDS` — they never reflect the admin-tuned win rates (see
  // packs.ts / route.ts).
  const topHits = liveDetail?.topHits ?? [];

  // The reel (openBatch) caps a single open at 3 packs.
  const maxQty = 3;
  const setQ = (n: number) => setQty(Math.min(maxQty, Math.max(1, n)));

  // The admin-PUBLISHED odds — the ONLY rates players see. Null (unset) hides
  // the whole Pull Odds panel.
  const publishedRows = liveDetail?.publishedOdds
    ? publishedOddsRows(liveDetail.publishedOdds)
    : null;

  // The full public prize pool (value-sorted) — feeds the "Cards in this
  // pack" grid AND gates the guest demo-spin CTA (pure theater on the reel,
  // /spin?demo=1 — no charge, nothing won).
  const pool = liveDetail?.pool ?? [];

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
    if (balance !== null && balance < priceNum * qty) {
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
          {/* The whole configurator fits without an internal scrollbar (like the
              live site): compact 3-col pack grid, no max-height clamp — on
              mobile the page itself scrolls, on desktop it fits the viewport. */}
          <div className="flex flex-col overflow-hidden rounded-2xl border border-white/10 bg-neutral-950">
            {/* Title + buyback */}
            <div className="flex items-center justify-between gap-3 border-b border-white/10 px-5 py-4">
              <h1 className="font-heading text-xl font-bold tracking-tight text-white sm:text-2xl">
                {active.name}
              </h1>
              <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-buyback/90 px-2.5 py-1 text-[11px] font-bold text-white">
                {active.buybackPercent ?? 90}% Buyback
                <Info className="h-3 w-3 opacity-80" aria-hidden />
              </span>
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

              {/* Pack tiles */}
              <div>
                <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-white/60">
                  Pack
                </p>
                {/* Compact 3-col grid so all tiers fit on screen at once — the
                    selector must never scroll inside the panel. */}
                <div className="grid grid-cols-3 gap-1.5">
                  {siblings.map((p) => {
                    const selected = p.id === active.id;
                    return (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => {
                          setActive(p);
                          reset();
                        }}
                        className={cn(
                          'flex flex-col items-center gap-0.5 rounded-xl border px-1 py-2 text-center transition-colors',
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
              </div>

              {/* Quantity — desktop only; on phones it lives in the sticky
                  buy bar so there is a single Open Pack control per zone. */}
              <div className="hidden items-center gap-2 lg:flex">
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
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/5 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
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
                  is a money-IN signal and never a spend CTA. Money in Nekst. */}
              <Pill
                variant="primary"
                size="lg"
                onClick={handleGoToReel}
                className="w-full justify-between px-5"
              >
                {customer ? 'Open Pack' : 'Log in to open'}
                <span className="flex items-center gap-1.5 font-heading text-base tracking-tight tabular-nums">
                  {rm0(priceNum * qty)}
                  <ArrowRight className="h-4 w-4" aria-hidden />
                </span>
              </Pill>
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
              <p className="mt-2 text-center text-[11px] text-white/60">
                {customer && balance !== null ? (
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
          {/* Top Hits — admin-ordered (1 = leftmost). Hidden entirely when the
              admin picked none: an un-curated pack must not fake a curated
              section (the old fallback showed the 5 highest-value cards). */}
          {topHits.length > 0 && (
            <Reveal as="section">
              <div className="mb-1 flex items-center gap-2">
                <Flame className="h-4 w-4 text-chase" aria-hidden />
                <h2 className="font-heading text-lg font-bold tracking-tight text-white">
                  Top Hits
                </h2>
              </div>
              <p className="mb-3 text-[13px] text-white/70">
                The top items available in this pack.
              </p>
              <div className="grid grid-cols-3 gap-3 sm:grid-cols-5">
                {topHits.map((c) => (
                  <CardTile
                    key={c.id}
                    card={c}
                    onOpen={(card) => setOpenCard(toSeed(card))}
                  />
                ))}
              </div>
            </Reveal>
          )}

          {/* All cards in this pack — the full public prize pool as rarity
              shelves (rarest first, per-tier pull chance when published, each
              tier one swipeable rail so big pools stay one row per tier). */}
          {pool.length > 0 && (
            <Reveal as="section">
              <h2 className="mb-1 font-heading text-lg font-bold tracking-tight text-white">
                Cards in this pack
              </h2>
              <p className="mb-3 text-[13px] text-white/70">
                Every card and its current market price, rarest first.
              </p>
              <PoolByRarity
                pool={pool}
                tierChances={liveDetail?.publishedOdds?.tiers ?? null}
                onOpen={(card) => setOpenCard(toSeed(card))}
              />
            </Reveal>
          )}
        </div>
      </div>

      {/* ===== Pull Odds + Recent Pulls (below the fold) =====
          The odds panel renders ONLY the admin-published rates from the
          backend; a pack with no published odds shows no panel at all. */}
      <div className="mb-10 mt-8 grid gap-6 lg:grid-cols-2">
        {liveDetail?.publishedOdds && publishedRows && (
          <Reveal as="section" className="h-full min-w-0">
            <div className="mb-3 flex items-center gap-2">
              <h2 className="font-heading text-lg font-bold tracking-tight text-white">
                Pull Odds (by rarity)
              </h2>
            </div>
            <PublishedOddsList
              odds={publishedRows}
              overall={liveDetail.publishedOdds.overall}
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
      <div className="fixed inset-x-0 bottom-[calc(4rem+env(safe-area-inset-bottom))] z-40 border-t border-white/10 bg-neutral-950 px-fluid py-2.5 lg:hidden">
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="truncate font-heading text-xl font-bold leading-none tracking-tight text-white tabular-nums">
              {rm0(priceNum * qty)}
            </p>
            <p className="mt-1 text-[11px] leading-none text-white/60">
              {active.buybackPercent ?? FLAT_BUYBACK_PERCENT}% buyback
            </p>
          </div>
          <div className="flex h-11 shrink-0 items-center rounded-full bg-white/5">
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
              className="flex h-11 w-10 items-center justify-center rounded-full text-white/70 transition-colors hover:text-white"
            >
              <Plus className="h-4 w-4" aria-hidden />
            </button>
          </div>
          <Pill
            variant="primary"
            size="md"
            onClick={handleGoToReel}
            className="shrink-0 px-5"
          >
            {customer ? 'Open Pack' : 'Log in'}
          </Pill>
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
