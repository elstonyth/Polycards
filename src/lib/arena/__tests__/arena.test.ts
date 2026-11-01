import { describe, expect, test } from 'vitest';
import {
  aliveFloor,
  ArenaSim,
  FINAL_STEP,
  LAST_STEP,
  runArena,
  type ArenaRun,
} from '../engine';
import {
  ARENA_DOTS,
  ARENA_MAX_DOTS,
  arenaDots,
  arenaSeed,
  castDiscs,
  discShares,
} from '../cast';
import { LAST_EAT_AT, phaseAt, REVEAL_MS, SHOW_MS, stepAt } from '../timeline';

const seed = (s: string) => arenaSeed(s);

/** The discs alive on a step. */
const aliveAt = (run: ArenaRun, step: number) =>
  (run.frameStart[step + 1] as number) - (run.frameStart[step] as number);

describe('the battle', () => {
  const run = runArena(seed('gate-1'), ARENA_DOTS);

  // What the whole design rests on: the engine takes a seed and a disc count, so it
  // has no way to see a player, and can't favour one.
  test('knows nothing about who is playing', () => {
    expect(runArena.length).toBe(2);
    expect(ArenaSim.length).toBe(2);
  });

  test('ends with one disc, and every other disc was eaten exactly once', () => {
    expect(aliveAt(run, run.frameStart.length - 2)).toBe(1);
    expect(run.eats).toHaveLength(ARENA_DOTS - 1);
    const eaten = new Set(run.eats.map((e) => e.eaten));
    expect(eaten.size).toBe(ARENA_DOTS - 1);
    expect(eaten.has(run.survivor)).toBe(false);
  });

  test('keeps every gram: the winner holds all the discs, boosters and nudges', () => {
    const last = run.frameStart[run.frameStart.length - 2] as number;
    const taken = run.boosters
      .filter((b) => b.taker >= 0)
      .reduce((n, b) => n + b.gain, 0);
    expect(run.masses[last]).toBe(ARENA_DOTS + taken + run.nudges.length);
    expect(run.ids[last]).toBe(run.survivor);
  });

  test('a bigger disc only ever eats a smaller one', () => {
    // Replays the masses: an eater must outweigh what it eats at that step.
    const mass = new Float64Array(ARENA_DOTS).fill(1);
    let boost = 0;
    const taken = run.boosters
      .filter((b) => b.taker >= 0)
      .sort((a, b) => a.until - b.until);
    let nudge = 0;
    for (const e of run.eats) {
      while (boost < taken.length && (taken[boost]?.until ?? 0) <= e.step) {
        const t = taken[boost++];
        if (t) mass[t.taker] = (mass[t.taker] as number) + t.gain;
      }
      while (
        nudge < run.nudges.length &&
        (run.nudges[nudge]?.step ?? 0) <= e.step
      ) {
        const n = run.nudges[nudge++];
        if (n) mass[n.disc] = (mass[n.disc] as number) + 1;
      }
      expect(mass[e.eaten]).toBe(e.mass);
      expect(mass[e.eater] as number).toBeGreaterThan(e.mass);
      mass[e.eater] = (mass[e.eater] as number) + e.mass;
    }
  });

  test('every disc stays inside the table', () => {
    for (let step = 0; step < run.radius.length; step += 13) {
      const from = run.frameStart[step] as number;
      const to = run.frameStart[step + 1] as number;
      const R = (run.radius[step] as number) + 1;
      for (let i = from; i < to; i++) {
        const x = run.xs[i] as number;
        const y = run.ys[i] as number;
        expect(x * x + y * y).toBeLessThanOrEqual(R * R);
      }
    }
  });

  test('never eats ahead of its curve, and is on pace at the final', () => {
    for (const step of [60, 120, 200, 280]) {
      expect(aliveAt(run, step)).toBeGreaterThanOrEqual(
        aliveFloor(step, ARENA_DOTS),
      );
    }
    expect(aliveAt(run, FINAL_STEP)).toBeLessThanOrEqual(40);
  });

  test('climaxes near the aim whatever the seed, so a show always fits', () => {
    for (let i = 0; i < 25; i++) {
      const r = runArena(seed(`pace-${i}`), ARENA_DOTS);
      expect(r.lastStep).toBeGreaterThan(FINAL_STEP);
      expect(r.lastStep).toBeLessThanOrEqual(LAST_STEP + 12);
      expect(r.eats[r.eats.length - 1]?.step).toBe(r.lastStep);
    }
  });

  test('the same seed plays the same battle, frame for frame', () => {
    const again = runArena(seed('gate-1'), ARENA_DOTS);
    expect(again.survivor).toBe(run.survivor);
    expect(again.lastStep).toBe(run.lastStep);
    expect(Array.from(again.xs)).toEqual(Array.from(run.xs));
    expect(Array.from(again.masses)).toEqual(Array.from(run.masses));
  });

  test('another seed plays another battle', () => {
    const other = runArena(seed('gate-2'), ARENA_DOTS);
    expect(Array.from(other.xs.subarray(0, 50))).not.toEqual(
      Array.from(run.xs.subarray(0, 50)),
    );
  });

  test('runs in slices to the same recording', () => {
    const sim = new ArenaSim(seed('gate-1'), ARENA_DOTS);
    let n = 0;
    while (!sim.done && n++ < 100_000) sim.advance();
    expect(Array.from(sim.result().ys)).toEqual(Array.from(run.ys));
  });

  test('ends at the far ends of its size', () => {
    for (const dots of [2, 3, ARENA_MAX_DOTS]) {
      const r = runArena(seed(`size-${dots}`), dots);
      expect(r.eats).toHaveLength(dots - 1);
    }
  });
});

