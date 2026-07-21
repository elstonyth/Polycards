// src/app/slots/[slug]/SlotMachineClient.tsx
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
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
  type PackCard,
  type Rarity,
  FLAT_BUYBACK_PERCENT,
  ODDS,
  priceNumber,
} from '@/lib/packs-data';
import type { RecentPull } from '@/lib/data/packs';
import { demoDraw } from '@/lib/demo-spin';
import { publishedOddsRows, type PublishedOdds } from '@/lib/packs-format';
import { isTopRarity, rarityRgb, RARITY_ORDER } from '@/lib/rarity';
import {
  spinTotalMs,
  columnDurationMs,
  SETTLE_MS,
  CRAWL_MS,
} from '@/lib/vault-reel';
import { resolveCardPokemon } from '@/lib/resolve-card-pokemon';
import { spriteGif } from '@/lib/mock/pokedex';
import { SlotReelStack, type ColumnWinner } from './SlotReelStack';
import { buildDecoyPool, shuffleCells, type HReelCell } from '@/lib/hreel';
import { SlotStatusBar } from './SlotStatusBar';
import { SlotControls } from './SlotControls';
import { OddsSheet } from './OddsSheet';
import { VaultRoom } from './VaultRoom';
import { Meter } from './Meter';
import { RevealStage } from './RevealStage';
import type { SellBackOffer } from './useSellWindow';

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
  'idle' | 'resolving' | 'spinning' | 'flood' | 'transform' | 'review';

/** Highest-rarity tier present in a batch, for the room flood color. */
function topRarityOf(cards: WonCard[]): Rarity {
  return (
    RARITY_ORDER.find((r) => cards.some((c) => c.rarity === r)) ?? 'Common'
  );
}

/** Cosmetic reel-winner mapping for a won/demo card (decides nothing): rarity
 *  color + the column's Pokémon sprite (custom image ⇢ dex gif ⇢ Poké Ball). */
function winnerFor(card: WonCard): ColumnWinner {
  const r = resolveCardPokemon(card);
  const custom =
    card.sprite_image && card.sprite_image.trim() !== ''
      ? card.sprite_image
      : null;
  return {
    dex: r.dex,
    image: custom ?? (r.dex === null ? POKEBALL_PLACEHOLDER : undefined),
    name: r.name ?? card.name,
    rarity: card.rarity as ColumnWinner['rarity'],
    rarityRgb: rarityRgb(card.rarity),
  };
}

