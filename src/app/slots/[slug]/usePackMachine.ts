'use client';
// The reveal session of one slot machine: which phase it is in, the roll that
// rides with that phase, and the timers that move it. One press (an Open, or a
// guest demo Spin) goes
//
//   idle → resolving (server round-trip) → spinning (the reel turns) → flood
//        → transform → review (sell window) → idle
//
// and every piece of data is carried BY the phase it belongs to, so a phase
// can never be reached without its roll, and leaving a phase drops its roll in
// the same step. The transition table lives in lib/reveal-phase.ts (pure,
// tested); this hook is its only driver.
//
// The money decisions after a press come from lib/press-outcome.ts (pure,
// tested); this hook carries them out through the injected `effects`, so the
// component never decides a balance, a gift count or a Vault dot itself.
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
} from 'react';
import {
  rollBatch,
  rollBlocker,
  type RollDeps,
  type RollRequest,
  type RolledBatch,
} from '@/lib/roll-batch';
import { pressOutcome } from '@/lib/press-outcome';
import {
  blastMs,
  isRevealPhase,
  nextPhase,
  revealTimings,
  type PhaseEvent,
  type RevealPhase,
} from '@/lib/reveal-phase';
import { spinTotalMs } from '@/lib/vault-reel';
import { isTopRarity } from '@/lib/rarity';
import { rm } from '@/lib/format';
import { ticketCount, ticketTotal } from '@/lib/packs-data';
import { logger } from '@/lib/logger';
import type { WonCard } from '@/lib/actions/packs';
import type { ColumnWinner } from './SlotReelStack';

/** Spin stays locked this long after a settle (a double-tap guard). */
const COOLDOWN_MS = 600;
/** Past the reel engine's own run time before the watchdog settles for it. */
const WATCHDOG_SLACK_MS = 2000;

/** One roll and what the reel shows for it. */
export interface HeldRoll {
  /** The whole batch exactly as rollBatch returned it. Its offers render
   *  only once the phase reaches the reveal (spoiler guard). */
  batch: RolledBatch;
  /** Cosmetic reel winners, one per card (partial if the mapping threw). */
  winners: ColumnWinner[];
  /** Reels the press asked for — sizes the settle watchdog. */
  reels: number;
}

export type RevealState = { phase: RevealPhase } & HeldRoll;
/** A phase with a roll on screen: from the reel's launch to the conclude. */
export type RollState = ({ phase: 'spinning' } & HeldRoll) | RevealState;

export type MachineState =
  { phase: 'idle' } | { phase: 'resolving' } | RollState;

/** True from the reel's launch until the reveal concludes. */
export function hasRoll(s: MachineState): s is RollState {
  return s.phase !== 'idle' && s.phase !== 'resolving';
}

/** True while the reveal overlay is mounted, narrowing to its phase range. */
export function isRevealState(s: MachineState): s is RevealState {
  return isRevealPhase(s.phase);
}

/** What the hook does on the caller's side of the money path. */
export interface PackMachineEffects {
  /** Paint a balance the server returned. */
  applyBalance: (balance: number) => void;
  /** Re-read the balance; awaited before the button unlocks. */
  refetchBalance: () => Promise<unknown>;
  refreshVaultDot: () => void;
  /** The gift count on screen may be wrong: re-read it. */
  resetGifts: () => void;
  /** An open spent this many gifts. */
  consumeGifts: (used: number) => void;
  /** Fire the OpenPack pixel for this many paid rows. */
  trackOpen: (rows: number) => void;
  openLogin: () => void;
}

export interface PackMachineOptions {
  /** Who is signed in NOW. Read live by every guard after an await. */
  customerId: string | null;
  reduced: boolean;
  /** The server actions rollBatch calls — injected so a test can fake them. */
  deps: RollDeps;
  effects: PackMachineEffects;
  /** Cosmetic reel winner for a card. May throw; the paid result lands anyway. */
  toWinner: (card: WonCard) => ColumnWinner;
  /** A press passed every guard and is about to roll. */
  onPress: () => void;
  /** A roll settled for the account signed in now, and the reveal begins. */
  onSettled: (batch: RolledBatch) => void;
}

type Action =
  | { event: Exclude<PhaseEvent, 'rolled' | 'demo-spin' | 'settle'> }
  | { event: 'rolled' | 'settle'; held: HeldRoll };

const IDLE: MachineState = { phase: 'idle' };

function reduce(s: MachineState, a: Action): MachineState {
  // The demo has no round-trip, so its roll arrives straight from idle.
  const event: PhaseEvent =
    a.event === 'rolled' && a.held.batch.mode === 'demo'
      ? 'demo-spin'
      : a.event;
  const to = nextPhase(s.phase, event);
  if (to === s.phase) return s;
  if (to === 'idle' || to === 'resolving') return { phase: to };
  const held: HeldRoll | null =
    'held' in a
      ? a.held
      : hasRoll(s)
        ? { batch: s.batch, winners: s.winners, reels: s.reels }
        : null;
  // Unreachable by the table (every edge into a roll phase carries or keeps a
  // roll); holding beats rendering a reveal with nothing in it.
  if (held === null) return s;
  return { phase: to, ...held };
}