describe('who sits where', () => {
  test('discs follow tickets, one each at least, adding up exactly', () => {
    const shares = discShares([1, 3, 96], 900);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(900);
    expect(shares[0]).toBeGreaterThanOrEqual(1);
    expect((shares[1] as number) / (shares[2] as number)).toBeCloseTo(
      3 / 96,
      1,
    );
    expect(discShares([5], 900)).toEqual([900]);
    expect(discShares([1, 1], 900)).toEqual([450, 450]);
  });

  test('a one-ticket player among ten thousand still gets a disc', () => {
    const shares = discShares([1, 10_000], 900);
    expect(shares[0]).toBe(1);
    expect(shares[1]).toBe(899);
  });

  test('more entrants than discs keeps the winner and the viewer', () => {
    const tickets = Array.from({ length: 3000 }, (_, i) => (i < 2998 ? 5 : 1));
    const shares = discShares(tickets, 2000, [2998, 2999]);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(2000);
    expect(shares[2998]).toBe(1);
    expect(shares[2999]).toBe(1);
    expect(arenaDots(3000)).toBe(ARENA_MAX_DOTS);
    expect(arenaDots(2)).toBe(ARENA_DOTS);
  });

  // The property the whole design rests on: the last disc is the stored winner's.
  const LISTS: { name: string; tickets: number[]; winner: number }[] = [
    { name: 'one entrant, one ticket', tickets: [1], winner: 0 },
    { name: 'one entrant, many tickets', tickets: [500], winner: 0 },
    { name: 'two equal', tickets: [3, 3], winner: 1 },
    { name: 'winner listed first', tickets: [2, 9, 40], winner: 0 },
    { name: 'winner listed last', tickets: [40, 9, 2], winner: 2 },
    { name: 'one ticket among ten thousand', tickets: [10_000, 1], winner: 1 },
    {
      name: 'more entrants than discs',
      tickets: Array.from({ length: 2500 }, () => 2),
      winner: 2499,
    },
  ];

  test.each(LISTS)(
    'the survivor is the winner: $name',
    ({ tickets, winner }) => {
      const s = seed(`cast-${tickets.length}-${winner}`);
      const dots = arenaDots(tickets.length);
      const run = runArena(s, dots);
      const owners = castDiscs({
        tickets,
        winner,
        me: null,
        survivor: run.survivor,
        dots,
        seed: s,
      });
      expect(owners).toHaveLength(dots);
      expect(owners[run.survivor]).toBe(winner);
    },
  );

  test('every device seats everyone alike', () => {
    const s = seed('seats');
    const input = {
      tickets: [5, 10, 85],
      winner: 1,
      me: null,
      survivor: 17,
      dots: 900,
      seed: s,
    };
    expect(Array.from(castDiscs(input))).toEqual(Array.from(castDiscs(input)));
  });

  test('the viewer changes nothing but who is highlighted', () => {
    const s = seed('viewer');
    const base = {
      tickets: [5, 10, 85],
      winner: 1,
      survivor: 17,
      dots: 900,
      seed: s,
    };
    expect(Array.from(castDiscs({ ...base, me: 0 }))).toEqual(
      Array.from(castDiscs({ ...base, me: null })),
    );
  });

  test('seating keeps each entrant their share', () => {
    const owners = castDiscs({
      tickets: [1, 99],
      winner: 0,
      me: null,
      survivor: 300,
      dots: 900,
      seed: seed('share'),
    });
    const mine = owners.reduce((n, o) => n + (o === 0 ? 1 : 0), 0);
    expect(mine).toBe(discShares([1, 99], 900)[0]);
  });
});

describe('the clock', () => {
  const run = runArena(seed('clock'), ARENA_DOTS);

  test('twenty seconds, the winner told before the end', () => {
    expect(SHOW_MS).toBe(20_000);
    expect(REVEAL_MS).toBeGreaterThan(LAST_EAT_AT);
    expect(REVEAL_MS).toBeLessThan(SHOW_MS);
  });

  test('the battle moves forward only and lands on the last eat', () => {
    let prev = -1;
    for (let t = 0; t <= SHOW_MS; t += 100) {
      const s = stepAt(t, run.lastStep);
      expect(s).toBeGreaterThanOrEqual(prev);
      prev = s;
    }
    expect(stepAt(LAST_EAT_AT, run.lastStep)).toBe(run.lastStep);
    expect(stepAt(SHOW_MS, run.lastStep)).toBe(run.lastStep);
  });

  test('close to real time, then slow for the climax', () => {
    const real = (stepAt(8000, run.lastStep) - stepAt(7000, run.lastStep)) / 30;
    expect(real).toBeGreaterThan(0.85);
    expect(real).toBeLessThan(1.25);
    const slow =
      (stepAt(LAST_EAT_AT, run.lastStep) -
        stepAt(LAST_EAT_AT - 1000, run.lastStep)) /
      30;
    expect(slow).toBeLessThan(0.3);
  });

  test('walks the phases in order', () => {
    const order = [
      'opening',
      'boosters',
      'frenzy',
      'closing',
      'final',
      'winner',
    ];
    const seen: string[] = [];
    for (let t = 0; t <= SHOW_MS; t += 50) {
      const p = phaseAt(t, run);
      if (seen[seen.length - 1] !== p) seen.push(p);
    }
    expect(seen).toEqual(order);
  });
});
