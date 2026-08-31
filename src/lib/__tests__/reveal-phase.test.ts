import { describe, expect, test } from 'vitest';
import {
  nextPhase,
  isRevealPhase,
  revealTimings,
  FLOOD_MS,
  MORPH_MS,
  MORPH_SETTLE_MS,
  CARD_STAGGER_MS,
  BLAST_MS,
  blastMs,
  CONCLUDE_DELAY_MS,
  expirySweep,
  keepAt,
  beginSellAt,
  allConcluded,
  type Phase,
  type PhaseEvent,
  type SellState,
} from '@/lib/reveal-phase';

/** Fold a run of events from a starting phase — how the machine is actually
 *  driven (one setPhase functional update per event). */
const run = (from: Phase, ...events: PhaseEvent[]) =>
  events.reduce(nextPhase, from);

describe('nextPhase — the paths a player actually takes', () => {
  test('a paid spin runs idle → charge → reel → theater → sell → idle', () => {
    expect(
      run(
        'idle',
        'spin', // Spin pressed
        'rolled', // openBatch charged and returned cards
        'settle', // last reel column landed
        'morph', // flood beat over
        'reveal', // slabs done growing
        'conclude', // every card sold or kept
      ),
    ).toBe('idle');
  });

  test('each beat of that spin lands on the phase that renders it', () => {
    expect(run('idle', 'spin')).toBe('resolving');
    expect(run('idle', 'spin', 'rolled')).toBe('spinning');
    expect(run('idle', 'spin', 'rolled', 'settle')).toBe('flood');
    expect(run('idle', 'spin', 'rolled', 'settle', 'morph')).toBe('transform');
    expect(run('idle', 'spin', 'rolled', 'settle', 'morph', 'reveal')).toBe(
      'review',
    );
  });

  test('a guest demo spin skips the server round-trip entirely', () => {
    expect(run('idle', 'demo-spin')).toBe('spinning');
    // ...and never passes through resolving on the way.
    expect(nextPhase('idle', 'demo-spin')).not.toBe('resolving');
  });

  test('a failed open returns the machine to idle so Spin re-enables', () => {
    expect(run('idle', 'spin', 'abort')).toBe('idle');
  });

  test('an identity switch mid-spin drops the whole result', () => {
    expect(run('idle', 'spin', 'rolled', 'abort')).toBe('idle');
  });

  test('a post-charge failure still reaches the reveal from resolving', () => {
    // The charge landed but the cosmetic mapping threw, so handleSettled runs
    // while the reels never started. The player paid — the cards MUST land.
    expect(run('idle', 'spin', 'settle')).toBe('flood');
  });

  test('skipping the flood jumps the whole theater, not one beat of it', () => {
    expect(run('idle', 'spin', 'rolled', 'settle', 'skip')).toBe('review');
  });

  test('skipping the morph lands on review too', () => {
    expect(run('idle', 'spin', 'rolled', 'settle', 'morph', 'skip')).toBe(
      'review',
    );
  });

  test('two reveal beats arriving in one batch still compose in order', () => {
    // Under reduced motion both timers are scheduled at 0ms, so React can apply
    // both updaters against one queue. Folding must walk flood → transform →
    // review rather than letting the later event win outright.
    expect(run('flood', 'morph', 'reveal')).toBe('review');
  });
});

