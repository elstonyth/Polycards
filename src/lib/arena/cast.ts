import { arenaRng, type Seed4 } from './engine';

/** A battle's discs, whatever the gate's size: a two-player gate gets a real
 *  battle and a huge one still starts fast on a phone. */
export const ARENA_DOTS = 320;
/** More entrants than discs: every entrant needs one, up to this. */
export const ARENA_MAX_DOTS = 2000;

/** A string to a seed (cyrb128): the draw's seed plus its id, so two gates drawn
 *  from one secret never play the same battle. */
export function arenaSeed(text: string): Seed4 {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < text.length; i++) {
    const k = text.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  return [
    (h1 ^ h2 ^ h3 ^ h4) >>> 0,
    (h2 ^ h1) >>> 0,
    (h3 ^ h1) >>> 0,
    (h4 ^ h1) >>> 0,
  ];
}

/** How many discs a battle needs for this many entrants. */
export const arenaDots = (entrants: number): number =>
  Math.min(ARENA_MAX_DOTS, Math.max(ARENA_DOTS, entrants));

/** Discs per entry, in proportion to tickets, at least one each, adding up to
 *  `dots` exactly (largest remainder). More entrants than discs: the biggest
 *  holders, the winner and the viewer keep one, and the rest sit out. */
export function discShares(
  tickets: readonly number[],
  dots: number,
  keep: readonly number[] = [],
): number[] {
  const shares = new Array<number>(tickets.length).fill(0);
  let seated = tickets.map((_, i) => i);
  if (seated.length > dots) {
    const kept = new Set(keep.filter((i) => i >= 0));
    seated = seated
      .sort(
        (a, b) =>
          Number(kept.has(b)) - Number(kept.has(a)) ||
          (tickets[b] as number) - (tickets[a] as number) ||
          a - b,
      )
      .slice(0, dots)
      .sort((a, b) => a - b);
  }
  const total = seated.reduce((n, i) => n + (tickets[i] as number), 0);
  const spare = dots - seated.length;
  const rest: { i: number; part: number }[] = [];
  let given = 0;
  for (const i of seated) {
    const exact = total > 0 ? (spare * (tickets[i] as number)) / total : 0;
    const whole = Math.floor(exact);
    shares[i] = 1 + whole;
    given += whole;
    rest.push({ i, part: exact - whole });
  }
  rest.sort((a, b) => b.part - a.part || a.i - b.i);
  for (let k = 0; k < spare - given; k++) {
    const row = rest[k % rest.length];
    if (row) shares[row.i] = (shares[row.i] as number) + 1;
  }
  return shares;
}

/**
 * Who owns each disc. The survivor goes to the stored winner, and the rest are
 * shuffled from the seed, so every device seats everyone alike. The winner is
 * already decided, so seating them on the disc that lasts changes nothing.
 */
export function castDiscs(input: {
  tickets: readonly number[];
  winner: number;
  me: number | null;
  survivor: number;
  dots: number;
  seed: Seed4;
}): Int32Array {
  const { tickets, winner, me, survivor, dots, seed } = input;
  const shares = discShares(
    tickets,
    dots,
    me == null ? [winner] : [winner, me],
  );
  const owners = new Int32Array(dots);
  let at = 0;
  shares.forEach((count, entry) => {
    for (let k = 0; k < count; k++) owners[at++] = entry;
  });
  const rng = arenaRng(seed);
  for (let k = dots - 1; k > 0; k--) {
    const j = rng.int(k + 1);
    const t = owners[k] as number;
    owners[k] = owners[j] as number;
    owners[j] = t;
  }
  if (owners[survivor] !== winner) {
    const swap = owners.indexOf(winner);
    owners[swap] = owners[survivor] as number;
    owners[survivor] = winner;
  }
  return owners;
}