/** A top-rarity card in the batch: the room blast and the "Big win!" line. */
const isBigWin = (batch: RolledBatch) =>
  batch.cards.some((c) => isTopRarity(c.rarity));

/** The screen-reader line for a settled roll. */
function announceFor(batch: RolledBatch): string {
  const big = isBigWin(batch);
  const prefix = batch.mode === 'demo' ? 'Demo — ' : big ? 'Big win! ' : '';
  const tickets = ticketTotal(batch.cards);
  const first = batch.cards[0];
  if (tickets > 0) return `${prefix}Won ${ticketCount(tickets)}`;
  if (batch.cards.length === 1 && first) {
    const value = first.priceMyr != null ? rm(first.priceMyr) : '—';
    return `${prefix}Won ${first.name}, ${value}`;
  }
  return `${prefix}Won ${batch.cards.length} cards`;
}

export function usePackMachine(opts: PackMachineOptions) {
  const [state, dispatch] = useReducer(reduce, IDLE);
  const [error, setError] = useState<string | null>(null);
  const [needsTopUp, setNeedsTopUp] = useState(false);
  // "Spin again" persists after the reveal concludes back to idle (spec #27).
  const [hasSpun, setHasSpun] = useState(false);
  const [cooldown, setCooldown] = useState(false);
  const [blast, setBlast] = useState(false);
  // Kept across conclude: the status line holds its text until the next press.
  const [announce, setAnnounce] = useState('');

  // The latest options, for the stable callbacks below. `settle` can be
  // invoked from a STALE closure — the reel prop, the watchdog, press's own
  // mapping catch captured at press time — so a closed-over customer id could
  // compare against the account that rolled rather than the one signed in NOW.
  // Mirrored in a layout effect rather than during render: it lands in the
  // commit, before any passive effect, rAF or timer that could call settle.
  const live = useRef(opts);
  useLayoutEffect(() => {
    live.current = opts;
  });

  // Held from the press until the reel settles. `settle` reads (and nulls) it,
  // which is what makes a second settle — the reel and the watchdog racing —
  // a no-op.
  const pending = useRef<HeldRoll | null>(null);

  const timers = useRef({ flood: 0, transform: 0, blast: 0, cooldown: 0 });
  const clearRevealTimers = useCallback(() => {
    clearTimeout(timers.current.flood);
    clearTimeout(timers.current.transform);
  }, []);
  useEffect(() => {
    const t = timers.current;
    return () => {
      clearTimeout(t.flood);
      clearTimeout(t.transform);
      clearTimeout(t.blast);
      clearTimeout(t.cooldown);
    };
  }, []);

  /** The reel landed (or the watchdog says so). Idempotent. */
  const settle = useCallback(() => {
    const held = pending.current;
    if (!held) return;
    pending.current = null;
    const { customerId, reduced, effects, onSettled } = live.current;
    const { batch } = held;

    // Identity switched mid-roll (token refresh, multi-tab login): the charge
    // and the won cards belong to the account that rolled. Drop the ENTIRE
    // result — suppressing only the balance would still show the previous
    // account's prizes and sell-back offers. That account keeps its cards
    // (server-side vault) and sees its balance on next load.
    //
    // A roll bound to no account is exempt, and must be: a demo has no charge,
    // pull or offer to protect, while comparing null against a live customer
    // id would discard any demo a login happened to land in the middle of.
    if (batch.forId !== null && batch.forId !== customerId) {
      dispatch({ event: 'abort' });
      return;
    }

    // Usually a no-op — press applied this value at charge time. It only lands
    // when identity left and came back across the roll (A→B→A): the
    // charge-time guard skipped B, and the guard above just confirmed A.
    if (batch.balance != null) effects.applyBalance(batch.balance);
    dispatch({ event: 'settle', held });
    setAnnounce(announceFor(batch));

    const t = timers.current;
    const blastFor = blastMs(isBigWin(batch), reduced);
    if (blastFor > 0) {
      setBlast(true);
      clearTimeout(t.blast);
      t.blast = window.setTimeout(() => setBlast(false), blastFor);
    }

    // Flood the room, morph the tiles into slabs, open the sell window. Both
    // beats are absolute delays from this settle (revealTimings), and under
    // reduced motion both are 0 — the reducer still composes them in order.
    const beats = revealTimings(batch.cards.length, reduced);
    clearRevealTimers();
    t.flood = window.setTimeout(
      () => dispatch({ event: 'morph' }),
      beats.floodMs,
    );
    t.transform = window.setTimeout(
      () => dispatch({ event: 'reveal' }),
      beats.reviewMs,
    );

    setCooldown(true);
    clearTimeout(t.cooldown);
    t.cooldown = window.setTimeout(() => setCooldown(false), COOLDOWN_MS);
    onSettled(batch);
  }, [clearRevealTimers]);

  /**
   * One press, one roll. Ignored unless idle. ONE rollBatch call: nothing here
   * retries it, because a failure may already have debited.
   */
  async function press(request: RollRequest): Promise<void> {
    if (state.phase !== 'idle') return;
    // Refused before a single piece of state moves.
    const blocked = rollBlocker(request);
    if (blocked) {
      setError(blocked);
      return;
    }
    setError(null);
    setNeedsTopUp(false);
    setAnnounce('');
    setHasSpun(true);
    live.current.onPress();
    // The paying routes lock the button across the round-trip; the demo has
    // none and goes straight to spinning once its cards exist.
    if (request.mode !== 'demo') dispatch({ event: 'spin' });

    const res = await rollBatch(request, live.current.deps);
    // Read AFTER the await: the identity the outcome is guarded against is
    // whoever is signed in now, not whoever pressed.
    const { customerId, effects, toWinner } = live.current;
    const out = pressOutcome(res, customerId, request.gifts);

    if (out.kind === 'failed') {
      // Nothing spun, so the button must not read "Spin again" over the error.
      setHasSpun(false);
      if (out.resetGifts) effects.resetGifts();
      if (out.openLogin) effects.openLogin();
      // Shown BEFORE the refetch: on an unreachable server that refetch can
      // hang for the whole fetch timeout, and the screen must not look dead.
      setError(out.error);
      setNeedsTopUp(out.needsTopUp);
      if (out.refreshVaultDot) effects.refreshVaultDot();
      if (out.refetchBalance) {
        // Awaited, with the phase held on 'resolving' so Spin stays locked:
        // the balance on screen is the stale pre-charge figure and the charge
        // may have landed. A failing refetch must not block the unlock.
        try {
          await effects.refetchBalance();
        } catch (err) {
          logger.error('[slots] balance refetch after a failed press', err);
        }
      }
      dispatch({ event: 'abort' });
      return;
    }

    // The open already charged (the saga commits the charge before recording
    // pulls), so the debit paints now, not at settle. The cards are spoilers;
    // the balance never is.
    if (out.pixelRows > 0) effects.trackOpen(out.pixelRows);
    if (out.applyBalance != null) effects.applyBalance(out.applyBalance);
    if (out.consumeGifts > 0) effects.consumeGifts(out.consumeGifts);
    // The pulls are vaulted as of this response; the Vault tab otherwise only
    // re-reads on login and focus.
    if (out.refreshVaultDot) effects.refreshVaultDot();

    // The last mapping left: cosmetic reel winners. The customer is ALREADY
    // charged here, so a throw must still surface the result they paid for —
    // settle at once with the (possibly partial) winners rather than leave the
    // machine on a reel that cannot land.
    const winners: ColumnWinner[] = [];
    let mappingFailed = false;
    try {
      for (const card of out.batch.cards) winners.push(toWinner(card));
    } catch (err) {
      logger.error('[slots] post-charge mapping failed', err);
      mappingFailed = true;
    }
    const held: HeldRoll = { batch: out.batch, winners, reels: request.reels };
    pending.current = held;
    dispatch({ event: 'rolled', held });
    // Same batch as the dispatch above, so 'spinning' never renders.
    if (mappingFailed) settle();
  }

  // Settle watchdog: the customer is charged the moment the open returns ok,
  // but the reveal only lands when the reel reports completion. If that is
  // ever missed (a remounted column, a browser hiccup), force the same
  // idempotent settle, sized past the reel engine's own run time so it never
  // pre-empts a normal spin.
  const spinningKey = state.phase === 'spinning' ? state.batch.spinAt : null;
  const spinningReels = state.phase === 'spinning' ? state.reels : 0;
  useEffect(() => {
    if (spinningKey === null) return;
    const id = window.setTimeout(
      settle,
      spinTotalMs(spinningReels) + WATCHDOG_SLACK_MS,
    );
    return () => clearTimeout(id);
  }, [spinningKey, spinningReels, settle]);

  /** Fast-forward the post-landing theater to review. Never the spin itself. */
  const skip = useCallback(() => {
    clearRevealTimers();
    dispatch({ event: 'skip' });
  }, [clearRevealTimers]);

  /** Every card sold, kept or expired: back to the idle machine. */
  const conclude = useCallback(() => dispatch({ event: 'conclude' }), []);

  /** A press refused before the machine moved (logged out, can't afford). */
  const refuse = useCallback((message: string, topUp: boolean) => {
    setError(message);
    setNeedsTopUp(topUp);
  }, []);

  return {
    state,
    error,
    needsTopUp,
    hasSpun,
    cooldown,
    blast,
    announce,
    press,
    refuse,
    settle,
    skip,
    conclude,
  };
}