export default function SlotMachineClient({
  pack,
  recentPulls,
  count,
  publishedOdds,
  pool = [],
  demoPool = null,
}: {
  pack: ResolvedPack & Pack;
  recentPulls: RecentPull[];
  count: number;
  /** Admin-published PUBLIC odds for the OddsSheet; null = not published. */
  publishedOdds: PublishedOdds | null;
  /** The pack's full public prize pool — the reel flickers ONLY these cards'
   *  Pokémon (decoys tied to a reward), never arbitrary species. */
  pool?: PackCard[];
  /** Non-null = ?demo=1: guest demo mode over this public pool. Pure theater —
   *  spins sample client-side (no openBatch, no charge, no Pull row, no
   *  sell-back). Logged-in customers always get the real machine regardless. */
  demoPool?: PackCard[] | null;
}) {
  const reduced = usePrefersReducedMotion();
  // Immersive surface: chrome inert + body scroll locked the whole time mounted.
  useChromeInert(true);
  const { customer, isLoading: authLoading } = useAuth();
  // Live customer id for the settle guard. handleSettled can be invoked from a
  // STALE closure — the reel prop, the watchdog, or handleSpin's own catch path
  // captured at spin time — so reading `customer` from a closure could compare
  // against the account that spun rather than the one signed in NOW. A ref
  // mirrored every render always holds the current id, closing that bypass.
  const customerIdRef = useRef<string | null>(customer?.id ?? null);
  customerIdRef.current = customer?.id ?? null;
  const { muted, toggleMuted, play, vibrate, sfx, anticipation } = useSound();

  // Guest-only demo: a logged-in customer on ?demo=1 gets the real machine —
  // the demo exists purely as a pre-signup taste, never a mode for players.
  const isDemo = demoPool !== null && !customer;
  // Auth still hydrating on ?demo=1: identity (and therefore the mode) is
  // unknown, so hold the spin — otherwise a logged-in customer could fire a
  // "demo" spin whose result the settle identity-guard then silently drops.
  const modeUndecided = demoPool !== null && !customer && authLoading;

  const cost = priceNumber(pack.price);
  // Reel count — prop is the initial value (already clamped from ?count=); the
  // player adds/removes reels in-machine. cost * reels is the batch price.
  const [reels, setReels] = useState(count);
  // Shrink the cell so multiple reels fit across the viewport.
  const cellSize = reels > 1 ? 76 : 96;

  // Decoy flicker pool: the pack's OWN cards, each pairing its CONFIGURED
  // Pokémon with its CONFIGURED rarity, deduped by the (dex, rarity) PAIR —
  // see buildDecoyPool. The reel only ever shows the exact species AND the
  // exact rarity colors an admin set for this pack, and every tier the pack
  // has stays in the flicker (an all-Pikachu/Charizard pack across six tiers
  // flickers all six colors, not just the first card per species).
  // Empty → ReelStrip falls back to its curated set.
  // ponytail: decoys render the dex sprite (spriteGif); for seeded entries that
  // IS the linked sprite. A custom-uploaded (dex-less) sprite would only flicker
  // via name-derive — threading the custom sprite_image into decoy cells is the
  // upgrade path if that ever matters.
  const basePool = useMemo<HReelCell[]>(() => buildDecoyPool(pool), [pool]);
  // Per-reel decoy pools: strip i tiles its OWN shuffled copy of basePool, so
  // stacked reels read independently and the idle sequence is never the same
  // twice (reshuffled per idle cycle — see the phase effect below). SSR-safe:
  // the initial value is the unshuffled pool, so server HTML matches the first
  // client paint; the shuffle lands one effect-tick after hydration.
  const [decoyPools, setDecoyPools] = useState<HReelCell[][]>(() =>
    Array.from({ length: reels }, () => basePool),
  );

  // Balance comes from the app-shell provider (identity-tagged: values from
  // another account never render — push security review). Server-returned
  // balances from spins/sell-backs are pushed back up via applyBalance.
  const { balance, applyBalance } = useTopUp();
  const [recent, setRecent] = useState<RecentPull[]>(recentPulls);
  const [phase, setPhase] = useState<Phase>('idle');
  // Reshuffle every reel's decoy pool each time the machine goes idle: on
  // mount (post-hydration) and on every return-to-idle after a spin — the
  // same transition where ReelStrip snaps its position back to base, a cut
  // the reveal theater already covers. Pools stay frozen during
  // resolving/spinning, so buildPressStrip's keepCells always reproduce the
  // exact idle frame on screen at press time (#147 seamless launch).
  // Accepted trade-off (spec): adjusting the reel COUNT while idle reshuffles
  // all strips — cosmetic, coincides with the add/remove layout animation;
  // the alternative (stale pools array) would put non-pack Pokémon on a new
  // reel via the DECOY_DEXES fallback.
  useEffect(() => {
    if (phase !== 'idle') return;
    setDecoyPools(Array.from({ length: reels }, () => shuffleCells(basePool)));
  }, [phase, reels, basePool]);
  // A just-added reel must show pack cards in the SAME render (the reshuffle
  // effect only lands next tick) — pad with basePool instead of letting
  // ReelStrip fall back to the non-pack DECOY_DEXES for a frame.
  const renderPools =
    decoyPools.length >= reels
      ? decoyPools
      : Array.from({ length: reels }, (_, i) => decoyPools[i] ?? basePool);
  // True once the player has spun at least once this session — drives the
  // "Spin again" button label, which must persist after the reveal concludes
  // back to 'idle' (spec decision #27), not only during 'review'.
  const [hasSpun, setHasSpun] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsTopUp, setNeedsTopUp] = useState(false);
  const [oddsOpen, setOddsOpen] = useState(false);
  const [cooldown, setCooldown] = useState(false);
  const [tension, setTension] = useState(false);
  const [blast, setBlast] = useState(false);
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
  const blastTimer = useRef<number | null>(null);
  // Winner tile screen rects, captured by the stack, consumed by the tile→slab
  // morph in RevealStage (spec decision #16). Reset per spin.
  const winnerRects = useRef<(DOMRect | null)[]>([]);
  useEffect(
    () => () => {
      if (cooldownTimer.current !== null) clearTimeout(cooldownTimer.current);
      if (meterTimer.current !== null) clearTimeout(meterTimer.current);
      if (floodTimer.current !== null) clearTimeout(floodTimer.current);
      if (transformTimer.current !== null) clearTimeout(transformTimer.current);
      if (blastTimer.current !== null) clearTimeout(blastTimer.current);
    },
    [],
  );

  const canAfford = balance !== null && balance >= cost * reels;
  // Spin + reel add/remove are locked for the ENTIRE non-idle flow — resolve,
  // spin, the reveal theater (flood/transform), AND the review/sell window
  // (spec #43). They only re-enable once every card is sold/kept and the reveal
  // auto-concludes back to 'idle' (#27), so "Spin again" can't fire while a
  // card sits un-actioned.
  const spinGuarded = phase !== 'idle';
  const canAdjustReels = phase === 'idle';

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
    if (spinGuarded || modeUndecided) return;
    // Clear any in-flight reveal-theater timers (same as skipToCards) so a
    // stale flood→transform→review handoff can't fire over the new spin.
    if (floodTimer.current !== null) clearTimeout(floodTimer.current);
    if (transformTimer.current !== null) clearTimeout(transformTimer.current);

    // Demo spin — sample client-side from the public pool over the published
    // odds (static ODDS pre-publication). No backend call, no charge, no Pull
    // row, no sell-back; the reveal shows a sign-up CTA instead.
    if (isDemo) {
      // Impure read is safe here: user-click event handler, never render (same
      // as the real spin's Date.now below).
      const spinAt = Date.now();
      const rows = publishedOdds ? publishedOddsRows(publishedOdds) : null;
      const cards: WonCard[] = [];
      for (let i = 0; i < reels; i++) {
        const drawn = demoDraw(
          demoPool,
          rows?.length ? rows : ODDS,
          // see above; nothing real is at stake in a demo draw
          Math.random(),
          Math.random(),
        );
        if (!drawn) {
          setError('No cards in this pack yet — check back soon.');
          return;
        }
        cards.push({
          ...drawn,
          slab_image: drawn.slabImage,
          pokemon_dex: null,
          sprite_image: null,
          marketPriceMyr: null,
        });
      }
      setError(null);
      setOffers([]);
      setAnnounce('');
      winnerRects.current = [];
      setHasSpun(true);
      sfx('ratchet');
      pending.current = {
        balance: null,
        forId: null,
        offers: cards.map(() => null),
        cards,
      };
      setSpin({ nonce: spinAt, cards, winners: cards.map(winnerFor) });
      setPhase('spinning');
      return;
    }

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
    setHasSpun(true);
    setPhase('resolving');
    sfx('ratchet');

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

    // Paint the debit now, not at settle: openBatch already charged (the saga
    // commits the charge before recording pulls), so the bet is spent before a
    // single reel turns — deferring this made a paid spin look free mid-flight.
    // The cards/offers below are spoilers; the balance never is.
    // Guard: the await can span an account switch — never paint the spun
    // account's balance onto whoever is signed in now.
    if (res.balance != null && customer.id === customerIdRef.current) {
      applyBalance(res.balance);
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
    // handler (never render), so this impure read is safe.
    const spinAt = Date.now();

    try {
      for (const roll of res.rolls) {
        // MYR display price; marketValue is raw USD FMV and must NEVER
        // render behind "RM" — when an older backend omits marketPriceMyr,
        // fall back to 0 (the vault seam's policy, actions/vault.ts) and let
        // SellConfirmModal show "—" for an unknown value. The offer's amount
        // fallbacks derive from this SAME figure so a single offer can never
        // mix currencies.
        const displayFmv = roll.card.marketPriceMyr ?? 0;
        // Build the sell-back offer for this roll.
        const builtOffer: SellBackOffer | null =
          roll.pullId !== null
            ? {
                pullId: roll.pullId,
                fmv: displayFmv,
                cardName: roll.card.name,
                image: roll.card.image,
                slabImage: roll.card.slab_image,
                percent: roll.buyback?.percent ?? FLAT_BUYBACK_PERCENT,
                amount:
                  roll.buyback?.amount ??
                  Math.round(displayFmv * FLAT_BUYBACK_PERCENT) / 100,
                vaultPercent:
                  roll.buyback?.vaultPercent ?? FLAT_BUYBACK_PERCENT,
                vaultAmount:
                  roll.buyback?.vaultAmount ??
                  Math.round(displayFmv * FLAT_BUYBACK_PERCENT) / 100,
                instantDeadlineMs:
                  roll.buyback?.instantDeadlineMs ?? spinAt + 30_000,
                firm: roll.buyback?.firm ?? true,
              }
            : null;
        builtOffers.push(builtOffer);

        winners.push(winnerFor(roll.card));
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
    // Don't cut the bed here — the spin is now timed to the ~6s bed and the
    // asset's own tail-fade lands on this lock, so it finishes on the beat.

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

    // Usually a no-op — handleSpin applied this same value at charge time. It
    // only lands when identity left and came back across the spin (A→B→A): the
    // charge-time guard skipped B, and the guard above just confirmed A is back.
    if (held.balance != null) {
      applyBalance(held.balance);
    }
    setOffers(held.offers);

    // Prepend one RecentPull per card won in this batch — real wins only; a
    // demo draw is theater and must never appear in the live pull ticker.
    if (!isDemo) {
      const now = Date.now();
      const justPulled: RecentPull[] = held.cards.map((won, i) => ({
        id: `${won.id}-${now}-${i}`,
        handle: won.id,
        name: won.name,
        image: won.image,
        slabImage: won.slab_image,
        value: won.marketPriceMyr != null ? rm(won.marketPriceMyr) : won.value,
        rarity: won.rarity,
        who: 'You',
        packName: pack.name,
        packIcon: pack.image,
        agoLabel: 'just now',
      }));
      setRecent((prev) => [...justPulled, ...prev].slice(0, 12));
    }

    // Big-win / haptics now fire on the card flip inside RevealStage; here we
    // keep only the announce text (and the phase handoff into the reveal).
    const big = held.cards.some((c) => isTopRarity(c.rarity));
    if (big && !reduced) {
      setBlast(true);
      if (blastTimer.current !== null) clearTimeout(blastTimer.current);
      blastTimer.current = window.setTimeout(() => setBlast(false), 950);
    }
    const bigPrefix = isDemo ? 'Demo — ' : big ? 'Big win! ' : '';
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
    // One rising gesture, not two: the `riser` sweep carries the flood beat and
    // the warm reveal bed fades in under it (RevealStage). The old synth `swell`
    // was a second, redundant rise stacked on top — dropped so the lead-up reads
    // as one seamless swell instead of two overlapping ones.
    play('riser');
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
  }, [pack.name, pack.image, play, applyBalance, reduced, isDemo]);

  // Fast-forward the post-landing theater. Lands on 'review' with card backs
  // unflipped (beat 5's skip). Never affects the spin itself — the spin is not
  // skippable; only what plays AFTER the reel settles.
  const skipToCards = useCallback(() => {
    if (floodTimer.current !== null) clearTimeout(floodTimer.current);
    if (transformTimer.current !== null) clearTimeout(transformTimer.current);
    setPhase('review');
  }, []);

  // Reveal concluded — every card sold/kept/expired (spec decision #27). Clear
  // the reveal (RevealStage unmounts as `inReveal` goes false), fade the machine
  // back in, and return to 'idle'. The reel stack shows the idle decoy strip
  // again; `hasSpun` keeps the button reading "Spin again".
  const handleConclude = useCallback(() => {
    setSpin(null);
    setOffers([]);
    setPhase('idle');
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

  // Per-cell tick: EVERY reel calls this as one of its Pokémon centers on the
  // winning line, so multi-reel spins sound multi-reel. A single reel never
  // crosses cells faster than ~74ms apart, so this ~18ms floor never drops a
  // reel's own ticks — it only collapses the rare case where two reels cross
  // within a blink (heard as one tick anyway), so overlapping reels can't stack
  // into a harsh coincident peak. Keeps the multi-reel cascade and the loud
  // single-reel tick, just tames the density.
  const lastTickAt = useRef(0);
  const handleCellCross = useCallback(() => {
    const now = performance.now();
    if (now - lastTickAt.current < 18) return;
    lastTickAt.current = now;
    sfx('reelTick');
  }, [sfx]);

  // Reel-stop clacks: the stack owns its per-column settle internally, so fire a
  // mechanical clack at each column's stop time from here (cleared on teardown).
  useEffect(() => {
    if (phase !== 'spinning') return;
    const ids: number[] = [];
    for (let i = 0; i < reels; i++) {
      ids.push(
        window.setTimeout(
          () => {
            sfx('clack');
            // Meaty reel-lock impact, pitched up per column — rising excitement
            // toward the last stop (classic slot trick via playbackRate).
            play('stop', 0.9, 1 + i * 0.06);
          },
          columnDurationMs(i, reels),
        ),
      );
    }
    return () => ids.forEach((id) => clearTimeout(id));
  }, [phase, spin?.nonce, reels, sfx, play]);

  // Rising tension during the final strip's crawl (spec §7d).
  useEffect(() => {
    if (phase !== 'spinning' || reduced) return;
    const last = columnDurationMs(reels - 1, reels);
    const crawlStart = last - SETTLE_MS - CRAWL_MS; // when the slow crawl begins
    const startId = window.setTimeout(
      () => {
        setTension(true);
        sfx('tensionRise');
        sfx('heartbeat');
      },
      Math.max(0, crawlStart),
    );
    const beatId = window.setTimeout(
      () => sfx('heartbeat'),
      Math.max(0, crawlStart + 350),
    );
    const endId = window.setTimeout(() => setTension(false), last);
    return () => {
      clearTimeout(startId);
      clearTimeout(beatId);
      clearTimeout(endId);
      setTension(false);
    };
  }, [phase, spin?.nonce, reels, reduced, sfx]);

  const refreshBalance = applyBalance;

  const inReveal =
    phase === 'flood' || phase === 'transform' || phase === 'review';
  // Machine fully fades out once the reveal moves past the flood beat (spec #19).
  const machineHidden = inReveal && phase !== 'flood';
  // No rarity color anywhere until the reel settles: flood derives from phase.
  const floodRgb = inReveal ? rarityRgb(topRarityOf(spin?.cards ?? [])) : null;
  // Sprite for each landed tile's tile→slab morph (custom image, else dex gif).
  const spriteSrcs =
    spin?.winners.map(
      (w) => w.image ?? (w.dex !== null ? spriteGif(w.dex) : undefined),
    ) ?? [];

  return (
    // Safe-area padding on ALL edges: modern flagships (Dynamic Island /
    // punch-hole tops, gesture bars, curved edges) inset every side, and this
    // room is a fixed full-viewport surface with no site chrome to absorb it.
    <div className="fixed inset-0 z-[100] flex flex-col bg-neutral-950 text-neutral-50 pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] pt-[env(safe-area-inset-top)]">
      {/* Top plate (Task 12 restyles) — compact on phones so the stage keeps
          every vertical px it can (the reveal sizes itself from stage height). */}
      <div className="flex items-center justify-between gap-3 px-fluid py-2 sm:gap-4 sm:py-4">
        <div className="flex items-center gap-3">
          <Link
            href={`/slots/${pack.id}`}
            className="inline-flex items-center gap-1.5 text-[13px] font-medium text-white/55 transition-colors hover:text-white"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden /> Exit
          </Link>
          {/* Neutral badge — amber reads as chase gold (prize-only signal). */}
          {isDemo && (
            <span className="rounded-full border border-white/25 bg-white/10 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-white/70">
              Demo
            </span>
          )}
        </div>
        <SlotStatusBar balance={balance} recent={recent} reduced={reduced} />
      </div>

      <VaultRoom
        floodRgb={floodRgb}
        dimmed={inReveal && phase !== 'flood'}
        reduced={reduced}
        tension={tension}
        blast={blast}
      >
        {/* The stage never scrolls in normal use: the reel clips symmetrically
            to the viewport width and the reveal card sizes itself from stage
            height. overflow-y-auto stays as a last-resort fallback (extreme
            landscape phones); overflow-x is hard-locked — vertical overflow
            must never re-enable sideways panning. */}
        <div
          data-testid="slot-stage"
          className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-fluid"
          aria-busy={phase === 'spinning'}
        >
          {/* my-auto on the machine (not justify-center here) — same safe
              centering as RevealStage: identical when content fits, but if the
              scroll fallback ever engages, the machine's top stays reachable
              instead of clipping above the scroll origin. */}
          <div className="relative flex min-h-full flex-col items-center gap-6 py-4 sm:py-6">
            {/* Machine: entrance-choreographed column group + pedestal.
                w-full down this chain gives the reel strip a real width to
                clip against (fit-content flex items would let it overflow
                narrow phones sideways). */}
            <motion.div
              className="my-auto w-full"
              variants={{
                hidden: {},
                shown: reduced ? {} : { transition: { staggerChildren: 0.12 } },
              }}
              initial="hidden"
              animate={machineHidden ? 'machineOut' : 'shown'}
            >
              {/* Transform/review: the machine fully fades out of the room (spec
                  decision #19). The fade switches VARIANT LABELS on the parent —
                  never an explicit `animate` object reset to `undefined`, which
                  does NOT re-follow the parent variant (Framer keeps the last
                  explicit value), so the machine stayed invisible after the
                  reveal concluded (feedback round 3). Label → label re-animates
                  in BOTH directions: out to `machineOut`, back in to `shown`. */}
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
                  machineOut: {
                    opacity: 0,
                    y: 0,
                    transition: {
                      duration: reduced ? 0 : 0.5,
                      ease: 'easeOut',
                    },
                  },
                }}
                className={cn(
                  'flex w-full flex-col items-center gap-3',
                  // pointer-events-none so a tap during transform reaches the
                  // skip gesture on the reveal overlay, not a dead reel column.
                  machineHidden && 'pointer-events-none',
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
                  decoyPools={renderPools}
                  onAllSettled={handleSettled}
                  onCellCross={handleCellCross}
                  onWinnerRect={(i, r) => {
                    winnerRects.current[i] = r;
                  }}
                  hideWinners={phase === 'transform' || phase === 'review'}
                />
              </motion.div>
            </motion.div>

            {/* Reveal overlay (flood → transform → review): a centered overlay
                (spec decision #19) rather than a flow sibling, so the slab /
                Gallery Rail centers in the viewport instead of appearing below
                the reel window and pushing content off-screen. winnerRects are
                measured at settle (before the machine fade above) and SlabCard's
                FLIP morph uses viewport-relative coordinates, so an absolute
                overlay here doesn't invalidate the morph math. */}
            {inReveal && spin && (
              // [container-type:size] makes this overlay the size container the
              // SlabCard width formula queries (100cqh = stage height), so the
              // card + sell footer always fit the visible stage — the pt-14
              // downward bias (old spec #29) is gone; true centering replaces
              // it now that the card can never crowd the top plate. The overlay
              // scrolls only as a last resort (RevealStage m-auto keeps the top
              // edge reachable then).
              <div className="absolute inset-0 flex overflow-y-auto overflow-x-hidden px-fluid py-2 [container-type:size]">
                <RevealStage
                  phase={phase}
                  cards={spin.cards}
                  offers={offers}
                  winnerRects={winnerRects.current}
                  spriteSrcs={spriteSrcs}
                  reduced={reduced}
                  demo={isDemo}
                  onSignUp={isDemo ? () => openAuth('signup') : undefined}
                  onSkip={skipToCards}
                  onConclude={handleConclude}
                  onSellBack={sellBackPull}
                  onReveal={revealPull}
                  onSold={refreshBalance}
                  sfx={sfx}
                  vibrate={vibrate}
                  play={play}
                  anticipation={anticipation}
                />
              </div>
            )}
          </div>
        </div>

        {/* Bottom controls (Task 12 restyles). On phones they leave the stage
            during the reveal (they're spin-guarded/disabled then anyway, spec
            #43) so the card + sell window get the full screen height; they
            return when the reveal concludes. Desktop keeps them in place. */}
        <div
          className={cn(
            'px-fluid pb-4 pt-2 sm:pb-6',
            machineHidden && 'max-sm:hidden',
          )}
        >
          <SlotControls
            costLine={
              isDemo ? (
                <span>Free demo — no credits charged, no real cards won</span>
              ) : (
                <span className="inline-flex items-center">
                  <span>Bet </span>
                  <Meter
                    value={cost * reels}
                    direction={meterDir}
                    reduced={reduced}
                    className="ml-1.5 font-semibold text-white/85"
                  />
                  {reels > 1 && (
                    <span className="ml-2 rounded bg-chase/15 px-1.5 py-0.5 text-[11px] font-bold text-chase">
                      × {reels}
                    </span>
                  )}
                </span>
              )
            }
            spinning={phase === 'spinning' || phase === 'resolving'}
            disabled={
              spinGuarded ||
              cooldown ||
              modeUndecided ||
              (customer != null && !canAfford)
            }
            label={
              isDemo
                ? hasSpun
                  ? 'Spin again'
                  : 'Demo spin'
                : !customer
                  ? 'Log in to spin'
                  : hasSpun
                    ? 'Spin again'
                    : 'Spin'
            }
            muted={muted}
            onSpin={handleSpin}
            onToggleMute={toggleMuted}
            onOpenOdds={() => setOddsOpen(true)}
            onAddReel={addReel}
            onRemoveReel={removeReel}
            addDisabled={reels >= 3 || !canAdjustReels}
            removeDisabled={reels <= 1 || !canAdjustReels}
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
                  {balance !== null && cost * reels - balance > 0 && (
                    <>You&apos;re {rm(cost * reels - balance)} short. </>
                  )}
                  <Link
                    href="/vault"
                    className="font-bold text-buyback-fg underline underline-offset-2 hover:text-buyback-fg"
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
