// src/app/slots/[slug]/SlotMachineClient.tsx
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { ArrowLeft } from 'lucide-react';
import { usePrefersReducedMotion } from '@/lib/use-reveal';
import { useChromeInert } from '@/lib/use-chrome-inert';
import { useAuth } from '@/components/auth/AuthProvider';
import { openAuth } from '@/components/AuthButton';
import { openBatch, revealPull } from '@/lib/actions/packs';
import type { WonCard } from '@/lib/actions/packs';
import { getCreditBalance, sellBackPull } from '@/lib/actions/vault';
import { useTopUp } from '@/components/app-shell/TopUpProvider';
import { useSound } from '@/lib/use-sound';
import { rm } from '@/lib/format';
import {
  type ResolvedPack,
  type Pack,
  FLAT_BUYBACK_PERCENT,
  priceNumber,
} from '@/lib/packs-data';
import type { RecentPull } from '@/lib/data/packs';
import { BASE_SPIN_MS } from '@/lib/reel';
import { priceTier, TIER_COLOR, type Tier } from '@/lib/price-tier';
import { resolveCardPokemon } from '@/lib/resolve-card-pokemon';
import { SlotReelStack, type ColumnWinner } from './SlotReelStack';
import { SlotStatusBar } from './SlotStatusBar';
import { SlotControls } from './SlotControls';
import { OddsSheet } from './OddsSheet';
import { SellBackPanel, type SellBackOffer } from '@/components/SellBackPanel';

const COOLDOWN_MS = 600;

// Neutral reel cell for a won card with no resolvable Pokémon (trainer/energy):
// a classic Poké Ball. Keeps the reel sprite-themed and never reveals the prize.
const POKEBALL_PLACEHOLDER =
  'data:image/svg+xml,' +
  encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><circle cx='50' cy='50' r='46' fill='#f5f5f5' stroke='#171717' stroke-width='4'/><path d='M5 50a45 45 0 0 1 90 0Z' fill='#ef4444'/><rect x='4' y='46' width='92' height='8' fill='#171717'/><circle cx='50' cy='50' r='13' fill='#f5f5f5' stroke='#171717' stroke-width='4'/></svg>",
  );

type Phase = 'idle' | 'resolving' | 'spinning' | 'landed';

