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
import { usePackGifts } from '@/lib/use-pack-gifts';
import {
  giftsUsed,
  paidCost as costAfterGifts,
  spinBetLabel,
} from '@/lib/vault-packs';
import type { WonCard } from '@/lib/actions/packs';
import { sellBackPull } from '@/lib/actions/vault';
import { useTopUp } from '@/components/app-shell/TopUpProvider';
import { useVaultDot } from '@/components/app-shell/VaultDotProvider';
import { useSound } from '@/lib/use-sound';
import { rm, affordable } from '@/lib/format';
import { sellBackNotice } from '@/lib/buyback-copy';
import { trackPixel } from '@/lib/pixel';
import { cn } from '@/lib/utils';
import {
  type ResolvedPack,
  type Pack,
  type PackCard,
  type Rarity,
  FREE_WELCOME_CATEGORY,
  ODDS,
  TICKET_ART,
  isTicketPack,
  ticketTotal,
} from '@/lib/packs-data';
import type { RecentPull } from '@/lib/data/packs';
// The spin/open seam. Every route a press can take — the paid batch Open, the
// free welcome pack, a task's free rip, and the guest demo Spin — comes back
// from here in ONE shape, so nothing below this line re-forks on "is it a demo".
import {
  rollMode,
  type RollDeps,
  type RolledBatch,
  type RollRequest,
} from '@/lib/roll-batch';
import {
  pullOddsRows,
  poolValueRange,
  poolExpectedValue,
  ticketOddsPool,
  tierValueRanges,
  type PullOdds,
} from '@/lib/packs-format';
import { rarityRgb, RARITY_ORDER } from '@/lib/rarity';
import { columnDurationMs, SETTLE_MS, CRAWL_MS } from '@/lib/vault-reel';
import { isPokemonPack, resolveCardPokemon } from '@/lib/resolve-card-pokemon';
import { spriteGif } from '@/lib/mock/pokedex';
import type { ColumnWinner } from './SlotReelStack';
import { Reel3dStack } from '@/components/reel-3d/Reel3dStack';
import {
  buildDecoyPool,
  buildIdlePool,
  HREEL_IDLE_POOL_MAX,
  NEUTRAL_CARD_SPRITE,
  ticketReelLabel,
  type HReelCell,
} from '@/lib/hreel';
import { SlotStatusBar } from './SlotStatusBar';
import { SlotControls } from './SlotControls';
import { OddsSheet } from './OddsSheet';
import { VaultRoom } from './VaultRoom';
import { Meter } from './Meter';
import { RevealStage } from './RevealStage';
import { TicketReveal } from './TicketReveal';
import { SuccessToast } from '@/components/ui/SuccessToast';
import { CARD_BACK_SRC, CASE_EDGE_SRC } from './SlabCard';
import { hasRoll, isRevealState, usePackMachine } from './usePackMachine';

// The server actions a press can reach — injected into the roll seam (see
// roll-batch.ts), so the machine's own suite can fake them.
const ROLL_DEPS: RollDeps = {
  openBatch,
  openPack,
  spinTaskReward,
  now: () => Date.now(),
  random: () => Math.random(),
};
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
 *  color + the column's Pokémon sprite (custom image ⇢ dex gif ⇢ Poké Ball).
 *  In a non-Pokémon pack: custom image ⇢ neutral card-back — never a Pokémon. */
function winnerFor(card: WonCard, pokemon: boolean): ColumnWinner {
  if (card.tickets != null) {
    return {
      dex: null,
      image: TICKET_ART,
      label: ticketReelLabel(card.tickets),
      name: card.name,
      rarity: card.rarity,
      rarityRgb: rarityRgb(card.rarity),
    };
  }
  // resolveCardPokemon takes the wire's snake_case; the view is camelCase.
  const r = resolveCardPokemon(
    {
      name: card.name,
      set: card.set,
      pokemon_dex: card.pokemonDex,
      sprite_image: card.spriteImage,
    },
    { pokemon },
  );
  const custom =
    card.spriteImage && card.spriteImage.trim() !== ''
      ? card.spriteImage
      : null;
  return {
    dex: r.dex,
    image:
      custom ??
      (r.dex !== null
        ? undefined
        : pokemon
          ? POKEBALL_PLACEHOLDER
          : NEUTRAL_CARD_SPRITE),
    name: r.name ?? card.name,
    rarity: card.rarity as ColumnWinner['rarity'],
    rarityRgb: rarityRgb(card.rarity),
  };
}

