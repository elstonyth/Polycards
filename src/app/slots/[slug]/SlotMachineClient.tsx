// src/app/slots/[slug]/SlotMachineClient.tsx
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Minus } from 'lucide-react';
import { motion } from 'motion/react';
import { usePrefersReducedMotion } from '@/lib/use-reveal';
import { useChromeInert } from '@/lib/use-chrome-inert';
import { useAuth } from '@/components/auth/AuthProvider';
import { openAuth } from '@/components/AuthButton';
import { openBatch, revealPull } from '@/lib/actions/packs';
import type { WonCard } from '@/lib/actions/packs';
import { sellBackPull } from '@/lib/actions/vault';
import { useTopUp } from '@/components/app-shell/TopUpProvider';
import { useSound } from '@/lib/use-sound';
import { rm } from '@/lib/format';
import { logger } from '@/lib/logger';
import { cn } from '@/lib/utils';
import {
  type ResolvedPack,
  type Pack,
  type Rarity,
  FLAT_BUYBACK_PERCENT,
  priceNumber,
} from '@/lib/packs-data';
import type { RecentPull } from '@/lib/data/packs';
import { publishedOddsRows, type PublishedOdds } from '@/lib/packs-format';
import { isTopRarity, rarityRgb, RARITY_ORDER } from '@/lib/rarity';
import { spinTotalMs, columnDurationMs } from '@/lib/vault-reel';
import { resolveCardPokemon } from '@/lib/resolve-card-pokemon';
import { spriteGif } from '@/lib/mock/pokedex';
import { SlotReelStack, type ColumnWinner } from './SlotReelStack';
import { SlotStatusBar } from './SlotStatusBar';
import { SlotControls } from './SlotControls';
import { OddsSheet } from './OddsSheet';
import { VaultRoom } from './VaultRoom';
import { EmptyPedestal } from './EmptyPedestal';
import { Meter } from './Meter';
import { RevealStage } from './RevealStage';
import type { SellBackOffer } from '@/components/SellBackPanel';

const COOLDOWN_MS = 600;
/** How long a meter direction cue (up/down) stays lit before resetting. */
const METER_CUE_MS = 600;

// Neutral reel cell for a won card with no resolvable Pokémon (trainer/energy):
// a classic Poké Ball. Keeps the reel sprite-themed and never reveals the prize.
const POKEBALL_PLACEHOLDER =
  'data:image/svg+xml,' +
  encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><circle cx='50' cy='50' r='46' fill='#f5f5f5' stroke='#171717' stroke-width='4'/><path d='M5 50a45 45 0 0 1 90 0Z' fill='#ef4444'/><rect x='4' y='46' width='92' height='8' fill='#171717'/><circle cx='50' cy='50' r='13' fill='#f5f5f5' stroke='#171717' stroke-width='4'/></svg>",
  );

type Phase =
  | 'idle'
  | 'resolving'
  | 'spinning'
  | 'flood'
  | 'transform'
  | 'review';

/** Highest-rarity tier present in a batch, for the room flood color. */
function topRarityOf(cards: WonCard[]): Rarity {
  return (
    RARITY_ORDER.find((r) => cards.some((c) => c.rarity === r)) ?? 'Common'
  );
}