describe('nextPhase — events that must NOT move the machine', () => {
  test('a stale reveal timer cannot drag an idle machine into the theater', () => {
    expect(nextPhase('idle', 'morph')).toBe('idle');
    expect(nextPhase('idle', 'reveal')).toBe('idle');
    expect(nextPhase('idle', 'skip')).toBe('idle');
    expect(nextPhase('idle', 'conclude')).toBe('idle');
  });

  test('a settle cannot fire before a spin has been paid for', () => {
    expect(nextPhase('idle', 'settle')).toBe('idle');
  });

  test('concluding from a reveal beat lands idle, never holds', () => {
    // handleConclude clears spin/offers/lockedReveal BEFORE asking for this
    // transition, so a held phase would unmount the reveal and leave the player
    // on a dimmed screen with a disabled Spin. Master set 'idle'
    // unconditionally; these two pin that.
    expect(nextPhase('transform', 'conclude')).toBe('idle');
    expect(nextPhase('review', 'conclude')).toBe('idle');
    // 'flood' has no conclude edge because nothing can press it there: the only
    // onConclude button lives in a footer gated on `flipped`, which is settable
    // only from 'review'. Holding is safe here in a way it is not above.
    expect(nextPhase('flood', 'conclude')).toBe('flood');
  });

  test('the theater cannot run backwards', () => {
    expect(nextPhase('review', 'morph')).toBe('review');
    expect(nextPhase('review', 'settle')).toBe('review');
    expect(nextPhase('transform', 'morph')).toBe('transform');
  });

  test('a second spin cannot start while one is in flight', () => {
    for (const phase of [
      'resolving',
      'spinning',
      'flood',
      'transform',
      'review',
    ] as const) {
      expect(nextPhase(phase, 'spin')).toBe(phase);
      expect(nextPhase(phase, 'demo-spin')).toBe(phase);
    }
  });

  test('an unreachable event is a hold, never a throw — a charged player is never stranded', () => {
    const phases: Phase[] = [
      'idle',
      'resolving',
      'spinning',
      'flood',
      'transform',
      'review',
    ];
    const events: PhaseEvent[] = [
      'spin',
      'demo-spin',
      'rolled',
      'abort',
      'settle',
      'morph',
      'reveal',
      'skip',
      'conclude',
    ];
    for (const phase of phases) {
      for (const event of events) {
        expect(phases).toContain(nextPhase(phase, event));
      }
    }
  });
});

describe('isRevealPhase', () => {
  test('true exactly while the reveal overlay is mounted', () => {
    expect(isRevealPhase('flood')).toBe(true);
    expect(isRevealPhase('transform')).toBe(true);
    expect(isRevealPhase('review')).toBe(true);
  });

  test('false for every pre-reveal phase', () => {
    expect(isRevealPhase('idle')).toBe(false);
    expect(isRevealPhase('resolving')).toBe(false);
    expect(isRevealPhase('spinning')).toBe(false);
  });

  test('the reveal is entered by `settle` and left by `conclude`', () => {
    expect(isRevealPhase(run('idle', 'spin', 'rolled'))).toBe(false);
    expect(isRevealPhase(run('idle', 'spin', 'rolled', 'settle'))).toBe(true);
    expect(
      isRevealPhase(
        run('idle', 'spin', 'rolled', 'settle', 'skip', 'conclude'),
      ),
    ).toBe(false);
  });
});

