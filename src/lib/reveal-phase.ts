// Pure phase + timing model for the spin→reveal choreography. No DOM, no React
// — see src/lib/__tests__/reveal-phase.test.ts. Sits beside vault-reel.ts, which
// owns the physics BEFORE this one: the reel's last column landing is the
// `settle` event below, and every beat after it is timed from here.
//
// Two DIFFERENT machines live in this file, deliberately not merged:
//
//   Phase     — machine-wide, one per spin. idle → the server round-trip → the
//               reel → the reveal theater → the sell window → idle. Driven by
//               events (a press, a server response, a timer, a tap).
//   SellState — per CARD, one per offer, and driven by a SERVER deadline rather
//               than by Phase. A card can be sold while its neighbour is still
//               idle, so these can never collapse into one value.
//
// RevealPhase is not a third machine: it is the Phase range during which the
// reveal overlay is mounted, narrowed by isRevealPhase so RevealStage can only
// be handed a phase it actually renders.

/* ------------------------------------------------------------------ *
 * Machine phase
 * ------------------------------------------------------------------ */

export type Phase =
  'idle' | 'resolving' | 'spinning' | 'flood' | 'transform' | 'review';

/** The phases during which the reveal overlay is mounted (see isRevealPhase). */
export type RevealPhase = Extract<Phase, 'flood' | 'transform' | 'review'>;

export type PhaseEvent =
  /** Spin pressed on the real machine — a server round-trip comes first. */
  | 'spin'
  /** Spin pressed in the guest demo — sampled client-side, the reels go now. */
  | 'demo-spin'
  /** openBatch/openPack/spinTaskReward returned ok: the charge has landed. */
  | 'rolled'
  /** Nothing to reveal: a failed open, a transport failure, or the settle
   *  guard finding a different customer signed in than the one who spun. */
  | 'abort'
  /** The reel reported completion (or the settle watchdog fired for it). */
  | 'settle'
  /** Flood beat over — the landed tiles morph into slabs. */
  | 'morph'
  /** Morph over — the cards are presentable and the sell window may open. */
  | 'reveal'
  /** Player tapped through the post-landing theater (never the spin itself). */
  | 'skip'
  /** Every card sold, kept or expired — clear the stage back to the machine. */
  | 'conclude';

// The legal transitions, and ONLY the legal ones: every entry below is a
// setPhase call site in SlotMachineClient, so an unlisted (phase, event) pair
// is a pair no reachable code path produces. nextPhase holds the phase for
// those rather than throwing — a charged player must never be stranded on a
// dead machine because a stale timer fired one beat late.
//
// Two edges look surprising and are not:
//   resolving --settle--> flood   the post-charge mapping catch settles a spin
//                                 whose reels never started (the customer is
//                                 already charged, so the result must land).
//   flood --skip--> review        the flood overlay's own skip button jumps the
//                                 whole theater; it does NOT pass through
//                                 transform.
//   transform --conclude--> idle  NOT currently reachable: the demo footer that
//                                 owns the only onConclude button is gated on
//                                 `flipped` (RevealStage), and `flipped` is only
//                                 settable from 'review'. The edge is here
//                                 anyway because master set 'idle'
//                                 UNCONDITIONALLY, and handleConclude clears
//                                 spin/offers/lockedReveal BEFORE asking for the
//                                 transition. Holding the phase there would
//                                 strand a player on a dimmed screen with no
//                                 mounted reveal and a disabled Spin. Do not
//                                 "tidy" this row away without first making
//                                 handleConclude transition-first.
const TRANSITIONS: Record<Phase, Partial<Record<PhaseEvent, Phase>>> = {
  idle: { spin: 'resolving', 'demo-spin': 'spinning' },
  resolving: { rolled: 'spinning', settle: 'flood', abort: 'idle' },
  spinning: { settle: 'flood', abort: 'idle' },
  flood: { morph: 'transform', skip: 'review' },
  transform: { reveal: 'review', skip: 'review', conclude: 'idle' },
  review: { conclude: 'idle' },
};

/**
 * The phase `event` leads to from `from`, or `from` unchanged when that pair is
 * not a legal transition.
 *
 * Always apply this through a functional state update
 * (`setPhase((p) => nextPhase(p, 'morph'))`). React applies queued updaters in
 * order, so two beats landing in one batch still compose
 * (flood --morph--> transform --reveal--> review) instead of the later one
 * winning outright — which is exactly what happens under reduced motion, where
 * both reveal timers are scheduled at 0ms.
 */
export function nextPhase(from: Phase, event: PhaseEvent): Phase {
  return TRANSITIONS[from][event] ?? from;
}

/** True while the reveal overlay is mounted — and narrows `phase` to the range
 *  RevealStage accepts, so the two phase types can never drift apart. */
export function isRevealPhase(phase: Phase): phase is RevealPhase {
  return phase === 'flood' || phase === 'transform' || phase === 'review';
}

/* ------------------------------------------------------------------ *
 * Reveal timing
 * ------------------------------------------------------------------ */