export default function SlotMachineClient({
  pack,
  recentPulls,
  count,
  pullOdds,
  pool = [],
  demoPool = null,
  freeRipClaimId = null,
}: {
  pack: ResolvedPack & Pack;
  recentPulls: RecentPull[];
  count: number;
  /** The Pull Odds for the OddsSheet; null = not set. */
  pullOdds: PullOdds | null;
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
  const { muted, toggleMuted, play, playReveal, vibrate, sfx } = useSound();

  // The one-time free welcome pack. It is opened SINGLY through the single-open
  // route — the backend rejects a batch on this category outright — so the reel
  // count is pinned to 1 and every bet/quantity control goes away.
  const isFreePack = pack.categoryId === FREE_WELCOME_CATEGORY;
  // A task's free rip. Like the welcome pack it is exactly ONE open at no cost,
  // but it spends an entitlement rather than a one-time eligibility, and the
  // card it yields is a reward pull — sellable on the spot like any pulled
  // card, except a DAILY task's rip before the first paid open, which carries
  // the welcome-pack lock (the backend's `locked` says which).
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
  const cost = pack.priceMyr;
  // Reel count — prop is the initial value (already clamped from ?count=); the
  // player adds/removes reels in-machine. cost * reels is the batch price.
  const [reels, setReels] = useState(isFreePack || isFreeRip ? 1 : count);

  // Vault packs (spec 2026-10-07 §1). Use order on every open is gifts →
  // bonus credit → normal credit; gifts cover rows first, and only on the
  // PAID route — a free rip / welcome pack is already free and wins. The count
  // is keyed to the customer + pack it was read for (like PackDetailClient),
  // read on the client only, and a press waits for that read for whoever is
  // signed in NOW — a server seed would be a second call, and an account switch
  // without a reload, or a Back-restored page, would otherwise act on a stale
  // count (stale-low charges full price for a gift-covered row). invalidate()
  // = re-read (a stale-gift refusal, Retry). A failed read settles at 0 —
  // the price the screen shows, so an outage never blocks a paid spin — and
  // says so with a Retry.
  const customerId = customer?.id ?? null;
  const {
    held,
    pending: giftsPending,
    failed: giftsFailed,
    consume: consumeGifts,
    invalidate: rereadGifts,
  } = usePackGifts(customerId, pack.id);
  const usableGifts = mode === 'paid' ? held : 0;
  const vaultGifts = giftsUsed(reels, usableGifts);
  // What this press actually charges: the rows no gift covers.
  const paidCost = costAfterGifts(cost, reels, usableGifts);
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
  // Pokémon cells render their dex sprite (spriteGif; for seeded entries that IS
  // the linked sprite); a dex-less custom sprite (One Piece) rides on the cell as
  // `image`, so a One Piece pack flickers its own characters, not the fallback.
  const ticketPack = isTicketPack(pack);
  // A ticket pack filed under Pokémon must still never fall back to Pokémon.
  const pokemonPack = isPokemonPack(pack.categoryId) && !ticketPack;
  const basePool = useMemo<HReelCell[]>(
    () => buildDecoyPool(pool, { pokemon: pokemonPack }),
    [pool, pokemonPack],
  );
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
  // What the odds sheet sums: card prices, or on a ticket pack the ticket amounts.
  const oddsPool = useMemo(
    () => (ticketPack ? ticketOddsPool(pool) : pool),
    [ticketPack, pool],
  );
  const valueRange = useMemo(() => poolValueRange(oddsPool), [oddsPool]);
  // Per-tier ranges, so the sheet matches the pack page's odds panel row for row.
  const tierRanges = useMemo(() => tierValueRanges(oddsPool), [oddsPool]);
  // Expected value over the Pull Odds tiers — the sheet's top row, same as the
  // pack page's panel.
  const expectedValue = useMemo(
    () => (pullOdds ? poolExpectedValue(oddsPool, pullOdds.tiers) : null),
    [oddsPool, pullOdds],
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
  // Winner tile screen rects, captured by the stack, consumed by the tile→slab
  // morph in RevealStage (spec decision #16). Reset per spin.
  const winnerRects = useRef<(DOMRect | null)[]>([]);

  // The reveal session: phase, the roll that rides with it, and its timers.
  // The money rules after a press (balance, gifts, Vault dot, pixel) are
  // decided by pressOutcome inside it and carried out through these effects.
  const machine = usePackMachine({
    // The live identity every post-await guard compares a roll's forId to.
    customerId,
    reduced,
    deps: ROLL_DEPS,
    effects: {
      applyBalance,
      refetchBalance,
      refreshVaultDot,
      resetGifts: rereadGifts,
      consumeGifts,
      // Ads funnel (lib/pixel.ts): a pack opened WITH BALANCE — auxiliary
      // analysis, never a Purchase (the money came in as a top-up already).
      trackOpen: (rows) =>
        trackPixel('OpenPack', {
          content_ids: [pack.id],
          content_name: pack.name,
          num_items: rows,
          value: Math.round(cost * rows * 100) / 100,
          currency: 'MYR',
        }),
      openLogin: () => openAuth('login'),
    },
    toWinner: (card) => winnerFor(card, pokemonPack),
    onPress: () => {
      winnerRects.current = [];
      sfx('ratchet');
    },
    onSettled: (held) => {
      // Prepend one RecentPull per card won in this batch — real wins only; a
      // demo draw is theater and must never appear in the live pull ticker.
      // Read off the ROLL, not the machine: a login mid-flight flips the live
      // isDemo and would push theater cards into the live ticker. A ticket is
      // no pull, so it stays out too.
      if (held.mode !== 'demo' && ticketTotal(held.cards) === 0) {
        recordPulls(held);
      }
      // One rising gesture, not two: the `riser` sweep alone carries the flood
      // beat. The old synth `swell` was a second, redundant rise stacked on
      // top — dropped so the lead-up reads as one swell. (The looping reveal
      // bed that used to fade in under it was removed 2026-08-04 — operator
      // call: the face-down wait plays dry.)
      play('riser');
    },
  });
  const { state } = machine;
  const phase = state.phase;
  // The roll on screen: from the reel's launch until the reveal concludes.
  const roll = hasRoll(state) ? state : null;
  const spinNonce = roll?.batch.spinAt;
  // Type guard, not an inline comparison: it narrows to the reveal range, so
  // <RevealStage> can never be handed a phase it does not render.
  const reveal = isRevealState(state) ? state : null;
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
    if (phase !== 'spinning') return;
    for (const src of [CARD_BACK_SRC, CASE_EDGE_SRC])
      preload(src, { as: 'image' });
  }, [phase]);
  // Commit the stage scale only while idle: cellSize is a ReelStrip engine
  // dependency (pitch/travel/target), so resizing the window mid-spin would
  // restart the rAF timeline under the player's eyes.
  // Adjusted while rendering, so React re-renders with the new size before
  // anything commits — same frame the old render-time ref write produced.
  const [cellSize, setCellSize] = useState(idealCell);
  if (phase === 'idle' && cellSize !== idealCell) setCellSize(idealCell);
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
    // buildIdlePool shuffles (Math.random), so it cannot run during render;
    // the reshuffle belongs to the idle transition, not to a derived value.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- impure reshuffle on entering idle
    setDecoyPools(Array.from({ length: reels }, () => buildIdlePool(basePool)));
  }, [phase, reels, basePool]);
  // A just-added reel must show pack cards in the SAME render (the reshuffle
  // effect only lands next tick) — pad with cappedBase instead of letting
  // ReelStrip fall back to the non-pack DECOY_DEXES for a frame.
  const renderPools =
    decoyPools.length >= reels
      ? decoyPools
      : Array.from({ length: reels }, (_, i) => decoyPools[i] ?? cappedBase);
  const [oddsOpen, setOddsOpen] = useState(false);
  const [tension, setTension] = useState(false);
  // Meter roll direction cue for the reel add/remove ('up'/'down', auto-resets).
  const [meterDir, setMeterDir] = useState<'up' | 'down' | null>(null);
  const meterTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (meterTimer.current !== null) clearTimeout(meterTimer.current);
    },
    [],
  );

  // A free open is always affordable — and must not wait on the balance read,
  // which is null while it loads and would leave a brand-new account (balance
  // RM 0, the exact audience) staring at a disabled Spin button.
  // A gift-only press (paidCost 0) charges nothing either.
  const canAfford =
    isFreePack ||
    isFreeRip ||
    paidCost === 0 ||
    (balance !== null && affordable(balance, paidCost));
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
    if (mode === 'paid' && giftsPending) return;
    play('tap');

    // Which odds a demo Spin samples on: the pack's Pull Odds, falling
    // back to the static ODDS. Ignored by every paying route.
    const rows = pullOdds ? pullOddsRows(pullOdds) : null;
    const request: RollRequest = {
      mode,
      packId: pack.id,
      reels,
      gifts: vaultGifts,
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
        !affordable(balance, paidCost)
      ) {
        machine.refuse('Not enough balance to spin.', true);
        return;
      }
    }
    // ONE call. Nothing retries it: a rejection or a transport failure may
    // already have debited, and a second attempt would charge twice.
    await machine.press(request);
  }

  // The live ticker's rows for a settled real batch.
  function recordPulls(held: RolledBatch) {
    // Event-time timestamp: runs from the settle, never during render.
    const now = Date.now();
    const justPulled: RecentPull[] = held.cards.map((won, i) => ({
      // The won card IS the feed row's card (one view); the rest is the
      // pull's own display fields.
      ...won,
      id: `${won.handle}-${now}-${i}`,
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

  // The concluded reveal used to offer "Spin again" (conclude + replay in one
  // press) and "Done". Both are gone — RevealStage auto-concludes to the idle
  // machine now — so the conclude→replay chaining that lived here (a ref flag,
  // a handleRoll ref, and a phase effect to fire the replay one render later)
  // went with them. A new roll is a press on the Spin button again, nothing else.

  // Reel audio: launch whoosh at reel takeoff. The spinning sound itself is the
  // per-cell reelTick below (one click per Pokémon crossing — tracks the real
  // reel speed, which a fixed-tempo loop file cannot; the slot-spin.mp3 loop was
  // tried and replaced 2026-08-04). Reduced motion has no reel travel — same
  // guard as the clacks below. Background music belongs to the app shell.
  useEffect(() => {
    if (phase !== 'spinning' || reduced) return;
    play('start');
  }, [phase, spinNonce, reduced, play]);

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
  }, [phase, spinNonce, reels, reduced, sfx, play]);

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
  }, [phase, spinNonce, reels, reduced, sfx]);

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
  const sellRun = useRef({ count: 0, total: 0, held: 0, seq: 0 });
  const handleSold = useCallback(
    (newBalance: number, amount: number, held: number) => {
      applyBalance(newBalance);
      const run = sellRun.current;
      run.count += 1;
      run.total += amount;
      run.held += held;
      run.seq += 1;
      const notice = sellBackNotice(run.total, run.held);
      setSellToast({
        text:
          run.count === 1
            ? `Sold — ${notice}`
            : `Sold ${run.count} cards — ${notice}`,
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
    sellRun.current = {
      count: 0,
      total: 0,
      held: 0,
      seq: sellRun.current.seq,
    };
    setSellToast(null);
  }, []);

  const inReveal = reveal !== null;
  // The reveal renders the mode of the roll it is SHOWING, never the mode the
  // machine is in now: a guest who takes the demo's "Sign up & pull for real"
  // CTA becomes a customer mid-reveal, which flips the live `isDemo` false.
  const demoReveal = reveal?.batch.mode === 'demo';
  // Machine fully fades out once the reveal moves past the flood beat (spec #19).
  const machineHidden = inReveal && phase !== 'flood';
  // No rarity color anywhere until the reel settles: flood derives from phase.
  const floodRgb = reveal ? rarityRgb(topRarityOf(reveal.batch.cards)) : null;
  // Sprite for each landed tile's tile→slab morph (custom image, else dex gif).
  const spriteSrcs =
    roll?.winners.map(
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
        blast={machine.blast}
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
                {/* The 3D curved strip where the device allows it; the DOM
                    reel (SlotReelStack) everywhere else, same contract. */}
                <Reel3dStack
                  count={reels}
                  cellSize={cellSize}
                  spinKey={spinNonce ?? 'idle'}
                  winners={roll?.winners ?? null}
                  reduced={reduced}
                  decoyPools={renderPools}
                  onAllSettled={machine.settle}
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
            {reveal && (
              // [container-type:size] makes this overlay the size container the
              // SlabCard width formula queries (100cqh = stage height), so the
              // card + sell footer always fit the visible stage — the pt-14
              // downward bias (old spec #29) is gone; true centering replaces
              // it now that the card can never crowd the top plate. The overlay
              // scrolls only as a last resort (RevealStage m-auto keeps the top
              // edge reachable then).
              <div className="absolute inset-0 flex overflow-y-auto overflow-x-hidden px-fluid py-2 [container-type:size]">
                {/* The ROLL decides, never the pack: this shows the batch that
                    was won, however the catalog reads now. */}
                {ticketTotal(reveal.batch.cards) > 0 ? (
                  <TicketReveal
                    phase={reveal.phase}
                    cards={reveal.batch.cards}
                    reduced={reduced}
                    demo={demoReveal}
                    onSignUp={demoReveal ? () => openAuth('signup') : undefined}
                    onSkip={machine.skip}
                    onConclude={machine.conclude}
                    vibrate={vibrate}
                    playReveal={playReveal}
                  />
                ) : (
                  <RevealStage
                    phase={reveal.phase}
                    cards={reveal.batch.cards}
                    offers={reveal.batch.offers}
                    // Each ReelStrip reports its winner rect BEFORE it calls
                    // onAllSettled, and this overlay only mounts after that
                    // settle's phase change, so the array is complete here.
                    // eslint-disable-next-line react-hooks/refs -- filled before the settle re-render reads it
                    winnerRects={winnerRects.current}
                    spriteSrcs={spriteSrcs}
                    reduced={reduced}
                    demo={demoReveal}
                    locked={reveal.batch.locked}
                    onSignUp={demoReveal ? () => openAuth('signup') : undefined}
                    onSkip={machine.skip}
                    onConclude={machine.conclude}
                    onCloseInstant={closeInstantWindow}
                    onSellBack={sellBackPull}
                    onReveal={revealPull}
                    onSold={handleSold}
                    onSellFailed={handleSellFailed}
                    sfx={sfx}
                    vibrate={vibrate}
                    playReveal={playReveal}
                    play={play}
                  />
                )}
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
                <span>
                  Free demo — no credits charged, no real{' '}
                  {ticketPack ? 'tickets' : 'cards'} won
                </span>
              ) : isFreeRip ? (
                <span>Your free rip from Tasks — nothing charged</span>
              ) : isFreePack ? (
                <span>Your free welcome pack — nothing charged</span>
              ) : vaultGifts > 0 ? (
                // "Bet Vault x1" / "Bet Vault x1 + RM300.00" — the gifts
                // already say how many rows, so no "× N" chip.
                <span>{spinBetLabel(reels, vaultGifts, cost)}</span>
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
              machine.cooldown ||
              modeUndecided ||
              (mode === 'paid' && giftsPending) ||
              (customer != null && !canAfford)
            }
            label={
              isDemo
                ? machine.hasSpun
                  ? 'Spin again'
                  : 'Demo spin'
                : !customer
                  ? 'Log in to spin'
                  : isFreeRip
                    ? 'Spin Free Rip'
                    : isFreePack
                      ? 'Open Free Pack'
                      : machine.hasSpun
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
          {machine.error && (
            <p
              role="alert"
              className="mt-3 text-center text-[12px] text-red-300"
            >
              {machine.error}
              {machine.needsTopUp && (
                <>
                  {' '}
                  {balance !== null && paidCost - balance > 0 && (
                    <>You&apos;re {rm(paidCost - balance)} short. </>
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
          {mode === 'paid' && giftsFailed && (
            <p className="mt-2 text-center text-[12px] text-white/50">
              Couldn&apos;t check your vault packs —{' '}
              <button
                type="button"
                onClick={rereadGifts}
                className="font-semibold text-white/70 underline underline-offset-2 hover:text-white"
              >
                Retry
              </button>
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
        {machine.announce}
      </p>

      <OddsSheet
        open={oddsOpen}
        onClose={() => setOddsOpen(false)}
        odds={pullOdds ? pullOddsRows(pullOdds) : null}
        range={valueRange}
        expectedValue={expectedValue}
        tierRanges={tierRanges}
        tickets={ticketPack}
      />
    </div>
  );
}
