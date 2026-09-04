// src/app/slots/[slug]/SlotMachineClient.tsx
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { preload } from 'react-dom';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { motion } from 'motion/react';
import { useMediaQuery, usePrefersReducedMotion } from '@/lib/use-reveal';
import { useChromeInert } from '@/lib/use-chrome-inert';
import { useAuth } from '@/components/auth/AuthProvider';
import { openAuth } from '@/components/AuthButton';
import {
  openBatch,
  openPack,
  revealPull,
  closeInstantWindow,
} from '@/lib/actions/packs';
import { spinTaskReward } from '@/lib/actions/tasks';
import type { WonCard } from '@/lib/actions/packs';
import { sellBackPull } from '@/lib/actions/vault';
import { useTopUp } from '@/components/app-shell/TopUpProvider';
import { useVaultDot } from '@/components/app-shell/VaultDotProvider';
import { useSound } from '@/lib/use-sound';
import { rm, affordable } from '@/lib/format';
import { logger } from '@/lib/logger';
import { cn } from '@/lib/utils';
import {
  type ResolvedPack,
  type Pack,
  type PackCard,
  type Rarity,
  FREE_WELCOME_CATEGORY,
  ODDS,
} from '@/lib/packs-data';
import type { RecentPull } from '@/lib/data/packs';
// The spin/open seam. Every route a press can take — the paid batch Open, the
// free welcome pack, a task's free rip, and the guest demo Spin — comes back
// from here in ONE shape, so nothing below this line re-forks on "is it a demo".
import {
  rollBatch,
  rollBlocker,
  rollMode,
  type RolledBatch,
  type RollRequest,
} from '@/lib/roll-batch';
import {
  pickDemoOdds,
  publishedOddsRows,
  poolValueRange,
  poolExpectedValue,
  tierValueRanges,
  type PublishedOdds,
} from '@/lib/packs-format';
import { isTopRarity, rarityRgb, RARITY_ORDER } from '@/lib/rarity';
import {
  spinTotalMs,
  columnDurationMs,
  SETTLE_MS,
  CRAWL_MS,
} from '@/lib/vault-reel';
import {
  nextPhase,
  isRevealPhase,
  revealTimings,
  blastMs,
  type Phase,
} from '@/lib/reveal-phase';
import { resolveCardPokemon } from '@/lib/resolve-card-pokemon';
import { spriteGif } from '@/lib/mock/pokedex';
import { SlotReelStack, type ColumnWinner } from './SlotReelStack';
import {
  buildDecoyPool,
  buildIdlePool,
  HREEL_IDLE_POOL_MAX,
  type HReelCell,
} from '@/lib/hreel';
import { SlotStatusBar } from './SlotStatusBar';
import { SlotControls } from './SlotControls';
import { OddsSheet } from './OddsSheet';
import { VaultRoom } from './VaultRoom';
import { Meter } from './Meter';
import { RevealStage } from './RevealStage';
import { SuccessToast } from '@/components/ui/SuccessToast';
import { CARD_BACK_SRC } from './SlabCard';
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
  demoOdds = null,
  freeRipClaimId = null,
}: {
  pack: ResolvedPack & Pack;
  recentPulls: RecentPull[];
  count: number;
  /** Admin-published PUBLIC odds for the OddsSheet; null = not published. */
  publishedOdds: PublishedOdds | null;
  /** Odds SET 3's real tier split (backend-aggregated) — the demo draw's
   *  weights. Display never uses it; the OddsSheet stays on publishedOdds. */
  demoOdds?: PublishedOdds | null;
  /** The pack's full public prize pool — the reel flickers ONLY these cards'
   *  Pokémon (decoys tied to a reward), never arbitrary species. */
  pool?: PackCard[];
  /** Non-null = ?demo=1: guest demo mode over this public pool. Pure theater —
   *  spins sample client-side (no openBatch, no charge, no Pull row, no
   *  sell-back). Logged-in customers always get the real machine regardless. */
  demoPool?: PackCard[] | null;
  /** A task's free-rip entitlement (?freeRip=<claimId>). When present the
   *  machine spends THAT instead of charging: one reel, no cost, and the spin
   *  calls the redeem endpoint. Claiming the task already recorded the
   *  entitlement, so arriving here late — or never — loses nothing. */
  freeRipClaimId?: string | null;
}) {
  const reduced = usePrefersReducedMotion();
  // Immersive surface: chrome inert + body scroll locked the whole time mounted.
  useChromeInert(true);
  const { customer, isLoading: authLoading } = useAuth();
  // Live customer id for the settle guard. handleSettled can be invoked from a
  // STALE closure — the reel prop, the watchdog, or handleRoll's own mapping
  // catch captured at press time — so reading `customer` from a closure could
  // compare against the account that rolled rather than the one signed in NOW.
  // A ref mirrored every render always holds the current id, closing that
  // bypass. (What it compares against is the ROLL's own forId, and it steps
  // aside entirely for a demo — see handleSettled.)
  const customerIdRef = useRef<string | null>(customer?.id ?? null);
  customerIdRef.current = customer?.id ?? null;
  const { muted, toggleMuted, play, loop, halt, vibrate, sfx } = useSound();
  // Ambient bed starts on the first real spin gesture (autoplay-safe) and
  // persists across spins; mute kills it and the next spin restarts it.
  const ambientOn = useRef(false);

  // The one-time free welcome pack. It is opened SINGLY through the single-open
  // route — the backend rejects a batch on this category outright — so the reel
  // count is pinned to 1 and every bet/quantity control goes away.
  const isFreePack = pack.categoryId === FREE_WELCOME_CATEGORY;
  // A task's free rip. Like the welcome pack it is exactly ONE open at no cost,
  // but it spends an entitlement rather than a one-time eligibility, and the
  // card it yields is a reward pull — sellable on the spot like any pulled
  // card (completing the task is the requirement; no welcome-pack lock).
  const isFreeRip = freeRipClaimId !== null && freeRipClaimId !== '';

  // Which of the four routes a press takes — decided ONCE, here, by the seam
  // that also performs it. Guest-only demo: a logged-in customer on ?demo=1
  // gets the real machine, because the demo exists purely as a pre-signup
  // taste and never as a mode for players.
  const mode = rollMode({
    demoPool,
    signedIn: customer != null,
    freeRipClaimId,
    freeWelcome: isFreePack,
  });
  // Presentational only: the DEMO badge, the honesty copy, the button label.
  // Everything about the RESULT of a roll reads the mode off the roll itself
  // (RolledBatch.mode) — this value can flip mid-flight when someone logs in.
  const isDemo = mode === 'demo';
  // Auth still hydrating: identity (and therefore the mode) is unknown, so
  // hold the spin — on ?demo=1 a logged-in customer could otherwise fire a
  // "demo" spin whose result the settle identity-guard then silently drops,
  // and on every other route the press would open the login modal over the
  // customer's own session.
  const modeUndecided = !customer && authLoading;

  // Real backend price, never re-parsed from the rounded display string.
  const cost = pack.priceValue;
  // Reel count — prop is the initial value (already clamped from ?count=); the
  // player adds/removes reels in-machine. cost * reels is the batch price.
  const [reels, setReels] = useState(isFreePack || isFreeRip ? 1 : count);
  // Shrink the cell so multiple reels fit across the viewport. On a roomy
  // viewport the cell grows instead: the phone layout on a desktop left the
  // machine a ~110px band floating in ~900px of empty room, which reads as an
  // unfinished page rather than the "more air" the spec asks for. The machine
  // is the subject — it scales with the stage it's standing on.
  // ponytail: one breakpoint, not a resize observer — cellSize feeds the reel
  // engine's pitch math, so a continuously-changing value would thrash it.
  const roomy = useMediaQuery('(min-width: 768px) and (min-height: 720px)');
  const idealCell = reels > 1 ? (roomy ? 116 : 76) : roomy ? 152 : 96;

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
  // Per-reel pools are sliced to HREEL_IDLE_POOL_MAX: the idle drift tiles one
  // full pool period + the visible window onto the strip, so a pool past the
  // cap can't wrap and ReelStrip rests the reel sharp — the "rails frozen" bug
  // on big packs (prod diamond-pack: 78 pairs). Reshuffles slice AFTER the
  // per-idle-cycle shuffle, so the whole pool still rotates through the reel
  // across cycles; this deterministic slice only seeds SSR + pads a just-added
  // reel, where unshuffled-but-capped is exactly what hydration needs.
  const cappedBase = useMemo(
    () => basePool.slice(0, HREEL_IDLE_POOL_MAX),
    [basePool],
  );
  // Card-value range for the odds sheet — same pool, same memo convention.
  const valueRange = useMemo(() => poolValueRange(pool), [pool]);
  // Per-tier ranges, so the sheet matches the pack page's odds panel row for row.
  const tierRanges = useMemo(() => tierValueRanges(pool), [pool]);
  // Expected value over the published tiers — the sheet's top row, same as the
  // pack page's panel.
  const expectedValue = useMemo(
    () => (publishedOdds ? poolExpectedValue(pool, publishedOdds.tiers) : null),
    [pool, publishedOdds],
  );
  // Per-reel decoy pools: strip i tiles its OWN shuffled copy of basePool, so
  // stacked reels read independently and the idle sequence is never the same
  // twice (reshuffled per idle cycle — see the phase effect below). SSR-safe:
  // the initial value is the unshuffled pool, so server HTML matches the first
  // client paint; the shuffle lands one effect-tick after hydration.
  const [decoyPools, setDecoyPools] = useState<HReelCell[][]>(() =>
    Array.from({ length: reels }, () => cappedBase),
  );

  // Balance comes from the app-shell provider (identity-tagged: values from
  // another account never render — push security review). Server-returned
  // balances from spins/sell-backs are pushed back up via applyBalance.
  // Aliased: `applyBalance` sets a known number (the balance a spin or
  // sell-back returned). `refetchBalance` re-reads it from the server.
  const { balance, applyBalance, refreshBalance: refetchBalance } = useTopUp();
  const { refresh: refreshVaultDot } = useVaultDot();
  const [recent, setRecent] = useState<RecentPull[]>(recentPulls);
  const [phase, setPhase] = useState<Phase>('idle');
  // Warm the reveal art while the reels are still turning. Measured: mounting
  // SlabCard was what first requested the card back, so the fetch + decode
  // landed ~150ms INTO the transform beat (an 87ms main-thread task on top of
  // the morph, plus the art visibly popping in). The spin gives us ~3s of
  // otherwise-idle network to spend instead.
  // Only the GRADED back is warmed here, and only because it is a plain <img>
  // of this exact path. The RAW back renders through next/image (SlabImage), so
  // the browser requests /_next/image?url=…&w=<picked from srcset> — preloading
  // the /public path would fetch a URL the reveal never asks for. It carries
  // `priority` instead, which is next/image's own preload.
  useEffect(() => {
    if (phase === 'spinning') preload(CARD_BACK_SRC, { as: 'image' });
  }, [phase]);
  // Commit the stage scale only while idle: cellSize is a ReelStrip engine
  // dependency (pitch/travel/target), so resizing the window mid-spin would
  // restart the rAF timeline under the player's eyes.
  const cellRef = useRef(idealCell);
  if (phase === 'idle') cellRef.current = idealCell;
  const cellSize = cellRef.current;
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
    setDecoyPools(Array.from({ length: reels }, () => buildIdlePool(basePool)));
  }, [phase, reels, basePool]);
  // A just-added reel must show pack cards in the SAME render (the reshuffle
  // effect only lands next tick) — pad with cappedBase instead of letting
  // ReelStrip fall back to the non-pack DECOY_DEXES for a frame.
  const renderPools =
    decoyPools.length >= reels
      ? decoyPools
      : Array.from({ length: reels }, (_, i) => decoyPools[i] ?? cappedBase);
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
  // Held until the reel settles (spoiler guard) — the whole batch exactly as
  // the seam returned it, so handleSettled reads the result from this ref
  // (always current) instead of closing over `spin`: the callback stays stable
  // and double-fire-safe.
  const pending = useRef<RolledBatch | null>(null);
  const [offers, setOffers] = useState<(SellBackOffer | null)[]>([]);
  // Mirrors the settled batch's `locked` — held in state (not a ref) because the
  // reveal renders from it.
  const [lockedReveal, setLockedReveal] = useState(false);
  // Same idea, same reason: the reveal must render the mode of the roll it is
  // SHOWING, not the mode the machine is in now. A guest who takes the demo's
  // "Sign up & pull for real" CTA becomes a customer mid-reveal, which flips
  // the live `isDemo` false — and the reveal would then drop its sign-up
  // footer and start treating a theater card as a real, sellable pull.
  const [demoReveal, setDemoReveal] = useState(false);
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

  // A free open is always affordable — and must not wait on the balance read,
  // which is null while it loads and would leave a brand-new account (balance
  // RM 0, the exact audience) staring at a disabled Spin button.
  const canAfford =
    isFreePack ||
    isFreeRip ||
    (balance !== null && affordable(balance, cost * reels));
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

  // One press, one roll — whichever of the four routes this machine is on.
  // Named for the seam, not for the demo: what happens here is an Open on
  // every route but one, and the demo Spin is the exception, not the shape.
  async function handleRoll() {
    if (spinGuarded || modeUndecided) return;
    play('tap');
    // Clear any in-flight reveal-theater timers (same as skipToCards) so a
    // stale flood→transform→review handoff can't fire over the new roll.
    if (floodTimer.current !== null) clearTimeout(floodTimer.current);
    if (transformTimer.current !== null) clearTimeout(transformTimer.current);

    // Which odds a demo Spin samples on: odds SET 3 (backend-aggregated per
    // tier), falling back to the published display odds and then the static
    // ODDS. Ignored by every paying route.
    const drawOdds = pickDemoOdds(demoOdds, publishedOdds);
    const rows = drawOdds ? publishedOddsRows(drawOdds) : null;
    const request: RollRequest = {
      mode,
      packId: pack.id,
      reels,
      freeRipClaimId,
      demoPool: demoPool ?? [],
      demoOdds: rows?.length ? rows : ODDS,
      forId: customer?.id ?? null,
    };

    // The credit guards, and the ONLY place the route still matters before the
    // roll: a guest demo touches neither auth nor credit, every other route
    // touches both.
    if (mode !== 'demo') {
      if (!customer) {
        openAuth('login');
        return;
      }
      if (
        mode === 'paid' &&
        balance !== null &&
        !affordable(balance, cost * reels)
      ) {
        setNeedsTopUp(true);
        setError('Not enough credits to spin.');
        return;
      }
    }
    // Refused before a single piece of state moves, so a blocked press leaves
    // the machine exactly as it found it.
    const blocked = rollBlocker(request);
    if (blocked) {
      setError(blocked);
      return;
    }

    setError(null);
    setNeedsTopUp(false);
    setOffers([]);
    setAnnounce('');
    winnerRects.current = [];
    setHasSpun(true);
    sfx('ratchet');
    // The paying routes lock the button across the server round-trip; the demo
    // has no round-trip to cover and goes straight to 'spinning' below, once
    // its cards exist.
    if (mode !== 'demo') setPhase((p) => nextPhase(p, 'spin'));

    // ONE call. Nothing below retries it: a rejection or a transport failure
    // may already have debited, and a second attempt would charge twice.
    const res = await rollBatch(request, {
      openBatch,
      openPack,
      spinTaskReward,
      now: () => Date.now(),
      random: () => Math.random(),
    });

    if (!res.ok) {
      // Nothing spun on any failure path, so the button must not read "Spin
      // again" over the error.
      setHasSpun(false);
      if (res.kind === 'unreachable') {
        // The charge may well have landed (the server executed, the response
        // did not transport back). Telling the player to check their balance
        // while showing the STALE pre-charge figure invites a second, real
        // charge, so refetch before re-enabling Spin. Show the error NOW,
        // before the refetch — this path fires when the server is unreachable,
        // so awaiting a second call to it would leave the screen looking dead
        // (no message, button still disabled) for the whole fetch timeout. The
        // message lands immediately instead.
        setError(
          "Couldn't reach the machine. Check your balance before spinning again.",
        );
        // Then refetch BEFORE re-enabling Spin. Deliberately awaited, not
        // fire-and-forget: the on-screen balance is the stale PRE-charge figure
        // and the charge may have landed, so re-enabling over it invites a
        // second real charge. Keeping phase on 'resolving' through the refetch
        // holds the button disabled; when the refetch resolves (to the fresh
        // value, or to null on failure — TopUpProvider swallows its own errors)
        // canAfford is recomputed and the button gates correctly. finally
        // guarantees the reset even if the refetch somehow rejects.
        try {
          await refetchBalance();
        } catch (refetchErr) {
          logger.error(
            '[slots] balance refetch after transport failure',
            refetchErr,
          );
        } finally {
          setPhase((p) => nextPhase(p, 'abort'));
        }
        return;
      }
      if (res.needsAuth) openAuth('login');
      else {
        setError(res.error);
        setNeedsTopUp(res.needsTopUp === true);
        // Same hazard, narrower: openBatch maps a post-charge mapping failure
        // to {ok:false} ("the card is in your Vault"), so the debit — and the
        // pull — can already be real here too. Light the Vault tab so the
        // card has a signpost, and never invite a retry over a stale balance;
        // a failing refetch must not block the state reset below either.
        if (res.needsTopUp !== true) {
          refreshVaultDot();
          try {
            await refetchBalance();
          } catch (refetchErr) {
            logger.error(
              '[slots] balance refetch after {ok:false}',
              refetchErr,
            );
          }
        }
      }
      setPhase((p) => nextPhase(p, 'abort'));
      return;
    }

    const batch = res.batch;

    // Paint the debit now, not at settle: the open already charged (the saga
    // commits the charge before recording pulls), so the bet is spent before a
    // single reel turns — deferring this made a paid spin look free mid-flight.
    // The cards/offers below are spoilers; the balance never is.
    // Guard: the await can span an account switch — never paint the rolled
    // account's balance onto whoever is signed in now. A demo carries no
    // balance and no account, so both guards below simply never fire for it.
    if (batch.balance != null && batch.forId === customerIdRef.current) {
      applyBalance(batch.balance);
    }

    // The cards are in the vault as of this response — the open workflow writes
    // every pull `status: 'vaulted'` at roll time, before a reel turns. Tell the
    // Vault tab now: it otherwise only re-reads on login and on window focus,
    // and a spin is neither, so the dot could not light until the customer
    // switched tabs away and back or reloaded. Same identity guard as the
    // balance above — never light the rolled account's dot for whoever is
    // signed in now.
    if (batch.forId !== null && batch.forId === customerIdRef.current) {
      refreshVaultDot();
    }

    // The last mapping left: cosmetic reel winners. The customer is ALREADY
    // charged here, so a throw must still surface the result they paid for —
    // hand the (possibly partial) winners to the idempotent settle rather than
    // dying in phase='resolving'. The batch itself is already built, so there
    // is nothing to reconstruct.
    const winners: ColumnWinner[] = [];
    let mappingFailed = false;
    try {
      for (const card of batch.cards) winners.push(winnerFor(card));
    } catch (err) {
      logger.error('[slots] post-charge mapping failed', err);
      mappingFailed = true;
    }

    pending.current = batch;
    setSpin({ nonce: batch.spinAt, cards: batch.cards, winners });
    if (mappingFailed) handleSettled();
    // The ROLL's own mode, never the machine's: past this await the live one
    // can have flipped, and every decision about a result reads it off the
    // result (same rule as handleSettled below).
    else
      setPhase((p) =>
        nextPhase(p, batch.mode === 'demo' ? 'demo-spin' : 'rolled'),
      );
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

    // Identity switched mid-roll (token refresh, multi-tab login): the charge
    // and the won cards belong to the account that rolled, not whoever is signed
    // in now. Drop the ENTIRE result — balance, cards, offers, reveal — because
    // suppressing only the balance would still show the previous account's
    // prizes (and sell-back offers referencing their pulls). That account keeps
    // its cards (server-side vault) and sees its real balance on next load (the
    // provider re-fetches per identity).
    //
    // A roll bound to no account is exempt, and must be: a demo has no charge,
    // no pull and no offer, so there is nothing here to protect — while the
    // guard, comparing null against a live customer id, would silently discard
    // the result of any demo a login happened to land in the middle of.
    //
    // Tested as `forId !== null`, NOT `mode !== 'demo'`, so this reads the same
    // invariant the same way as the vault-dot guard above. roll-batch pins a
    // demo batch's forId to null structurally, so the two cannot disagree.
    if (held.forId !== null && held.forId !== customerIdRef.current) {
      setSpin(null);
      setPhase((p) => nextPhase(p, 'abort'));
      return;
    }

    // Usually a no-op — handleRoll applied this same value at charge time. It
    // only lands when identity left and came back across the roll (A→B→A): the
    // charge-time guard skipped B, and the guard above just confirmed A is back.
    if (held.balance != null) {
      applyBalance(held.balance);
    }
    setOffers(held.offers);
    setLockedReveal(held.locked);
    setDemoReveal(held.mode === 'demo');

    // Prepend one RecentPull per card won in this batch — real wins only; a
    // demo draw is theater and must never appear in the live pull ticker. Read
    // off the ROLL, not the machine: a login mid-flight flips the live isDemo
    // and would push theater cards into the live ticker.
    if (held.mode !== 'demo') {
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
        // The ticker prints none of the profile fields — a faceless row is
        // exact, not a placeholder.
        avatar: null,
        frame: null,
        profileHandle: null,
        rolledAt: new Date(now).toISOString(),
        agoLabel: 'just now',
      }));
      setRecent((prev) => [...justPulled, ...prev].slice(0, 12));
    }

    // Big-win / haptics now fire on the card flip inside RevealStage; here we
    // keep only the announce text (and the phase handoff into the reveal).
    const big = held.cards.some((c) => isTopRarity(c.rarity));
    const blastFor = blastMs(big, reduced);
    if (blastFor > 0) {
      setBlast(true);
      if (blastTimer.current !== null) clearTimeout(blastTimer.current);
      blastTimer.current = window.setTimeout(() => setBlast(false), blastFor);
    }
    const bigPrefix = held.mode === 'demo' ? 'Demo — ' : big ? 'Big win! ' : '';
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
    // Both beats are scheduled NOW as absolute delays from this settle — see
    // revealTimings, which also owns the reduced-motion collapse to an immediate
    // cut to review.
    const beats = revealTimings(held.cards.length, reduced);
    setPhase((p) => nextPhase(p, 'settle'));
    // One rising gesture, not two: the `riser` sweep alone carries the flood
    // beat. The old synth `swell` was a second, redundant rise stacked on top —
    // dropped so the lead-up reads as one swell. (The looping reveal bed that
    // used to fade in under it was removed 2026-08-04 — operator call: the
    // face-down wait plays dry.)
    play('riser');
    if (floodTimer.current !== null) clearTimeout(floodTimer.current);
    if (transformTimer.current !== null) clearTimeout(transformTimer.current);
    floodTimer.current = window.setTimeout(
      () => setPhase((p) => nextPhase(p, 'morph')),
      beats.floodMs,
    );
    transformTimer.current = window.setTimeout(
      () => setPhase((p) => nextPhase(p, 'reveal')),
      beats.reviewMs,
    );

    setCooldown(true);
    if (cooldownTimer.current !== null) clearTimeout(cooldownTimer.current);
    cooldownTimer.current = window.setTimeout(
      () => setCooldown(false),
      COOLDOWN_MS,
    );
    // customerIdRef (a ref) is intentionally not a dep — the guard reads its
    // live value, so handleSettled stays stable and every caller (reel prop,
    // watchdog, stale catch closure) checks the CURRENT identity. `isDemo` is
    // no longer a dep either: every demo/real decision above reads the ROLL's
    // own mode, which makes this callback stabler still (the settle watchdog
    // depends on it).
  }, [pack.name, pack.image, play, applyBalance, reduced]);

  // Fast-forward the post-landing theater. Lands on 'review' with card backs
  // unflipped (beat 5's skip). Never affects the spin itself — the spin is not
  // skippable; only what plays AFTER the reel settles.
  const skipToCards = useCallback(() => {
    if (floodTimer.current !== null) clearTimeout(floodTimer.current);
    if (transformTimer.current !== null) clearTimeout(transformTimer.current);
    setPhase((p) => nextPhase(p, 'skip'));
  }, []);

  // Reveal concluded — every card sold/kept/expired (spec decision #27). Clear
  // the reveal (RevealStage unmounts as `inReveal` goes false), fade the machine
  // back in, and return to 'idle'. The reel stack shows the idle decoy strip
  // again; `hasSpun` keeps the button reading "Spin again".
  const handleConclude = useCallback(() => {
    setSpin(null);
    setOffers([]);
    setLockedReveal(false);
    setDemoReveal(false);
    setPhase((p) => nextPhase(p, 'conclude'));
  }, []);

  // The concluded reveal used to offer "Spin again" (conclude + replay in one
  // press) and "Done". Both are gone — RevealStage auto-concludes to the idle
  // machine now — so the conclude→replay chaining that lived here (a ref flag,
  // a handleRoll ref, and a phase effect to fire the replay one render later)
  // went with them. A new roll is a press on the Spin button again, nothing else.

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

  // Reel audio: launch whoosh at reel takeoff. The spinning sound itself is the
  // per-cell reelTick below (one click per Pokémon crossing — tracks the real
  // reel speed, which a fixed-tempo loop file cannot; the slot-spin.mp3 loop was
  // tried and replaced 2026-08-04). Reduced motion has no reel travel — same
  // guard as the clacks below. The ambient bed piggybacks on the same moment:
  // first spin is a safe gesture-unlocked point to start it, and it persists
  // across spins until muted.
  useEffect(() => {
    if (phase !== 'spinning' || reduced) return;
    if (!ambientOn.current && !muted) {
      // Latch optimistically (a re-fire mustn't double-start), un-latch on
      // failure so the NEXT spin retries instead of staying silent forever.
      ambientOn.current = true;
      void loop('ambient').then((ok) => {
        if (!ok) ambientOn.current = false;
      });
    }
    play('start');
  }, [phase, spin?.nonce, reduced, muted, play, loop]);

  // Per-cell tick: EVERY reel calls this as one of its Pokémon centers on the
  // winning line, so multi-reel spins sound multi-reel. The ~18ms floor only
  // collapses the rare case where two reels cross within a blink (heard as one
  // tick anyway) — at the new peak speed a single reel's crossings are ~54ms
  // apart, so no reel ever drops its own ticks.
  const lastTickAt = useRef(0);
  const handleCellCross = useCallback(() => {
    const now = performance.now();
    if (now - lastTickAt.current < 18) return;
    lastTickAt.current = now;
    sfx('reelTick');
  }, [sfx]);

  // Mute must silence the already-running ambient loop, not just future plays.
  useEffect(() => {
    if (muted) {
      halt('ambient');
      ambientOn.current = false;
    }
  }, [muted, halt]);

  // Reel-stop clacks: the stack owns its per-column settle internally, so fire a
  // mechanical clack at each column's stop time from here (cleared on teardown).
  // Reduced motion has no reel travel to punctuate (ReelStrip finishes on a 0ms
  // timeout and the reveal beats collapse to 0), so these would clack seconds
  // later over an already-landed card — same guard as the tension effect below.
  useEffect(() => {
    if (phase !== 'spinning' || reduced) return;
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
  }, [phase, spin?.nonce, reels, reduced, sfx, play]);

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

  // Sell-back confirmation, mounted OUTSIDE the reveal stage on purpose.
  // The in-card "+RM x credited" footer dies with the stage — auto-conclude
  // clears the reveal ~1.4s after the last card, and a sell still in flight at
  // expiry never renders it at all — so the player could be left with a card
  // gone from the vault and nothing on screen saying the money arrived. This is
  // the same confirmation the vault gives after a delivery request.
  //
  // A multi-reel batch is sold card by card, so the toast RUNS A TOTAL rather
  // than being overwritten by each sale: after selling five, "credited RM 12"
  // (the last card) understates what actually landed, and the player has no
  // other running figure on screen. Same shape as the vault's bulk-sell notice.
  // `seq` bumps per sale so an identical string still restarts the countdown
  // (see SuccessToast's nonce) — without it the 2nd sale of two equal-priced
  // cards would inherit the 1st toast's remaining time.
  const [sellToast, setSellToast] = useState<{
    text: string;
    seq: number;
    tone: 'success' | 'error';
  } | null>(null);
  const sellRun = useRef({ count: 0, total: 0, seq: 0 });
  const handleSold = useCallback(
    (newBalance: number, amount: number) => {
      applyBalance(newBalance);
      const run = sellRun.current;
      run.count += 1;
      run.total += amount;
      run.seq += 1;
      setSellToast({
        text:
          run.count === 1
            ? `Sold — ${rm(amount)} credited to your balance.`
            : `Sold ${run.count} cards — ${rm(run.total)} credited to your balance.`,
        seq: run.seq,
        tone: 'success',
      });
    },
    [applyBalance],
  );
  // The failure half of the same channel (#514). A sell that fails AFTER the
  // 30s clock runs out is swept to 'vaulted' with every other unsold card, so
  // the reveal's own red line never renders and the footer says only "Stored in
  // your vault" — true, but silent about the thing the player needs to know and
  // identical to a card they never touched. Reporting it here puts it on a
  // surface that survives the stage's auto-conclude, exactly as handleSold does.
  //
  // Bumps `seq` ONLY — never count/total. A failure is not a sale, and folding
  // it into the run would make the next real sale read "Sold 2 cards".
  const handleSellFailed = useCallback((message: string) => {
    const run = sellRun.current;
    run.seq += 1;
    setSellToast({ text: message, seq: run.seq, tone: 'error' });
  }, []);
  // Dismissal ends the run: the next sale starts counting from one again. `seq`
  // is NOT reset — it only has to keep changing, and reusing a value could
  // collide with the key React is still holding.
  const closeSellToast = useCallback(() => {
    sellRun.current = { count: 0, total: 0, seq: sellRun.current.seq };
    setSellToast(null);
  }, []);

  // Type predicate, not an inline comparison: it narrows `phase` to RevealPhase
  // at the <RevealStage> call site below, so the overlay can never be handed a
  // phase it does not render.
  const inReveal = isRevealPhase(phase);
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
            must never re-enable sideways panning.
            aria-busy covers 'resolving' too: that's the pre-spin server
            round-trip, where nothing moves yet but the machine IS busy and the
            Spin button is already locked. */}
        <div
          data-testid="slot-stage"
          className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-fluid"
          aria-busy={phase === 'spinning' || phase === 'resolving'}
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
                  frozen={inReveal}
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
                  demo={demoReveal}
                  locked={lockedReveal}
                  onSignUp={demoReveal ? () => openAuth('signup') : undefined}
                  onSkip={skipToCards}
                  onConclude={handleConclude}
                  onCloseInstant={closeInstantWindow}
                  onSellBack={sellBackPull}
                  onReveal={revealPull}
                  onSold={handleSold}
                  onSellFailed={handleSellFailed}
                  sfx={sfx}
                  vibrate={vibrate}
                  play={play}
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
              ) : isFreeRip ? (
                <span>Your free rip from Tasks — nothing charged</span>
              ) : isFreePack ? (
                <span>Your free welcome pack — nothing charged</span>
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
                  : isFreeRip
                    ? 'Spin Free Rip'
                    : isFreePack
                      ? 'Open Free Pack'
                      : hasSpun
                        ? 'Spin again'
                        : 'Spin'
            }
            muted={muted}
            onSpin={handleRoll}
            onToggleMute={toggleMuted}
            onOpenOdds={() => setOddsOpen(true)}
            onAddReel={addReel}
            onRemoveReel={removeReel}
            // The free claim buys exactly ONE open — no reels to add or drop.
            addDisabled={
              isFreePack || isFreeRip || reels >= 3 || !canAdjustReels
            }
            removeDisabled={
              isFreePack || isFreeRip || reels <= 1 || !canAdjustReels
            }
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
                  {/* A link, not openTopUp(): the sheet renders at z-[70]
                      under this z-[100] room. /me is the page that carries
                      the TopUpButton — the vault has no top-up control. */}
                  <Link
                    href="/me"
                    className="font-bold text-buyback-fg underline underline-offset-2 hover:text-buyback-fg"
                  >
                    Top up your balance →
                  </Link>
                </>
              )}
            </p>
          )}
        </div>
      </VaultRoom>

      {/* Always mounted, message=null when idle: the live region must pre-exist
          its message for screen readers to announce it (see SuccessToast). */}
      <SuccessToast
        message={sellToast?.text ?? null}
        nonce={sellToast?.seq}
        tone={sellToast?.tone}
        onClose={closeSellToast}
      />

      {/* Single consolidated announcement (settle-only). */}
      <p role="status" aria-live="polite" className="sr-only">
        {announce}
      </p>

      <OddsSheet
        open={oddsOpen}
        onClose={() => setOddsOpen(false)}
        odds={publishedOdds ? publishedOddsRows(publishedOdds) : null}
        range={valueRange}
        expectedValue={expectedValue}
        tierRanges={tierRanges}
      />
    </div>
  );
}