/** Rarity wash + swell over the landed reel, before the tiles become slabs. */
export const FLOOD_MS = 1650;
/** Tile→slab morph. Mirrors SlabCard's `entering` transition (0.6s) — retune
 *  both together or `review` opens before the last slab has finished growing. */
export const MORPH_MS = 600;
/** Breathing room after the morph lands, before the sell window opens. */
export const MORPH_SETTLE_MS = 250;
/** Per-card entrance stagger. Mirrors SlabCard's `enterDelayMs` (i * this), so
 *  a multi-card batch waits for its LAST slab, not its first. */
export const CARD_STAGGER_MS = 150;
/** Top-rarity room blast. Reduced motion does not shorten this — it skips the
 *  blast entirely, so this constant has no reduced-motion variant. */
export const BLAST_MS = 950;
/**
 * How long the concluded reveal holds before clearing itself back to the idle
 * machine (spec #27). NOT collapsed under reduced motion, deliberately: it is a
 * reading pause on the final footer ("+RM x credited", "Stored in your vault"),
 * not an animation, and cutting it would delete the confirmation rather than
 * de-animate it.
 */
export const CONCLUDE_DELAY_MS = 1400;

/**
 * How long the top-rarity room blast runs, or 0 when it must not run at all.
 *
 * Reduced motion SKIPS the blast rather than shortening it — a room-wide colour
 * flood is the thing the setting exists to suppress, and a brief one is worse
 * than none. Returning 0 rather than a shorter duration is what says so, and
 * makes the rule testable here instead of living in an `if` in the component.
 */
export function blastMs(isBigWin: boolean, reduced: boolean): number {
  return isBigWin && !reduced ? BLAST_MS : 0;
}

/**
 * The two reveal beats, as ABSOLUTE delays measured from the settle — not a
 * nested chain. Both are scheduled at once when the reel lands, so `reviewMs`
 * already contains `floodMs`; collapsing them into `setTimeout(…, reviewMs -
 * floodMs)` inside the flood timer would re-time the whole theater.
 *
 * Reduced motion collapses BOTH to 0: the theater is the animation, so there is
 * nothing left to wait for and the player cuts straight to the sell window.
 */
export function revealTimings(
  cardCount: number,
  reduced: boolean,
): { floodMs: number; reviewMs: number } {
  if (reduced) return { floodMs: 0, reviewMs: 0 };
  return {
    floodMs: FLOOD_MS,
    reviewMs:
      FLOOD_MS +
      MORPH_MS +
      MORPH_SETTLE_MS +
      Math.max(0, cardCount - 1) * CARD_STAGGER_MS,
  };
}

/* ------------------------------------------------------------------ *
 * Per-card sell state
 * ------------------------------------------------------------------ */

export type SellState =
  | { phase: 'idle' }
  | { phase: 'selling' }
  | { phase: 'sold'; amount: number }
  | { phase: 'error'; message: string }
  | { phase: 'vaulted' };

// Committed: a sell is on the wire, or the card is already concluded. Both the
// sell and the keep guards refuse to move a card out of these — the one shared
// re-entry rule, so a confirm modal left open across the deadline can't fire a
// sell and a double-tapped Keep can't overwrite a completed sale.
function isCommitted(state: SellState | undefined): boolean {
  return (
    !state ||
    state.phase === 'selling' ||
    state.phase === 'sold' ||
    state.phase === 'vaulted'
  );
}

/**
 * Deadline passed: every card that is not sold and not mid-sale becomes
 * 'vaulted' (the server enforces the same). A 'selling' card is deliberately
 * left alone — the request is still in flight and its own resolution writes the
 * terminal state, which is what keeps the reveal open across the deadline.
 */
export function expirySweep(states: readonly SellState[]): SellState[] {
  return states.map((s) =>
    s.phase === 'sold' || s.phase === 'selling' ? s : { phase: 'vaulted' },
  );
}

/**
 * "Keep in vault" — concludes the card with no server call (the pull is already
 * vaulted server-side). Returns `states` UNCHANGED (same reference) when the
 * card is committed, so a caller can detect the no-op by identity.
 */
export function keepAt(states: SellState[], index: number): SellState[] {
  if (isCommitted(states[index])) return states;
  const next = [...states];
  next[index] = { phase: 'vaulted' };
  return next;
}

/**
 * Move a card into 'selling'. Returns `states` UNCHANGED (same reference) when
 * the sell must be blocked — the caller reads that identity as "blocked" and
 * skips the server round-trip entirely.
 */
export function beginSellAt(states: SellState[], index: number): SellState[] {
  if (isCommitted(states[index])) return states;
  const next = [...states];
  next[index] = { phase: 'selling' };
  return next;
}

/**
 * Every card is terminal (sold | vaulted) — drives the reveal's auto-conclude.
 * `hasOffer` marks which slots carry a real, sellable pull; a slot without one
 * counts as already-concluded so it can never block the conclusion.
 */
export function allConcluded(
  states: readonly SellState[],
  hasOffer: readonly boolean[],
): boolean {
  return (
    states.length > 0 &&
    states.every(
      (s, i) => !hasOffer[i] || s.phase === 'sold' || s.phase === 'vaulted',
    )
  );
}
