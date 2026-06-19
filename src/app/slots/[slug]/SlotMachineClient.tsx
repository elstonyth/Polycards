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
import { openPack, revealPull } from '@/lib/actions/packs';
import type { WonCard } from '@/lib/actions/packs';
import { getCreditBalance, sellBackPull } from '@/lib/actions/vault';
import { useSound } from '@/lib/use-sound';
import {
  type ResolvedPack,
  type Pack,
  FLAT_BUYBACK_PERCENT,
  priceNumber,
} from '@/app/claw/packs-data';
import type { RecentPull } from '@/lib/data/packs';
import { BASE_SPIN_MS } from '@/lib/reel';
import { priceTier, TIER_COLOR, type Tier } from '@/lib/price-tier';
import { pokemonFromCard } from '@/lib/pokemon-from-card';
import { SlotReelStack, type ColumnWinner } from './SlotReelStack';
import { SlotStatusBar } from './SlotStatusBar';
import { SlotControls } from './SlotControls';
import { OddsSheet } from './OddsSheet';
import { SellBackPanel, type SellBackOffer } from '@/components/SellBackPanel';

const COOLDOWN_MS = 600;
// Phase B is single-roll; open-batch / count>1 lands in Phase D.
const COLUMN_COUNT = 1;

type Phase = 'idle' | 'resolving' | 'spinning' | 'landed';