export default function SlotMachineClient({
  pack,
  recentPulls,
  count,
}: {
  pack: ResolvedPack & Pack;
  recentPulls: RecentPull[];
  count: number;
}) {
  const reduced = usePrefersReducedMotion();
  // Immersive surface: chrome inert + body scroll locked the whole time mounted.
  useChromeInert(true);
  const { customer } = useAuth();
  const { muted, toggleMuted, play, vibrate } = useSound();

  const cost = priceNumber(pack.price);
  // Shrink the cell so multiple reels fit across the viewport.
  const cellSize = count > 1 ? 76 : 96;

  // Mirror every server-returned balance into the app-shell provider so the
  // header chip / top-up sheet / detail-page affordability never go stale
  // after reel spends or sell-backs (review finding).
  const { applyBalance } = useTopUp();
  const [balance, setBalance] = useState<number | null>(null);
  const [recent, setRecent] = useState<RecentPull[]>(recentPulls);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [needsTopUp, setNeedsTopUp] = useState(false);
  const [oddsOpen, setOddsOpen] = useState(false);
  const [cooldown, setCooldown] = useState(false);

  // Won results + a nonce that remounts the reel stack to re-spin.
  const [spin, setSpin] = useState<{
    nonce: number;
    cards: WonCard[];
    winners: ColumnWinner[];
    tiers: Tier[];
  } | null>(null);
  // Held until the reel settles (spoiler guard). Carries the won cards too, so
  // handleSettled reads the result from this ref (always current) instead of
  // closing over `spin` — the callback stays stable and double-fire-safe.
  const pending = useRef<{
    balance: number | null;
    offers: (SellBackOffer | null)[];
    cards: WonCard[];
  } | null>(null);
  const [offers, setOffers] = useState<(SellBackOffer | null)[]>([]);
  const [announce, setAnnounce] = useState('');
  const cooldownTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (cooldownTimer.current !== null) clearTimeout(cooldownTimer.current);
    },
    [],
  );

  // Load balance on mount / auth change.
  useEffect(() => {
    if (!customer) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setBalance(null);
      return;
    }
    let cancelled = false;
    getCreditBalance()
      .then((b) => {
        if (!cancelled) setBalance(b);
      })
      .catch(() => {
        if (!cancelled) setBalance(null);
      });
    return () => {
      cancelled = true;
    };
  }, [customer]);

  const canAfford = balance !== null && balance >= cost * count;
  const spinGuarded = phase === 'resolving' || phase === 'spinning';

  async function handleSpin() {
    if (spinGuarded) return;
    if (!customer) {
      openAuth('login');
      return;
    }
    if (balance !== null && balance < cost * count) {
      setNeedsTopUp(true);
      setError('Not enough credits to spin.');
      return;
    }
    setError(null);
    setNeedsTopUp(false);
    setOffers([]);
    setAnnounce('');
    setPhase('resolving');
    play('spin');

    const res = await openBatch(pack.id, count);
    if (!res.ok) {
      if (res.needsAuth) openAuth('login');
      else {
        setError(res.error);
        setNeedsTopUp(res.needsTopUp === true);
      }
      setPhase('idle');
      return;
    }

    // Build (but don't yet apply) the post-spin state — spoiler guard.
    // One entry per roll.
    const builtOffers: (SellBackOffer | null)[] = [];
    const winners: ColumnWinner[] = [];
    const cards: WonCard[] = [];
    const tiers: Tier[] = [];

    for (const roll of res.rolls) {
      // Build the sell-back offer for this roll.
      const builtOffer: SellBackOffer | null =
        roll.pullId !== null
          ? {
              pullId: roll.pullId,
              fmv: roll.marketValue,
              cardName: roll.card.name,
              image: roll.card.image,
              percent: roll.buyback?.percent ?? FLAT_BUYBACK_PERCENT,
              amount:
                roll.buyback?.amount ??
                Math.round(roll.marketValue * FLAT_BUYBACK_PERCENT) / 100,
              vaultPercent: roll.buyback?.vaultPercent ?? FLAT_BUYBACK_PERCENT,
              vaultAmount:
                roll.buyback?.vaultAmount ??
                Math.round(roll.marketValue * FLAT_BUYBACK_PERCENT) / 100,
              instantDeadlineMs:
                roll.buyback?.instantDeadlineMs ?? Date.now() + 30_000,
            }
          : null;
      builtOffers.push(builtOffer);

      // Cosmetic mapping (decides nothing): tier color + winner Pokémon.
      const tier = priceTier(roll.marketValue);
      const r = resolveCardPokemon(roll.card);
      const custom =
        roll.card.sprite_image && roll.card.sprite_image.trim() !== ''
          ? roll.card.sprite_image
          : null;
      winners.push({
        dex: r.dex,
        // Custom sprite wins; an explicit/derived dex lets the column draw the
        // gif (image undefined); otherwise the neutral Poké Ball.
        image: custom ?? (r.dex === null ? POKEBALL_PLACEHOLDER : undefined),
        name: r.name ?? roll.card.name,
        tier,
      });
      cards.push(roll.card);
      tiers.push(tier);
    }

    pending.current = { balance: res.balance, offers: builtOffers, cards };
    setSpin({ nonce: Date.now(), cards, winners, tiers });
    setPhase('spinning');
  }

  // Fired by the stack once the last column settles. Reads the result from the
  // pending ref (not `spin`), so the callback is stable across re-renders and a
  // second fire is a no-op (held is nulled after the first).
  const handleSettled = useCallback(() => {
    const held = pending.current;
    if (!held) return;
    pending.current = null;

    if (held.balance != null) {
      setBalance(held.balance);
      applyBalance(held.balance);
    }
    setOffers(held.offers);

    // Prepend one RecentPull per card won in this batch.
    const now = Date.now();
    const justPulled: RecentPull[] = held.cards.map((won, i) => ({
      id: `${won.id}-${now}-${i}`,
      name: won.name,
      image: won.image,
      value: won.marketPriceMyr != null ? rm(won.marketPriceMyr) : won.value,
      rarity: won.rarity,
      packName: pack.name,
      packIcon: pack.image,
      agoLabel: 'just now',
    }));
    setRecent((prev) => [...justPulled, ...prev].slice(0, 12));

    const big = held.cards.some(
      (c) => c.rarity === 'Epic' || c.rarity === 'Legendary',
    );
    play(big ? 'bigwin' : 'win');
    vibrate(big ? [40, 40, 80] : 30);

    const first = held.cards[0];
    if (held.cards.length === 1 && first) {
      const firstValue =
        first.marketPriceMyr != null ? rm(first.marketPriceMyr) : first.value;
      setAnnounce(`Won ${first.name}, ${firstValue}`);
    } else {
      setAnnounce(`Won ${held.cards.length} cards`);
    }
    setPhase('landed');

    setCooldown(true);
    if (cooldownTimer.current !== null) clearTimeout(cooldownTimer.current);
    cooldownTimer.current = window.setTimeout(
      () => setCooldown(false),
      COOLDOWN_MS,
    );
  }, [pack.name, pack.image, play, vibrate, applyBalance]);

  const refreshBalance = useCallback(
    (b: number) => {
      setBalance(b);
      applyBalance(b);
    },
    [applyBalance],
  );

  const wonCards = phase === 'landed' ? (spin?.cards ?? []) : [];
  // For single-card banner: use the first card's tier.
  const firstTier = spin?.tiers[0] ?? null;
  const firstRgb =
    wonCards.length === 1 && firstTier ? TIER_COLOR[firstTier] : null;

  return (
    <div className="fixed inset-0 z-[100] flex flex-col bg-neutral-950 text-neutral-50">
      {/* Top bar */}
      <div className="flex items-center justify-between gap-4 px-fluid py-4">
        <Link
          href={`/slots/${pack.id}`}
          className="inline-flex items-center gap-1.5 text-[13px] font-medium text-white/55 transition-colors hover:text-white"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden /> Exit
        </Link>
        <SlotStatusBar balance={balance} recent={recent} reduced={reduced} />
      </div>

      {/* Center: banner + reel stack + prize. Scrolls if a short viewport can't
          fit the reveal, so the prize + sell-back are never hidden behind the
          fixed controls. */}
      <div
        className="min-h-0 flex-1 overflow-y-auto px-fluid"
        aria-busy={phase === 'spinning'}
      >
        <div className="relative flex min-h-full flex-col items-center justify-center gap-6 py-6">
          <div className="min-h-8 text-center">
            {wonCards.length === 1 && firstRgb && firstTier && (
              <p
                className="font-heading text-2xl font-bold tracking-tight"
                style={{ color: `rgb(${firstRgb})` }}
              >
                YOU WON — {firstTier.toUpperCase()} ·{' '}
                {wonCards[0]!.marketPriceMyr != null
                  ? rm(wonCards[0]!.marketPriceMyr)
                  : wonCards[0]!.value}
              </p>
            )}
            {wonCards.length > 1 && (
              <p className="font-heading text-2xl font-bold tracking-tight text-white">
                YOU WON {wonCards.length} CARDS
              </p>
            )}
            {phase === 'spinning' && (
              <p className="font-heading text-lg font-bold tracking-tight text-white/60">
                SPINNING…
              </p>
            )}
          </div>

          <SlotReelStack
            count={count}
            cellSize={cellSize}
            spinKey={spin?.nonce ?? 'idle'}
            winners={
              phase === 'idle' || phase === 'resolving'
                ? null
                : (spin?.winners ?? null)
            }
            reduced={reduced}
            baseDurationMs={BASE_SPIN_MS}
            pulse={phase === 'landed'}
            onAllSettled={handleSettled}
          />

          {/* Reward: normal flow BELOW the reel on mobile; on desktop it floats as
              an absolutely-positioned right rail so it NEVER shifts the centered
              reel (stable for 1–3 reels). Scrolls internally if a tall multi-card
              reveal exceeds the height. */}
          {wonCards.length > 0 && (
            <div className="flex w-full flex-col items-center gap-5 lg:absolute lg:right-0 lg:top-1/2 lg:max-h-full lg:w-[300px] lg:-translate-y-1/2 lg:items-stretch lg:overflow-y-auto">
              {wonCards.map((won, i) => {
                const species = resolveCardPokemon(won)?.name;
                return (
                  <div
                    key={`${won.id}-${i}`}
                    className="flex w-full max-w-sm flex-col gap-3 lg:max-w-none"
                  >
                    <div className="flex items-start gap-3">
                      <Image
                        src={won.image}
                        alt={won.name}
                        width={88}
                        height={123}
                        className="h-[112px] w-auto shrink-0 rounded-lg object-contain"
                      />
                      <div className="min-w-0 flex-1 text-left">
                        <p
                          className="truncate text-base font-bold text-white"
                          title={species ?? won.name}
                        >
                          {species ?? won.name}
                        </p>
                        {species && (
                          <p
                            className="truncate text-[12px] text-white/50"
                            title={won.name}
                          >
                            {won.name}
                          </p>
                        )}
                        <p className="mt-1 text-[13px] text-white/60">
                          Value{' '}
                          <span className="font-bold text-white">
                            {won.marketPriceMyr != null
                              ? rm(won.marketPriceMyr ?? 0)
                              : won.value}
                          </span>
                        </p>
                      </div>
                    </div>
                    <SellBackPanel
                      offer={offers[i] ?? null}
                      active={phase === 'landed'}
                      reduced={reduced}
                      onSellBack={sellBackPull}
                      onReveal={revealPull}
                      onSold={refreshBalance}
                    />
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Bottom controls */}
      <div className="px-fluid pb-6 pt-2">
        <SlotControls
          cost={cost * count}
          spinning={phase === 'spinning' || phase === 'resolving'}
          disabled={spinGuarded || cooldown || (customer != null && !canAfford)}
          label={
            !customer
              ? 'Log in to spin'
              : phase === 'landed'
                ? 'Spin again'
                : 'Spin'
          }
          muted={muted}
          onSpin={handleSpin}
          onToggleMute={toggleMuted}
          onOpenOdds={() => setOddsOpen(true)}
        />
        {error && (
          <p role="alert" className="mt-3 text-center text-[12px] text-red-300">
            {error}
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
      </div>

      {/* Single consolidated announcement (settle-only). */}
      <p role="status" aria-live="polite" className="sr-only">
        {announce}
      </p>

      <OddsSheet open={oddsOpen} onClose={() => setOddsOpen(false)} />
    </div>
  );
}