describe('revealTimings', () => {
  test('the flood beat is the full wash before anything morphs', () => {
    expect(revealTimings(1, false).floodMs).toBe(FLOOD_MS);
  });

  test('review waits for the morph AND its settle margin after the flood', () => {
    expect(revealTimings(1, false).reviewMs).toBe(
      FLOOD_MS + MORPH_MS + MORPH_SETTLE_MS,
    );
  });

  test('both beats are absolute delays from the settle, not a nested chain', () => {
    const { floodMs, reviewMs } = revealTimings(3, false);
    // reviewMs already contains floodMs — scheduling it as (reviewMs - floodMs)
    // inside the flood timer would be the same wall-clock moment; scheduling it
    // as reviewMs inside the flood timer would double the wait.
    expect(reviewMs).toBeGreaterThan(floodMs);
    expect(reviewMs - floodMs).toBe(
      MORPH_MS + MORPH_SETTLE_MS + 2 * CARD_STAGGER_MS,
    );
  });

  test('a multi-card batch waits for its LAST slab, one stagger per extra card', () => {
    const one = revealTimings(1, false).reviewMs;
    expect(revealTimings(2, false).reviewMs - one).toBe(CARD_STAGGER_MS);
    expect(revealTimings(3, false).reviewMs - one).toBe(2 * CARD_STAGGER_MS);
    // The reel caps at 3, but the formula must stay linear beyond it.
    expect(revealTimings(5, false).reviewMs - one).toBe(4 * CARD_STAGGER_MS);
  });

  test('the flood beat never depends on how many cards were won', () => {
    expect(revealTimings(3, false).floodMs).toBe(
      revealTimings(1, false).floodMs,
    );
  });

  test('an empty batch never produces a negative delay', () => {
    expect(revealTimings(0, false).reviewMs).toBe(
      FLOOD_MS + MORPH_MS + MORPH_SETTLE_MS,
    );
  });

  test('reduced motion cuts straight to the sell window — BOTH beats collapse', () => {
    for (const count of [1, 2, 3]) {
      expect(revealTimings(count, true)).toEqual({ floodMs: 0, reviewMs: 0 });
    }
  });

  test('the beats are the same wall-clock lengths the components used to inline', () => {
    // Every other timing test here is written in the module's own constants, so
    // it would stay green if a constant moved. This one is the behaviour-
    // identity gate: these are the literals that lived in SlotMachineClient and
    // RevealStage before the extraction. Changing them changes what a player
    // sees, so a change must be deliberate enough to edit this line.
    expect(revealTimings(1, false)).toEqual({ floodMs: 1650, reviewMs: 2500 });
    expect(revealTimings(2, false).reviewMs).toBe(2650);
    expect(revealTimings(3, false).reviewMs).toBe(2800);
    expect(CONCLUDE_DELAY_MS).toBe(1400);
    expect(CARD_STAGGER_MS).toBe(150);
    expect(BLAST_MS).toBe(950);
  });

  test('the concluded reveal holds its confirmation even under reduced motion', () => {
    // CONCLUDE_DELAY_MS is a reading pause on the final footer ("+RM x
    // credited"), not an animation — collapsing it would delete the
    // confirmation rather than de-animate it. It has no reduced variant at all.
    expect(CONCLUDE_DELAY_MS).toBeGreaterThan(0);
  });

  test('the big-win blast is a fixed length — reduced motion skips it, never shortens it', () => {
    // The gate lives in blastMs, not in an `if` in the component, so this can
    // assert the RULE rather than just the constant. 0 means "do not run it at
    // all": a room-wide colour flood is what reduced motion exists to suppress,
    // and a brief one is worse than none.
    expect(blastMs(true, false)).toBe(BLAST_MS);
    expect(blastMs(true, true)).toBe(0);
    expect(blastMs(false, false)).toBe(0);
    expect(blastMs(false, true)).toBe(0);
    // A shortened blast would still pass a `> 0` check; this pins the length.
    expect(BLAST_MS).toBe(950);
  });
});

const idle: SellState = { phase: 'idle' };
const selling: SellState = { phase: 'selling' };
const sold: SellState = { phase: 'sold', amount: 12 };
const vaulted: SellState = { phase: 'vaulted' };
const errored: SellState = { phase: 'error', message: 'nope' };

describe('expirySweep', () => {
  test('an untouched card is vaulted when the clock runs out', () => {
    expect(expirySweep([idle])).toEqual([vaulted]);
  });

  test('a completed sale keeps its credited amount', () => {
    expect(expirySweep([sold])).toEqual([sold]);
  });

  test('a sell still on the wire is left alone to finish', () => {
    // This is what holds the reveal open past the deadline instead of yanking
    // the stage out from under a confirm modal's spinner.
    expect(expirySweep([selling])).toEqual([selling]);
  });

  test('a failed sell is vaulted — the window is closed, the card is safe', () => {
    expect(expirySweep([errored])).toEqual([vaulted]);
  });

  test('sweeps a mixed batch card by card', () => {
    expect(expirySweep([idle, selling, sold, errored, vaulted])).toEqual([
      vaulted,
      selling,
      sold,
      vaulted,
      vaulted,
    ]);
  });

  test('does not mutate the states it was given', () => {
    const before: SellState[] = [idle, selling];
    expirySweep(before);
    expect(before).toEqual([idle, selling]);
  });
});

