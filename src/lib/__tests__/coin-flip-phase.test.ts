import { describe, expect, test } from 'vitest';
import {
  coinFlipNext,
  type CoinFlipEvent,
  type CoinFlipPhase,
} from '@/lib/coin-flip';

const PHASES: CoinFlipPhase[] = [
  'loading',
  'idle',
  'quoting',
  'confirm',
  'armed',
  'submitting',
  'recovering',
  'animating',
  'result',
];
const EVENTS: CoinFlipEvent[] = [
  'ready',
  'open',
  'review',
  'quoted',
  'refused',
  'missing',
  'arm',
  'cancel',
  'toss',
  'retry',
  'settled',
  'tossed',
  'landed',
  'uncertain',
  'restake',
];

// One row per CoinFlipClient call site: [from, event, to, where].
const LEGAL: [CoinFlipPhase, CoinFlipEvent, CoinFlipPhase, string][] = [
  ['loading', 'ready', 'idle', 'mount: no flip to resume'],
  ['loading', 'open', 'loading', 'mount: resume a pending or linked flip'],
  ['idle', 'open', 'loading', 'history row'],
  ['confirm', 'open', 'loading', 'history row behind the confirm sheet'],
  ['armed', 'open', 'loading', 'history row while armed'],
  ['recovering', 'open', 'loading', 'Check result / history row'],
  ['result', 'open', 'loading', 'history row after a result'],
  ['loading', 'settled', 'result', 'recover: a settled round'],
  ['loading', 'uncertain', 'recovering', 'recover: unconfirmed or unreadable'],
  ['loading', 'missing', 'idle', 'recover: the round is gone'],
  ['idle', 'review', 'quoting', 'Review'],
  ['quoting', 'quoted', 'confirm', 'quote arrived'],
  ['quoting', 'refused', 'idle', 'quote refused or unreachable'],
  ['confirm', 'arm', 'armed', 'Confirm'],
  ['confirm', 'cancel', 'idle', 'Cancel, backdrop or Escape'],
  ['armed', 'cancel', 'idle', 'Cancel / Review again'],
  ['armed', 'toss', 'submitting', 'Flip coin or a flick'],
  ['recovering', 'retry', 'submitting', 'Retry same flip'],
  ['submitting', 'tossed', 'animating', 'accept: settled by this toss'],
  ['submitting', 'settled', 'result', 'accept: settled on a retry'],
  ['submitting', 'refused', 'idle', 'accept: refused, nothing staked'],
  ['submitting', 'uncertain', 'recovering', 'accept: result unknown'],
  ['animating', 'landed', 'result', 'coin landed or Skip'],
  ['result', 'restake', 'idle', 'Flip again / Choose cards / Choose amount'],
];

describe('coinFlipNext', () => {
  test.each(LEGAL)('%s --%s--> %s (%s)', (from, event, to) => {
    expect(coinFlipNext(from, event)).toBe(to);
  });

  test('every other pair holds the phase', () => {
    for (const from of PHASES)
      for (const event of EVENTS) {
        const row = LEGAL.find(([f, e]) => f === from && e === event);
        expect(coinFlipNext(from, event), `${from} --${event}-->`).toBe(
          row ? row[2] : from,
        );
      }
  });

  test('a toss in the air cannot be interrupted', () => {
    // No history row, Cancel or second toss can leave these phases: the
    // result of a staked flip always comes first.
    for (const event of EVENTS) {
      if (
        event !== 'tossed' &&
        event !== 'settled' &&
        event !== 'refused' &&
        event !== 'uncertain'
      )
        expect(coinFlipNext('submitting', event)).toBe('submitting');
      if (event !== 'landed')
        expect(coinFlipNext('animating', event)).toBe('animating');
    }
  });

  test('a full toss: review, confirm, flip, land', () => {
    const path: CoinFlipEvent[] = [
      'review',
      'quoted',
      'arm',
      'toss',
      'tossed',
      'landed',
    ];
    expect(path.reduce(coinFlipNext, 'idle' as CoinFlipPhase)).toBe('result');
  });
});
