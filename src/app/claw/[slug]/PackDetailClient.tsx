'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  Clock,
  Flame,
  Info,
  Minus,
  Play,
  Plus,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { usd } from '@/lib/format';
import { usePrefersReducedMotion } from '@/lib/use-reveal';
import { useAuth } from '@/components/auth/AuthProvider';
import { openAuth } from '@/components/AuthButton';
import Reveal from '@/components/Reveal';
import type { PackDetail, RecentPull } from '@/lib/data/packs';
import { demoDraw } from '@/lib/demo-spin';
import { openPack } from '@/lib/actions/packs';
import { getCreditBalance, sellBackPull } from '@/lib/actions/vault';
import {
  type Pack,
  type ResolvedPack,
  type PackCard,
  CARD_POOL,
  FLAT_BUYBACK_PERCENT,
  ODDS,
  clawMachine,
  priceNumber,
} from '../packs-data';
import PackOpenOverlay from './PackOpenOverlay';

const RARITY_RING: Record<PackCard['rarity'], string> = {
  Legendary: '234, 179, 8',
  Epic: '217, 70, 239',
  Rare: '56, 189, 248',
  Uncommon: '52, 211, 153',
  Common: '163, 163, 163',
};

function CardThumb({ card, w }: { card: PackCard; w?: number }) {
  return (
    <div className="shrink-0 px-1" style={w ? { width: w } : undefined}>
      <div
        className="overflow-hidden rounded-xl border bg-neutral-900 p-1.5"
        style={{
          borderColor: `rgba(${RARITY_RING[card.rarity]},0.55)`,
          boxShadow: `0 0 16px -8px rgba(${RARITY_RING[card.rarity]},0.6)`,
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={card.image}
          alt={card.name}
          loading="lazy"
          className="aspect-[3/4] w-full rounded-md object-contain"
        />
      </div>
    </div>
  );
}

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
  const reduced = usePrefersReducedMotion();
  const { customer } = useAuth();
  const [active, setActive] = useState<Pack>(pack);
  const [qty, setQty] = useState(1);
  // `opening` guards the async server round-trip; `openError` surfaces a friendly
  // failure inline (`needsTopUp` adds the top-up link for credit shortfalls).
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const [needsTopUp, setNeedsTopUp] = useState(false);
  // Credit balance (A2: opens debit the pack price). Null = logged out or the
  // read failed — render nothing rather than a wrong $0. Refreshed after each
  // open from the open response itself; sell-backs in the overlay also report
  // a fresh balance via their own result.
  const [balance, setBalance] = useState<number | null>(null);
  useEffect(() => {
    if (!customer) {
      setBalance(null);
      return;
    }
    let cancelled = false;
    getCreditBalance().then((b) => {
      if (!cancelled) setBalance(b);
    });
    return () => {
      cancelled = true;
    };
  }, [customer]);
  // Live Recent Pulls: seeded from the server snapshot, then optimistically
  // prepended on each successful open so the feed reflects this session's pulls
  // without a navigation round-trip.
  const [recent, setRecent] = useState<RecentPull[]>(recentPulls);
  // The pack-opening reveal overlay — non-null while showing the won/demo card.
  // `nonce` keys the overlay so "Open another" remounts it and re-runs the burst.
  // pullId/marketValue drive the instant sell-back offer (null for demo spins);
  // openedAt (ms epoch, when the open call resolved) caps the offer so a user
  // who lingers on the pre-card stages can't see a quote the server window no
  // longer honors.
  const [reveal, setReveal] = useState<{
    card: PackCard;
    isReal: boolean;
    nonce: number;
    pullId: string | null;
    marketValue: number | null;
    openedAt: number | null;
  } | null>(null);

  const claw = clawMachine(active);
  const priceNum = priceNumber(active.price);
  // Expected value ≈ price, lifted slightly for boosted tiers (mock).
  const ev = Math.round(priceNum * (active.boost ? 1.02 : 0.96));
  const points = priceNum * 100 * qty;

  // Top Hits come from the backend prize pool (highest market_value). In 5a the
  // pool is pool-wide (identical across packs), so it applies regardless of the
  // selected sibling; it falls back to the static mock pool when the backend is
  // down. Pull Odds are the SECRET-decoupled, statically-published `ODDS` — they
  // never reflect the admin-tuned win rates (see packs.ts / route.ts).
  const mockTopHits = useMemo(
    () =>
      [...CARD_POOL]
        .sort((a, b) => priceNumber(b.value) - priceNumber(a.value))
        .slice(0, 5),
    [],
  );
  const topHits = detail?.topHits ?? mockTopHits;

  const setQ = (n: number) => setQty(Math.min(99, Math.max(1, n)));

  // Free demo spin — a client-side WEIGHTED sample over the published odds
  // drives the same reveal overlay. Pure theater: no backend call, no Pull row,
  // no credit/stock effects; the real open below stays auth-gated. Draws from
  // the live public pool when the backend supplied one, else the static mock.
  function demoSpin() {
    if (opening) return;
    setOpenError(null);
    const pool = detail && detail.pool.length > 0 ? detail.pool : CARD_POOL;
    const mock = demoDraw(pool, ODDS, Math.random(), Math.random());
    if (!mock) return;
    setReveal({
      card: mock,
      isReal: false,
      nonce: Date.now(),
      pullId: null,
      marketValue: null,
      openedAt: null,
    });
  }

  // Real open — auth-gated. Awaits the server action (the customer id is derived
  // from the token server-side, never sent), then reveals the actual won card.
  // Logged-out users get the login modal instead of a call.
  async function handleOpenPack() {
    if (opening) return;
    if (!customer) {
      openAuth('login');
      return;
    }
    setOpenError(null);
    setNeedsTopUp(false);
    setOpening(true);
    try {
      const res = await openPack(active.id);
      if (!res.ok) {
        if (res.needsAuth) openAuth('login');
        else {
          setOpenError(res.error);
          setNeedsTopUp(res.needsTopUp === true);
        }
        return;
      }
      if (res.balance !== null) setBalance(res.balance);
      setReveal({
        card: res.card,
        isReal: true,
        nonce: Date.now(),
        pullId: res.pullId,
        marketValue: res.marketValue,
        openedAt: Date.now(),
      });
      const justPulled: RecentPull = {
        id: `${res.card.id}-${Date.now()}`,
        name: res.card.name,
        image: res.card.image,
        value: res.card.value,
        rarity: res.card.rarity,
        packName: active.name,
        packIcon: active.image,
        agoLabel: 'just now',
      };
      setRecent((prev) => [justPulled, ...prev].slice(0, 12));
    } finally {
      setOpening(false);
    }
  }

  function reset() {
    setReveal(null);
    setOpenError(null);
    setNeedsTopUp(false);
  }

  return (
    <div className="mx-auto w-full px-fluid py-4">
      {/* Back link */}
      <Link
        href="/claw"
        className="mb-4 inline-flex items-center gap-1.5 text-[13px] font-medium text-white/55 transition-colors hover:text-white"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />
        All packs
      </Link>

      {/* ===== MAIN: claw machine (left) + configurator (right) ===== */}
      <div className="grid items-start gap-6 lg:grid-cols-[1.55fr_1fr]">
        {/* ---- LEFT column ---- */}
        <div className="flex flex-col gap-6">
          {/* Claw machine stage */}
          <div className="relative flex aspect-[36/25] items-center justify-center overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-b from-zinc-200 to-zinc-400">
            {active.boost && (
              <span className="absolute left-4 top-4 z-20 rounded-md bg-emerald-500 px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-white shadow-sm">
                +90% Buyback Boost
              </span>
            )}
            {/* Claw-machine render. Like the live site this is an ANIMATED AVIF (the claw slides
                left↔right INSIDE the file) rendered in a FIXED <img> — no whole-image float. The full
                Pokenic rebrand is baked frame-by-frame into the asset: the banner wordmark, the
                placard ("pokenic claw.") and the base url ("pokenic.com"). Packs without an animated
                source fall back to the static rebranded webp. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              key={active.id}
              src={claw.anim ?? claw.webp}
              alt={`${active.name} claw machine`}
              className="relative z-10 h-full w-full object-contain"
            />
          </div>

          {/* Top Hits */}
          <Reveal as="section">
            <div className="mb-1 flex items-center gap-2">
              <Flame className="h-4 w-4 text-amber-400" aria-hidden />
              <h2 className="font-heading text-lg font-bold tracking-tight text-white">
                Top Hits
              </h2>
            </div>
            <p className="mb-3 text-[13px] text-white/45">
              The top items available in this pack.
            </p>
            <div className="grid grid-cols-3 gap-3 sm:grid-cols-5">
              {topHits.map((c) => (
                <div key={c.id} className="flex flex-col gap-1.5">
                  <CardThumb card={c} />
                  <p
                    className="truncate text-center text-[11px] font-medium text-white/70"
                    title={c.name}
                  >
                    {c.value}
                  </p>
                </div>
              ))}
            </div>
          </Reveal>
        </div>

        {/* ---- RIGHT column: configurator ---- */}
        <aside className="lg:sticky lg:top-20">
          <div className="flex max-h-[calc(100vh-6rem)] flex-col overflow-hidden rounded-2xl border border-white/10 bg-neutral-950">
            {/* Title + buyback */}
            <div className="flex items-center justify-between gap-3 border-b border-white/10 px-5 py-4">
              <h1 className="font-heading text-xl font-bold tracking-tight text-white sm:text-2xl">
                {active.name}
              </h1>
              <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-500/90 px-2.5 py-1 text-[11px] font-bold text-white">
                {active.buybackPercent ?? 90}% Buyback
                <Info className="h-3 w-3 opacity-80" aria-hidden />
              </span>
            </div>

            <div className="flex flex-col gap-5 overflow-y-auto px-5 py-5">
              {/* Category */}
              <div>
                <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-white/40">
                  Category
                </p>
                <div className="flex h-11 items-center justify-between rounded-xl border border-white/10 bg-white/5 px-3 text-sm text-white">
                  <span className="flex items-center gap-2">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={pack.icon}
                      alt=""
                      aria-hidden
                      className="h-5 w-5 object-contain"
                    />
                    {pack.categoryName}
                  </span>
                  <ChevronDown className="h-4 w-4 text-white/40" aria-hidden />
                </div>
              </div>

              {/* Pack tiles */}
              <div>
                <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-white/40">
                  Pack
                </p>
                <div className="grid grid-cols-2 gap-2">
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
                          'flex flex-col items-center gap-1 rounded-xl border px-2 py-2.5 text-center transition-colors',
                          selected
                            ? 'border-white/40 bg-white/10'
                            : 'border-white/10 bg-white/[0.03] hover:border-white/20 hover:bg-white/[0.06]',
                        )}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={p.image}
                          alt=""
                          aria-hidden
                          className="h-10 w-auto object-contain"
                        />
                        <span className="text-[11px] font-medium leading-tight text-white">
                          {p.name.replace(' Pack', '')}
                        </span>
                        <span className="text-[11px] font-semibold text-white/55">
                          {p.price}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Expected value */}
              <div className="flex items-center justify-between rounded-xl border border-white/10 bg-white/[0.03] px-3.5 py-3">
                <span className="flex items-center gap-1.5 text-[13px] font-medium text-white/70">
                  Expected Value
                  <Info className="h-3.5 w-3.5 text-white/30" aria-hidden />
                </span>
                <span className="text-sm font-semibold text-white">
                  ${ev.toLocaleString('en-US')}
                  <span className="ml-1 text-[11px] font-normal text-white/40">
                    per pack
                  </span>
                </span>
              </div>

              {/* Demo spin */}
              <button
                type="button"
                onClick={demoSpin}
                disabled={opening}
                className="flex h-11 items-center justify-between rounded-xl border border-emerald-400/30 bg-emerald-500/10 px-4 text-sm font-medium text-emerald-200 transition-colors hover:bg-emerald-500/20 disabled:opacity-60"
              >
                <span className="flex items-center gap-2">
                  <Play className="h-4 w-4 fill-current" aria-hidden />
                  Try a free demo spin
                </span>
                <ArrowRight className="h-4 w-4" aria-hidden />
              </button>

              {/* Quantity */}
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  aria-label="Decrease quantity"
                  onClick={() => setQ(qty - 1)}
                  disabled={qty <= 1}
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/5 text-white/70 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-40"
                >
                  <Minus className="h-4 w-4" aria-hidden />
                </button>
                <span className="flex h-10 flex-1 items-center justify-center rounded-xl border border-white/10 bg-white/[0.03] text-sm font-medium tabular-nums text-white">
                  {qty} {qty === 1 ? 'Pack' : 'Packs'}
                </span>
                <button
                  type="button"
                  aria-label="Increase quantity"
                  onClick={() => setQ(qty + 1)}
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/5 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
                >
                  <Plus className="h-4 w-4" aria-hidden />
                </button>
                <button
                  type="button"
                  onClick={() => setQ(99)}
                  className="flex h-10 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/5 px-3 text-[12px] font-bold uppercase tracking-wide text-white/60 transition-colors hover:bg-white/10 hover:text-white"
                >
                  Max
                </button>
              </div>
            </div>

            {/* Open Pack — sticky footer of the panel */}
            <div className="border-t border-white/10 p-4">
              <button
                type="button"
                onClick={handleOpenPack}
                disabled={opening}
                className="flex h-12 w-full items-center justify-between rounded-xl bg-gradient-to-r from-emerald-500 to-green-500 px-5 text-sm font-bold text-white shadow-lg shadow-emerald-900/30 transition-opacity hover:opacity-95 disabled:opacity-60"
              >
                <span className="flex items-center gap-2">
                  {opening
                    ? 'Opening…'
                    : customer
                      ? 'Open Pack'
                      : 'Log in to open'}
                  <span className="rounded-md bg-black/20 px-1.5 py-0.5 text-[11px] font-semibold">
                    +{points.toLocaleString('en-US')} pts
                  </span>
                </span>
                <span className="flex items-center gap-1.5">
                  ${(priceNum * qty).toLocaleString('en-US')}
                  <ArrowRight className="h-4 w-4" aria-hidden />
                </span>
              </button>
              {openError && (
                <p
                  role="alert"
                  className="mt-2 text-center text-[11px] text-red-300"
                >
                  {openError}
                  {needsTopUp && (
                    <>
                      {' '}
                      <Link
                        href="/vault"
                        className="font-bold text-emerald-300 underline underline-offset-2 hover:text-emerald-200"
                      >
                        Add credits in your Vault →
                      </Link>
                    </>
                  )}
                </p>
              )}
              {/* The quantity selector + total are the live site's purchase framing
                  (cosmetic in this preview); a real open rolls ONE pack and debits
                  its price from the credit balance (A2). Quantity & provably-fair
                  pulls stay out of scope. */}
              <p className="mt-2 text-center text-[11px] text-white/35">
                {customer && balance !== null ? (
                  <>
                    Each open costs {usd(priceNum)} in site credits — your
                    balance:{' '}
                    <span
                      className={cn(
                        'font-bold',
                        balance < priceNum ? 'text-red-300' : 'text-white/70',
                      )}
                    >
                      {usd(balance)}
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
      </div>

      {/* ===== Pull Odds + Recent Pulls (below the fold) ===== */}
      <div className="mb-10 mt-8 grid gap-6 lg:grid-cols-2">
        <Reveal as="section" className="h-full min-w-0">
          <div className="mb-3 flex items-center gap-2">
            <h2 className="font-heading text-lg font-bold tracking-tight text-white">
              Pull Odds (by rarity)
            </h2>
          </div>
          <ul className="overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03]">
            {ODDS.map((o) => (
              <li
                key={o.rarity}
                className="flex items-center justify-between border-b border-white/5 px-4 py-3 last:border-b-0"
              >
                <span className="flex items-center gap-2.5 text-[13px] font-medium text-white">
                  <span className={cn('h-2.5 w-2.5 rounded-full', o.dot)} />
                  {o.rarity}
                </span>
                <span className="text-[13px] tabular-nums text-white/55">
                  {o.chance}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-2 px-1 text-[11px] text-white/35">
            Indicative odds — final rates are published by the backend.
          </p>
        </Reveal>

        <Reveal as="section" delay={90} className="h-full min-w-0">
          <div className="mb-3 flex items-center gap-2">
            <Clock className="h-4 w-4 text-white/50" aria-hidden />
            <h2 className="font-heading text-lg font-bold tracking-tight text-white">
              Recent Pulls
            </h2>
          </div>
          <ul className="divide-y divide-white/5 overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03]">
            {recent.length === 0 ? (
              <li className="px-4 py-8 text-center text-[13px] text-white/40">
                No pulls yet — be the first to open a pack.
              </li>
            ) : (
              recent.map((c) => (
                <li key={c.id} className="flex items-center gap-3 px-4 py-2.5">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={c.image}
                    alt=""
                    className="h-10 w-8 shrink-0 rounded object-contain"
                  />
                  <span className="min-w-0 flex-1 truncate text-[13px] text-white/80">
                    {c.name}
                  </span>
                  <span className="shrink-0 text-[12px] tabular-nums text-white/45">
                    {c.value}
                  </span>
                  <span className="hidden shrink-0 text-[11px] text-white/35 sm:inline">
                    {c.agoLabel}
                  </span>
                </li>
              ))
            )}
          </ul>
        </Reveal>
      </div>

      {reveal && (
        <PackOpenOverlay
          key={reveal.nonce}
          card={reveal.card}
          isReal={reveal.isReal}
          packImage={active.image}
          packName={active.name}
          category={pack.categoryName}
          opening={opening}
          reduced={reduced}
          buyback={
            reveal.pullId !== null && reveal.marketValue !== null
              ? {
                  pullId: reveal.pullId,
                  percent: active.buybackPercent ?? FLAT_BUYBACK_PERCENT,
                  amount:
                    Math.round(
                      reveal.marketValue *
                        (active.buybackPercent ?? FLAT_BUYBACK_PERCENT),
                    ) / 100,
                  // Sells from the vault always pay the site-wide flat rate,
                  // never a per-pack one (matches the server's FLAT_PERCENT).
                  vaultPercent: FLAT_BUYBACK_PERCENT,
                  openedAtMs: reveal.openedAt ?? Date.now(),
                }
              : null
          }
          onSellBack={sellBackPull}
          onClose={() => setReveal(null)}
          // Demo reveals re-run the demo; only real reveals re-open for real.
          onOpenAnother={reveal.isReal ? handleOpenPack : demoSpin}
          // Anonymous demo spins swap keep/sell for the sign-up conversion CTA.
          onSignUp={
            !reveal.isReal && !customer ? () => openAuth('signup') : null
          }
        />
      )}
    </div>
  );
}