describe('keepAt — "Keep in vault"', () => {
  test('concludes an untouched card with no server call', () => {
    expect(keepAt([idle, idle], 0)).toEqual([vaulted, idle]);
  });

  test('a retryable error can still be kept', () => {
    expect(keepAt([errored], 0)).toEqual([vaulted]);
  });

  test('cannot overwrite a completed sale', () => {
    const states = [sold];
    expect(keepAt(states, 0)).toBe(states);
  });

  test('cannot cancel a sell already on the wire', () => {
    const states = [selling];
    expect(keepAt(states, 0)).toBe(states);
  });

  test('a double-tap on Keep is a no-op', () => {
    const once = keepAt([idle], 0);
    expect(keepAt(once, 0)).toBe(once);
  });

  test('an index past the end changes nothing', () => {
    const states = [idle];
    expect(keepAt(states, 4)).toBe(states);
  });

  test('touches only the card that was kept', () => {
    expect(keepAt([idle, idle, idle], 1)).toEqual([idle, vaulted, idle]);
  });
});

describe('beginSellAt — sell re-entry guards', () => {
  test('an untouched card enters the selling state', () => {
    expect(beginSellAt([idle], 0)).toEqual([selling]);
  });

  test('a failed sell can be retried', () => {
    expect(beginSellAt([errored], 0)).toEqual([selling]);
  });

  test('a double-tapped Sell fires exactly one request', () => {
    // Identity-unchanged is how useSellWindow reads "blocked" back out of the
    // state updater and skips the server round-trip.
    const first = beginSellAt([idle], 0);
    expect(first).not.toEqual([idle]);
    expect(beginSellAt(first, 0)).toBe(first);
  });

  test('a card that already sold cannot be sold again', () => {
    const states = [sold];
    expect(beginSellAt(states, 0)).toBe(states);
  });

  test('a confirm modal left open across expiry cannot fire a sell', () => {
    // The expiry sweep vaults the card; the guard must refuse it afterwards.
    const swept = expirySweep([idle]);
    expect(beginSellAt(swept, 0)).toBe(swept);
  });

  test('an index past the end changes nothing', () => {
    const states = [idle];
    expect(beginSellAt(states, 2)).toBe(states);
  });

  test('selling one card leaves its neighbours untouched', () => {
    expect(beginSellAt([idle, idle], 1)).toEqual([idle, selling]);
  });
});

describe('allConcluded — drives the reveal auto-conclude', () => {
  test('an untouched card holds the reveal open', () => {
    expect(allConcluded([idle], [true])).toBe(false);
  });

  test('every card sold or kept concludes the reveal', () => {
    expect(allConcluded([sold, vaulted], [true, true])).toBe(true);
  });

  test('a sell still on the wire holds the reveal open', () => {
    expect(allConcluded([selling], [true])).toBe(false);
  });

  test('a FAILED sell holds the reveal open — this is why expiry is also an exit', () => {
    // 'error' is never terminal here, so without RevealStage's `|| expired`
    // branch a player whose sell failed would have no way off the stage.
    expect(allConcluded([errored], [true])).toBe(false);
    expect(allConcluded([sold, errored], [true, true])).toBe(false);
  });

  test('a card with no sellable pull never blocks the conclusion', () => {
    expect(allConcluded([idle], [false])).toBe(true);
    expect(allConcluded([idle, sold], [false, true])).toBe(true);
  });

  test('an empty batch is not concluded — nothing has been revealed yet', () => {
    // Guards the seeding frame: `states` is empty before the offers land, and
    // an early `true` would clear the stage before the player saw a card.
    expect(allConcluded([], [])).toBe(false);
  });

  test('expiry alone concludes an all-idle batch', () => {
    expect(allConcluded(expirySweep([idle, idle]), [true, true])).toBe(true);
  });
});