export default function SlotMachineClient({
  pack,
  recentPulls,
  count,
  publishedOdds,
}: {
  pack: ResolvedPack & Pack;
  recentPulls: RecentPull[];
  count: number;
  /** Admin-published PUBLIC odds for the OddsSheet; null = not published. */
  publishedOdds: PublishedOdds | null;
}) {
  const reduced = usePrefersReducedMotion();
  // Immersive surface: chrome inert + body scroll locked the whole time mounted.
  useChromeInert(true);
  const { customer } = useAuth();
  // Live customer id for the settle guard. handleSettled can be invoked from a
  // STALE closure — the reel prop, the watchdog, or handleSpin's own catch path
  // captured at spin time — so reading `customer` from a closure could compare
  // against the account that spun rather than the one signed in NOW. A ref
  // mirrored every render always holds the current id, closing that bypass.
  const customerIdRef = useRef<string | null>(customer?.id ?? null);
  customerIdRef.current = customer?.id ?? null;
  const { muted, toggleMuted, play, vibrate, sfx } = useSound();

  const cost = priceNumber(pack.price);
  // Reel count — prop is the initial value (already clamped from ?count=); the
  // player adds/removes reels in-machine. cost * reels is the batch price.
  const [reels, setReels] = useState(count);
  // Shrink the cell so multiple reels fit across the viewport.
  const cellSize = reels > 1 ? 76 : 96;

  // Balance comes from the app-shell provider (identity-tagged: values from
  // another account never render — push security review). Server-returned
  // balances from spins/sell-backs are pushed back up via applyBalance.
  const { balance, applyBalance } = useTopUp();
  const [recent, setRecent] = useState<RecentPull[]>(recentPulls);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [needsTopUp, setNeedsTopUp] = useState(false);
  const [oddsOpen, setOddsOpen] = useState(false);
  const [cooldown, setCooldown] = useState(false);
  // Meter roll direction cue for the reel add/remove ('up'/'down', auto-resets).
  const [meterDir, setMeterDir] = useState<'up' | 'down' | null>(null);

  // Won results + a nonce that remounts the reel stack to re-spin.
  const [spin, setSpin] = useState<{
    nonce: number;
    cards: WonCard[];
    winners: ColumnWinner[];
  } | null>(null);
  // Held until the reel settles (spoiler guard). Carries the won cards too, so
  // handleSettled reads the result from this ref (always current) instead of
  // closing over `spin` — the callback stays stable and double-fire-safe.
  const pending = useRef<{
    balance: number | null;
    /** Customer the charge/balance belongs to — settle drops it on mismatch. */
    forId: string | null;
    offers: (SellBackOffer | null)[];
    cards: WonCard[];
  } | null>(null);
  const [offers, setOffers] = useState<(SellBackOffer | null)[]>([]);
  const [announce, setAnnounce] = useState('');
  const cooldownTimer = useRef<number | null>(null);
  const meterTimer = useRef<number | null>(null);
  // Reveal-phase timers (flood → transform → review). Cleared on unmount + skip.
  const floodTimer = useRef<number | null>(null);
  const transformTimer = useRef<number | null>(null);
  // Winner tile screen rects, captured by the stack, consumed by the tile→slab
  // morph in RevealStage (spec decision #16). Reset per spin.
  const winnerRects = useRef<(DOMRect | null)[]>([]);
  useEffect(
    () => () => {
      if (cooldownTimer.current !== null) clearTimeout(cooldownTimer.current);
      if (meterTimer.current !== null) clearTimeout(meterTimer.current);
      if (floodTimer.current !== null) clearTimeout(floodTimer.current);
      if (transformTimer.current !== null) clearTimeout(transformTimer.current);
    },
    [],
  );

  const canAfford = balance !== null && balance >= cost * reels;
  // Spin is inert during the resolve/spin AND the reveal theater (flood /
  // transform) — a tap there is a skip gesture, not a new spin.
  const spinGuarded =
    phase === 'resolving' ||
    phase === 'spinning' ||
    phase === 'flood' ||
    phase === 'transform';
  const canAdjustReels = phase === 'idle' || phase === 'review';

  // Flash a meter direction cue, auto-resetting after the roll finishes.
  const cueMeter = useCallback((dir: 'up' | 'down') => {
    setMeterDir(dir);
    if (meterTimer.current !== null) clearTimeout(meterTimer.current);
    meterTimer.current = window.setTimeout(
      () => setMeterDir(null),
      METER_CUE_MS,
    );
  }, []);

  const addReel = useCallback(() => {
    if (!canAdjustReels) return;
    setReels((r) => Math.min(3, r + 1));
    sfx('clack');
    sfx('meterUp');
    cueMeter('up');
  }, [canAdjustReels, sfx, cueMeter]);

  const removeReel = useCallback(() => {
    if (!canAdjustReels) return;
    setReels((r) => Math.max(1, r - 1));
    sfx('meterDown');
    cueMeter('down');
  }, [canAdjustReels, sfx, cueMeter]);

  async function handleSpin() {
    if (spinGuarded) return;
    // Clear any in-flight reveal-theater timers (same as skipToCards) so a
    // stale flood→transform→review handoff can't fire over the new spin.
    if (floodTimer.current !== null) clearTimeout(floodTimer.current);
    if (transformTimer.current !== null) clearTimeout(transformTimer.current);
    if (!customer) {
      openAuth('login');
      return;
    }
    if (balance !== null && balance < cost * reels) {
      setNeedsTopUp(true);
      setError('Not enough credits to spin.');
      return;
    }
    setError(null);
    setNeedsTopUp(false);
    setOffers([]);
    setAnnounce('');
    winnerRects.current = [];
    setPhase('resolving');
    sfx('ratchet');
    play('spin');

    const res = await openBatch(pack.id, reels);
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
    // One entry per roll. The customer is ALREADY charged here, so if any
    // cosmetic mapping below throws we must still surface the result (see the
    // catch) rather than dying in phase='resolving'.
    const builtOffers: (SellBackOffer | null)[] = [];
    const winners: ColumnWinner[] = [];
    const cards: WonCard[] = [];
    // Single spin timestamp: unique per spin (drives the reel nonce) and the
    // fallback instant-offer deadline. handleSpin is a user-click async event
    // handler (never render), so this impure read is safe; the purity rule
    // can't infer that from a bare function declaration.
    // eslint-disable-next-line react-hooks/purity
    const spinAt = Date.now();

    try {
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
                vaultPercent:
                  roll.buyback?.vaultPercent ?? FLAT_BUYBACK_PERCENT,
                vaultAmount:
                  roll.buyback?.vaultAmount ??
                  Math.round(roll.marketValue * FLAT_BUYBACK_PERCENT) / 100,
                instantDeadlineMs:
                  roll.buyback?.instantDeadlineMs ?? spinAt + 30_000,
              }
            : null;
        builtOffers.push(builtOffer);

        // Cosmetic mapping (decides nothing): rarity color + winner Pokémon.
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
          rarityRgb: rarityRgb(roll.card.rarity),
        });
        cards.push(roll.card);
      }

      pending.current = {
        balance: res.balance,
        forId: customer?.id ?? null,
        offers: builtOffers,
        cards,
      };
      setSpin({ nonce: spinAt, cards, winners });
      setPhase('spinning');
    } catch (err) {
      // A cosmetic mapping step threw after the charge. Surface the result the
      // user paid for (authoritative server balance + won cards) and move to a
      // terminal phase via the idempotent settle — never strand them. The landed
      // reveal reads `spin` (not pending), so set it too — reconstructing the
      // cards from res.rolls if the winners loop didn't finish — otherwise it
      // would render a stale/previous spin's cards.
      logger.error('[slots] post-charge mapping failed', err);
      const settledCards =
        cards.length === res.rolls.length
          ? cards
          : res.rolls.map((roll) => roll.card);
      if (!pending.current) {
        pending.current = {
          balance: res.balance,
          forId: customer?.id ?? null,
          offers: builtOffers,
          cards: settledCards,
        };
      }
      setSpin({ nonce: spinAt, cards: settledCards, winners });
      handleSettled();
    }
  }

  // Fired by the stack once the last column settles. Reads the result from the
  // pending ref (not `spin`), so the callback is stable across re-renders and a
  // second fire is a no-op (held is nulled after the first).
  const handleSettled = useCallback(() => {
    const held = pending.current;
    if (!held) return;
    pending.current = null;

    // Identity switched mid-spin (token refresh, multi-tab login): the charge
    // and the won cards belong to the account that spun, not whoever is signed
    // in now. Drop the ENTIRE result — balance, cards, offers, reveal — because
    // suppressing only the balance would still show the previous account's
    // prizes (and sell-back offers referencing their pulls). The spun account
    // keeps its cards (server-side vault) and sees its real balance on next load
    // (the provider re-fetches per identity).
    if (held.forId !== customerIdRef.current) {
      setSpin(null);
      setPhase('idle');
      return;
    }

    if (held.balance != null) {
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
      who: 'You',
      packName: pack.name,
      packIcon: pack.image,
      agoLabel: 'just now',
    }));
    setRecent((prev) => [...justPulled, ...prev].slice(0, 12));

    // Big-win / haptics now fire on the card flip inside RevealStage; here we
    // keep only the announce text (and the phase handoff into the reveal).
    const big = held.cards.some((c) => isTopRarity(c.rarity));
    const bigPrefix = big ? 'Big win! ' : '';
    const first = held.cards[0];
    if (held.cards.length === 1 && first) {
      const firstValue =
        first.marketPriceMyr != null ? rm(first.marketPriceMyr) : first.value;
      setAnnounce(`${bigPrefix}Won ${first.name}, ${firstValue}`);
    } else {
      setAnnounce(`${bigPrefix}Won ${held.cards.length} cards`);
    }

    // Enter the reveal: flood the room (rarity wash + swell), then morph the
    // landed tiles into slabs (transform), then unlock the sell window (review).
    // Reduced motion collapses the theater to an immediate cut to review.
    const heldCardsCount = held.cards.length;
    setPhase('flood');
    sfx('swell');
    if (floodTimer.current !== null) clearTimeout(floodTimer.current);
    if (transformTimer.current !== null) clearTimeout(transformTimer.current);
    floodTimer.current = window.setTimeout(
      () => setPhase('transform'),
      reduced ? 0 : 1650,
    );
    transformTimer.current = window.setTimeout(
      () => setPhase('review'),
      // 1650 flood → morph (600) + settle margin (250) + per-card stagger (150).
      reduced ? 0 : 1650 + 600 + 250 + (heldCardsCount - 1) * 150,
    );

    setCooldown(true);
    if (cooldownTimer.current !== null) clearTimeout(cooldownTimer.current);
    cooldownTimer.current = window.setTimeout(
      () => setCooldown(false),
      COOLDOWN_MS,
    );
    // customerIdRef (a ref) is intentionally not a dep — the guard reads its
    // live value, so handleSettled stays stable and every caller (reel prop,
    // watchdog, stale catch closure) checks the CURRENT identity.
  }, [pack.name, pack.image, sfx, applyBalance, reduced]);

  // Fast-forward the post-landing theater. Lands on 'review' with card backs
  // unflipped (beat 5's skip). Never affects the spin itself — the spin is not
  // skippable; only what plays AFTER the reel settles.
  const skipToCards = useCallback(() => {
    if (floodTimer.current !== null) clearTimeout(floodTimer.current);
    if (transformTimer.current !== null) clearTimeout(transformTimer.current);
    setPhase('review');
  }, []);

  // Settle watchdog: the customer is charged the moment openBatch returns ok,
  // but the reveal only lands when the reel engine reports completion. If that
  // settle is ever missed (a remounted column, a browser hiccup), force the
  // same idempotent completion so a charged user is never stranded on a
  // spinning reel. Sized from the reel engine's own total run time plus a
  // buffer so it always outlasts the real animation and never pre-empts a
  // normal spin.
  // ponytail: backstop only — onAllSettled -> handleSettled is the primary path.
  useEffect(() => {
    if (phase !== 'spinning') return;
    const id = window.setTimeout(
      () => {
        if (pending.current) handleSettled();
      },
      spinTotalMs(reels) + 2000,
    );
    return () => clearTimeout(id);
  }, [phase, spin?.nonce, reels, handleSettled]);

  // Reel-stop clacks: the stack owns its per-column settle internally, so fire a
  // mechanical clack at each column's stop time from here (cleared on teardown).
  useEffect(() => {
    if (phase !== 'spinning') return;
    const ids: number[] = [];
    for (let i = 0; i < reels; i++) {
      ids.push(
        window.setTimeout(() => sfx('clack'), columnDurationMs(i, reels)),
      );
    }
    return () => ids.forEach((id) => clearTimeout(id));
  }, [phase, spin?.nonce, reels, sfx]);

  const refreshBalance = applyBalance;

  const inReveal =
    phase === 'flood' || phase === 'transform' || phase === 'review';
  // No rarity color anywhere until the reel settles: flood derives from phase.
  const floodRgb = inReveal ? rarityRgb(topRarityOf(spin?.cards ?? [])) : null;
  // Sprite for each landed tile's tile→slab morph (custom image, else dex gif).
  const spriteSrcs =
    spin?.winners.map(
      (w) => w.image ?? (w.dex !== null ? spriteGif(w.dex) : undefined),
    ) ?? [];

  return (
    <div className="fixed inset-0 z-[100] flex flex-col bg-neutral-950 text-neutral-50 pb-[env(safe-area-inset-bottom)]">
      {/* Top plate (Task 12 restyles). */}
      <div className="flex items-center justify-between gap-4 px-fluid py-4">
        <Link
          href={`/slots/${pack.id}`}
          className="inline-flex items-center gap-1.5 text-[13px] font-medium text-white/55 transition-colors hover:text-white"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden /> Exit
        </Link>
        <SlotStatusBar balance={balance} recent={recent} reduced={reduced} />
      </div>

      <VaultRoom
        floodRgb={floodRgb}
        dimmed={inReveal && phase !== 'flood'}
        reduced={reduced}
      >
        {/* Scrolls if a short viewport can't fit the reveal, so the prize +
            sell-back are never hidden behind the fixed controls. */}
        <div
          className="min-h-0 flex-1 overflow-y-auto px-fluid"
          aria-busy={phase === 'spinning'}
        >
          <div className="relative flex min-h-full flex-col items-center justify-center gap-6 py-6">
            {/* Machine: entrance-choreographed column group + pedestal. */}
            <motion.div
              variants={{
                hidden: {},
                shown: reduced ? {} : { transition: { staggerChildren: 0.12 } },
              }}
              initial="hidden"
              animate="shown"
            >
              <motion.div
                variants={{
                  hidden: reduced ? { opacity: 0 } : { opacity: 0, y: -60 },
                  shown: {
                    opacity: 1,
                    y: 0,
                    transition: {
                      duration: reduced ? 0.2 : 0.55,
                      ease: [0.16, 1, 0.3, 1],
                    },
                  },
                }}
                className={cn(
                  'flex items-stretch gap-3 sm:gap-5',
                  inReveal &&
                    phase !== 'flood' &&
                    'opacity-40 transition-opacity duration-500',
                )}
              >
                <SlotReelStack
                  count={reels}
                  cellSize={cellSize}
                  spinKey={spin?.nonce ?? 'idle'}
                  winners={
                    phase === 'idle' || phase === 'resolving'
                      ? null
                      : (spin?.winners ?? null)
                  }
                  reduced={reduced}
                  pulse={false}
                  onAllSettled={handleSettled}
                  onWinnerRect={(i, r) => {
                    winnerRects.current[i] = r;
                  }}
                  hideWinners={phase === 'transform' || phase === 'review'}
                />
                <EmptyPedestal
                  cellSize={cellSize}
                  visible={reels < 3 && canAdjustReels}
                  onAdd={addReel}
                  reduced={reduced}
                />
              </motion.div>
              {/* "−" handle under the reel group. */}
              {reels > 1 && canAdjustReels && (
                <button
                  type="button"
                  aria-label="Remove a reel"
                  onClick={removeReel}
                  className="mx-auto mt-2 flex h-11 w-11 items-center justify-center rounded-full border border-white/15 text-white/50 hover:text-white"
                >
                  <Minus className="h-4 w-4" aria-hidden />
                </button>
              )}
            </motion.div>

            {/* Reveal overlay (flood → transform → review). */}
            {inReveal && spin && (
              <RevealStage
                phase={phase}
                cards={spin.cards}
                offers={offers}
                winnerRects={winnerRects.current}
                spriteSrcs={spriteSrcs}
                reduced={reduced}
                onSkip={skipToCards}
                onSellBack={sellBackPull}
                onReveal={revealPull}
                onSold={refreshBalance}
                sfx={sfx}
                vibrate={vibrate}
                play={play}
              />
            )}
          </div>
        </div>

        {/* Bottom controls (Task 12 restyles). */}
        <div className="px-fluid pb-6 pt-2">
          <SlotControls
            costLine={
              <span className="inline-flex items-center">
                <span>Bet </span>
                <Meter
                  value={cost * reels}
                  direction={meterDir}
                  reduced={reduced}
                  className="ml-1.5 font-semibold text-white/85"
                />
                {reels > 1 && (
                  <span className="ml-2 rounded bg-amber-400/15 px-1.5 py-0.5 text-[11px] font-bold text-amber-300">
                    × {reels}
                  </span>
                )}
              </span>
            }
            spinning={phase === 'spinning' || phase === 'resolving'}
            disabled={
              spinGuarded || cooldown || (customer != null && !canAfford)
            }
            label={
              !customer
                ? 'Log in to spin'
                : phase === 'review'
                  ? 'Spin again'
                  : 'Spin'
            }
            muted={muted}
            onSpin={handleSpin}
            onToggleMute={toggleMuted}
            onOpenOdds={() => setOddsOpen(true)}
          />
          {error && (
            <p
              role="alert"
              className="mt-3 text-center text-[12px] text-red-300"
            >
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
      </VaultRoom>

      {/* Single consolidated announcement (settle-only). */}
      <p role="status" aria-live="polite" className="sr-only">
        {announce}
      </p>

      <OddsSheet
        open={oddsOpen}
        onClose={() => setOddsOpen(false)}
        odds={publishedOdds ? publishedOddsRows(publishedOdds) : null}
        overall={publishedOdds?.overall ?? null}
      />
    </div>
  );
}
