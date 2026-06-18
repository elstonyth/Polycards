// src/app/slots/[slug]/SlotMachineClient.tsx
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { ArrowLeft } from 'lucide-react';
import { usePrefersReducedMotion } from '@/lib/use-reveal';
import { useAuth } from '@/components/auth/AuthProvider';
import { openAuth } from '@/components/AuthButton';
import { openPack, revealPull } from '@/lib/actions/packs';
import type { WonCard } from '@/lib/actions/packs';
import { getCreditBalance, sellBackPull } from '@/lib/actions/vault';
import { useSound } from '@/lib/use-sound';
import {
  type ResolvedPack,
  type Pack,
  type Rarity,
  FLAT_BUYBACK_PERCENT,
  priceNumber,
} from '@/app/claw/packs-data';
import type { RecentPull } from '@/lib/data/packs';
import { BASE_SPIN_MS } from '@/lib/reel';
import { SlotReelRow } from './SlotReelRow';
import { PaylineBeam } from './PaylineBeam';
import { SlotStatusBar } from './SlotStatusBar';
import { SlotControls } from './SlotControls';
import { OddsSheet } from './OddsSheet';
import { RARITY_RGB } from './BallToken';
import { SellBackPanel, type SellBackOffer } from '@/components/SellBackPanel';

const RARITIES: Rarity[] = ['Legendary', 'Epic', 'Rare', 'Uncommon', 'Common'];
const COOLDOWN_MS = 600;

type Phase = 'idle' | 'resolving' | 'spinning' | 'landed';

export default function SlotMachineClient({
  pack,
  recentPulls,
}: {
  pack: ResolvedPack & Pack;
  recentPulls: RecentPull[];
}) {
  const reduced = usePrefersReducedMotion();
  const { customer } = useAuth();
  const { muted, toggleMuted, play, vibrate } = useSound();

  const cost = priceNumber(pack.price);
  const [balance, setBalance] = useState<number | null>(null);
  const [recent, setRecent] = useState<RecentPull[]>(recentPulls);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [needsTopUp, setNeedsTopUp] = useState(false);
  const [oddsOpen, setOddsOpen] = useState(false);
  // Brief post-settle cooldown so a mash can't re-fire instantly (PRD §10).
  const [cooldown, setCooldown] = useState(false);

  // Won result + a nonce that remounts the reel row to re-spin (PRD §6.5).
  const [spin, setSpin] = useState<{ nonce: number; card: WonCard } | null>(
    null,
  );
  // Held until the reel settles (spoiler guard, PRD §3.1).
  const pending = useRef<{
    balance: number | null;
    offer: SellBackOffer | null;
  } | null>(null);
  const [offer, setOffer] = useState<SellBackOffer | null>(null);
  const [announce, setAnnounce] = useState('');

  // Load balance on mount / auth change (PackDetailClient.tsx:98-110).
  useEffect(() => {
    if (!customer) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- v7 false positive (same pattern in PackDetailClient passes clean)
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

  // Lock body scroll while the reel is in motion (PRD §11).
  useEffect(() => {
    const active = phase === 'resolving' || phase === 'spinning';
    if (!active) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [phase]);

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
    pending.current = { balance: res.balance, offer: builtOffer };

    setSpin({ nonce: Date.now(), card: res.card });
    setPhase('spinning');
  }

  // Fired by the reel row when the winner lands center.
  const handleSettled = useCallback(() => {
    const won = spin?.card;
    if (!won) return;
    const held = pending.current;
    pending.current = null;

    if (held?.balance != null) setBalance(held.balance);
    setOffer(held?.offer ?? null);

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

    // Brief cooldown so a mash can't re-fire before re-enable (PRD §10).
    setCooldown(true);
    window.setTimeout(() => setCooldown(false), COOLDOWN_MS);
  }, [spin, pack.name, pack.image, play, vibrate]);

  const refreshBalance = useCallback((b: number) => setBalance(b), []);

  const won = phase === 'landed' ? (spin?.card ?? null) : null;
  const rgb = won ? RARITY_RGB[won.rarity] : null;

  return (
    <div className="mx-auto flex w-full flex-col gap-6 px-fluid py-6">
      <Link
        href="/claw"
        className="inline-flex items-center gap-1.5 text-[13px] font-medium text-white/55 transition-colors hover:text-white"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden /> All packs
      </Link>

      <SlotStatusBar balance={balance} recent={recent} reduced={reduced} />

      {/* Banner */}
      <div className="min-h-8 text-center">
        {won && rgb && (
          <p
            className="font-heading text-xl font-bold tracking-tight"
            style={{ color: `rgb(${rgb})` }}
          >
            YOU WON — {won.rarity} · {won.value}
          </p>
        )}
        {phase === 'spinning' && (
          <p className="font-heading text-lg font-bold tracking-tight text-white/60">
            SPINNING…
          </p>
        )}
      </div>

      {/* Reel hero */}
      <div className="relative" aria-busy={phase === 'spinning'}>
        <PaylineBeam reduced={reduced} pulse={phase === 'landed'} />
        <SlotReelRow
          key={spin?.nonce ?? 'idle'}
          winnerRarity={
            phase === 'idle' || phase === 'resolving'
              ? null
              : (spin?.card.rarity ?? null)
          }
          pool={RARITIES}
          reduced={reduced}
          durationMs={BASE_SPIN_MS}
          onSettled={handleSettled}
        />
      </div>

      {/* Won card slab (the real prize) + sell-back */}
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
                Value <span className="font-bold text-white">{won.value}</span>
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

      {/* Controls */}
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
        <p role="alert" className="text-center text-[12px] text-red-300">
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

      {/* Single consolidated announcement (PRD §11). */}
      <p role="status" aria-live="polite" className="sr-only">
        {announce}
      </p>

      <OddsSheet open={oddsOpen} onClose={() => setOddsOpen(false)} />
    </div>
  );
}