export default function SlotMachineClient({
  pack,
  recentPulls,
}: {
  pack: ResolvedPack & Pack;
  recentPulls: RecentPull[];
}) {
  const reduced = usePrefersReducedMotion();
  // Immersive surface: chrome inert + body scroll locked the whole time mounted.
  useChromeInert(true);
  const { customer } = useAuth();
  const { muted, toggleMuted, play, vibrate } = useSound();

  const cost = priceNumber(pack.price);
  const [balance, setBalance] = useState<number | null>(null);
  const [recent, setRecent] = useState<RecentPull[]>(recentPulls);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [needsTopUp, setNeedsTopUp] = useState(false);
  const [oddsOpen, setOddsOpen] = useState(false);
  const [cooldown, setCooldown] = useState(false);

  // Won result + a nonce that remounts the reel stack to re-spin.
  const [spin, setSpin] = useState<{
    nonce: number;
    card: WonCard;
    winners: ColumnWinner[];
    tier: Tier;
  } | null>(null);
  // Held until the reel settles (spoiler guard). Carries the won card too, so
  // handleSettled reads the result from this ref (always current) instead of
  // closing over `spin` — the callback stays stable and double-fire-safe.
  const pending = useRef<{
    balance: number | null;
    offer: SellBackOffer | null;
    card: WonCard;
  } | null>(null);
  const [offer, setOffer] = useState<SellBackOffer | null>(null);
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

  const canAfford = balance !== null && balance >= cost;
  const spinGuarded = phase === 'resolving' || phase === 'spinning';

  async function handleSpin() {
    if (spinGuarded) return;
    if (!customer) {
      openAuth('login');
      return;
    }
    if (balance !== null && balance < cost) {
      setNeedsTopUp(true);
      setError('Not enough credits to spin.');
      return;
    }
    setError(null);
    setNeedsTopUp(false);
    setOffer(null);
    setAnnounce('');
    setPhase('resolving');
    play('spin');

    const res = await openPack(pack.id);
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
    const builtOffer: SellBackOffer | null =
      res.pullId !== null && res.marketValue !== null
        ? {
            pullId: res.pullId,
            fmv: res.marketValue,
            cardName: res.card.name,
            image: res.card.image,
            percent: res.buyback?.percent ?? FLAT_BUYBACK_PERCENT,
            amount:
              res.buyback?.amount ??
              Math.round(res.marketValue * FLAT_BUYBACK_PERCENT) / 100,
            vaultPercent: res.buyback?.vaultPercent ?? FLAT_BUYBACK_PERCENT,
            vaultAmount:
              res.buyback?.vaultAmount ??
              Math.round(res.marketValue * FLAT_BUYBACK_PERCENT) / 100,
            instantDeadlineMs:
              res.buyback?.instantDeadlineMs ?? Date.now() + 30_000,
          }
        : null;
    pending.current = {
      balance: res.balance,
      offer: builtOffer,
      card: res.card,
    };

    // Cosmetic mapping (decides nothing): tier color + winner Pokémon (or the
    // §2/G5 card-art fallback when the card has no resolvable Pokémon).
    const tier = priceTier(res.marketValue);
    const mon = pokemonFromCard(res.card.name);
    const winners: ColumnWinner[] = Array.from(
      { length: COLUMN_COUNT },
      () => ({
        dex: mon?.dex ?? null,
        image: mon ? undefined : res.card.image,
        name: mon?.name ?? res.card.name,
        tier,
      }),
    );

    setSpin({ nonce: Date.now(), card: res.card, winners, tier });
    setPhase('spinning');
  }

  // Fired by the stack once the last column settles. Reads the result from the
  // pending ref (not `spin`), so the callback is stable across re-renders and a
  // second fire is a no-op (held is nulled after the first).
  const handleSettled = useCallback(() => {
    const held = pending.current;
    if (!held) return;
    pending.current = null;
    const won = held.card;

    if (held.balance != null) setBalance(held.balance);
    setOffer(held.offer);

    const justPulled: RecentPull = {
      id: `${won.id}-${Date.now()}`,
      name: won.name,
      image: won.image,
      value: won.value,
      rarity: won.rarity,
      packName: pack.name,
      packIcon: pack.image,
      agoLabel: 'just now',
    };
    setRecent((prev) => [justPulled, ...prev].slice(0, 12));

    const big = won.rarity === 'Epic' || won.rarity === 'Legendary';
    play(big ? 'bigwin' : 'win');
    vibrate(big ? [40, 40, 80] : 30);
    setAnnounce(`Won ${won.name}, ${won.value}`);
    setPhase('landed');

    setCooldown(true);
    if (cooldownTimer.current !== null) clearTimeout(cooldownTimer.current);
    cooldownTimer.current = window.setTimeout(
      () => setCooldown(false),
      COOLDOWN_MS,
    );
  }, [pack.name, pack.image, play, vibrate]);

  const refreshBalance = useCallback((b: number) => setBalance(b), []);

  const won = phase === 'landed' ? (spin?.card ?? null) : null;
  const tier = spin?.tier ?? null;
  const rgb = won && tier ? TIER_COLOR[tier] : null;

  return (
    <div className="fixed inset-0 z-[100] flex flex-col bg-neutral-950 text-neutral-50">
      {/* Top bar */}
      <div className="flex items-center justify-between gap-4 px-fluid py-4">
        <Link
          href="/slots"
          className="inline-flex items-center gap-1.5 text-[13px] font-medium text-white/55 transition-colors hover:text-white"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden /> Exit
        </Link>
        <SlotStatusBar balance={balance} recent={recent} reduced={reduced} />
      </div>

      {/* Center: banner + reel stack + prize */}
      <div
        className="flex flex-1 flex-col items-center justify-center gap-6 px-fluid"
        aria-busy={phase === 'spinning'}
      >
        <div className="min-h-8 text-center">
          {won && rgb && tier && (
            <p
              className="font-heading text-2xl font-bold tracking-tight"
              style={{ color: `rgb(${rgb})` }}
            >
              YOU WON — {tier.toUpperCase()} · {won.value}
            </p>
          )}
          {phase === 'spinning' && (
            <p className="font-heading text-lg font-bold tracking-tight text-white/60">
              SPINNING…
            </p>
          )}
        </div>

        <SlotReelStack
          count={COLUMN_COUNT}
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

        {won && (
          <div className="flex flex-col items-center gap-4">
            <div className="flex items-center gap-4">
              <Image
                src={won.image}
                alt={won.name}
                width={110}
                height={154}
                className="h-[154px] w-auto rounded-lg object-contain"
              />
              <div className="text-left">
                <p className="text-sm font-semibold text-white">{won.name}</p>
                <p className="text-[13px] text-white/60">
                  Value{' '}
                  <span className="font-bold text-white">{won.value}</span>
                </p>
              </div>
            </div>
            <SellBackPanel
              offer={offer}
              active={phase === 'landed'}
              reduced={reduced}
              onSellBack={sellBackPull}
              onReveal={revealPull}
              onSold={refreshBalance}
            />
          </div>
        )}
      </div>

      {/* Bottom controls */}
      <div className="px-fluid pb-6 pt-2">
        <SlotControls
          cost={cost}
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
