/**
 * The Lucky Draw arena: a seeded battle of discs on a shrinking round table,
 * bigger eats smaller, until one is left. It runs on the viewer's device and is
 * recorded step by step, so a viewer can join at any second and a replay is the
 * same battle.
 *
 * It decides nothing. The backend has already drawn the winning ticket; this
 * takes only a seed and a disc count, never an entrant, and cast.ts then seats
 * the winner on whichever disc survives. So nothing here can change who wins,
 * and old draws replay to the right winner even if this tuning changes.
 *
 * Only + - * / sqrt and integer maths, in fixed steps: IEEE-exact everywhere, so
 * every device plays the same run from the same seed.
 */

export type Seed4 = readonly [number, number, number, number];

/** The table's starting radius, in world units. */
export const ARENA_R0 = 1000;
export const STEP_HZ = 30;
/** The steps booster waves land on. */
export const WAVE_STEPS = [18, 70, 125, 185, 245] as const;
const WAVE_SHARE = [0.32, 0.26, 0.2, 0.13, 0.09] as const;
/** Boosters in all, per disc. */
const BOOSTER_SHARE = 0.12;
/** When the final begins, and how many should be left by then. */
export const FINAL_STEP = 300;
export const FINALISTS = 8;
/** Two left by here: the last duel, with foil chips that can swap the lead. */
const DUEL_STEP = 385;
/** The bigger of the last two goes for it. The show slows down here. */
export const CHOMP_STEP = 452;
/** The step the last eat aims for. */
export const LAST_STEP = 465;
const DUEL_CHIPS = 5;
const CHIP_EVERY = 11;
/** Under this share of the table in the final, a disc is scraps: swept up first. */
const SCRAP_SHARE = 0.012;
const SWEEP_STEPS = 14;
const MIN_BEAT = 7;
const DUEL_SPEED = 175;
const PART_SPEED = 300;
/** Steps two duellists spring apart after a bump, and before the last lunge. */
const RECOIL_STEPS = 12;
/** Discs cover this much of the table at the start, whatever their number. */
const COVER = 0.1;
const R_FINAL = 680;
const R_LAST = 590;
const SHRINK_FROM = 30;
const BASE_SPEED = 128; // units per second at mass 1
const MIN_SPEED = 52;
const CELL = 64;
const SMALL_R = CELL / 2;
const CHASE_EVERY = 3;
/** Past the aim by this much, a hunter closes the gap outright. */
const FORCE_AFTER = 30;
const HARD_STOP = LAST_STEP + 240;

function makeRng(seed: Seed4) {
  let a = seed[0] >>> 0;
  let b = seed[1] >>> 0;
  let c = seed[2] >>> 0;
  let d = seed[3] >>> 0;
  if ((a | b | c | d) === 0) a = 1;
  // xoshiro128**
  const next = (): number => {
    let r = Math.imul(b, 5);
    r = (r << 7) | (r >>> 25);
    r = Math.imul(r, 9) >>> 0;
    const t = b << 9;
    c ^= a;
    d ^= b;
    b ^= c;
    a ^= d;
    c ^= t;
    d = (d << 11) | (d >>> 21);
    return r;
  };
  return {
    next,
    float: () => (next() >>> 8) / 16777216,
    /** Unbiased 0..n-1. */
    int(n: number): number {
      const lim = Math.floor(4294967296 / n) * n;
      let x = next();
      while (x >= lim) x = next();
      return x % n;
    },
  };
}

export type ArenaRng = ReturnType<typeof makeRng>;
export const arenaRng = makeRng;

/** One recorded eat. */
export type ArenaEat = {
  step: number;
  eater: number;
  eaten: number;
  /** The mass that went down: how big a moment this was. */
  mass: number;
  x: number;
  y: number;
};

export type ArenaBooster = {
  x: number;
  y: number;
  /** The step it lands on. */
  from: number;
  /** The step it is taken or falls outside the table; never if it outlives the show. */
  until: number;
  /** Who took it, or -1. */
  taker: number;
  /** The mass it gives: 1, or a lot for a chip in the last duel. */
  gain: number;
};

/** A round of the final: who hunts whom, from `from` until one of them goes. */
export type ArenaRound = { from: number; pairs: number[] };

export type ArenaRun = {
  dots: number;
  r0: number;
  /** Index into the arrays below where each step's discs start. +1 entry. */
  frameStart: Int32Array;
  /** Disc ids, ascending within a step. */
  ids: Int32Array;
  xs: Float32Array;
  ys: Float32Array;
  masses: Float32Array;
  /** Table radius per step. */
  radius: Float32Array;
  eats: ArenaEat[];
  boosters: ArenaBooster[];
  rounds: ArenaRound[];
  /** Tie-breaks in the final: the disc given +1, by step. */
  nudges: { step: number; disc: number }[];
  /** The step the final began. */
  finalStep: number;
  /** The step of the last eat: the show's climax. */
  lastStep: number;
  /** The one left. */
  survivor: number;
  /** Each disc's largest mass. Only the big ones ever need a picture. */
  peak: Float32Array;
};

/** The floor of discs still alive at a step: a curve the eating may not get ahead
 *  of, so a small head start cannot end the battle early. Polynomial on purpose,
 *  not a pow: see the note at the top of this file. */
export function aliveFloor(step: number, dots: number): number {
  if (step >= FINAL_STEP) return Math.min(FINALISTS, dots);
  const left = 1 - step / FINAL_STEP;
  const curve = left * left * left * left;
  return Math.ceil(dots * curve + Math.min(FINALISTS, dots) * (1 - curve));
}

/** Table radius at a step: full, then closing to R_FINAL by the final and R_LAST
 *  by the last eat. Eased so it starts and ends gently. */
function tableRadius(step: number): number {
  if (step <= SHRINK_FROM) return ARENA_R0;
  if (step <= FINAL_STEP) {
    const x = (step - SHRINK_FROM) / (FINAL_STEP - SHRINK_FROM);
    const e = x * x * (3 - 2 * x);
    return ARENA_R0 + (R_FINAL - ARENA_R0) * e;
  }
  const x = Math.min(1, (step - FINAL_STEP) / (LAST_STEP - FINAL_STEP));
  return R_FINAL + (R_LAST - R_FINAL) * x;
}

/** Roughly 128·m^-⅛, floored: bigger is slower. Three square roots, not a pow. */
const speedOf = (mass: number): number => {
  const v = BASE_SPEED / Math.sqrt(Math.sqrt(Math.sqrt(mass)));
  return v < MIN_SPEED ? MIN_SPEED : v;
};

class Growable {
  ids: Int32Array;
  xs: Float32Array;
  ys: Float32Array;
  masses: Float32Array;
  length = 0;

  constructor(capacity: number) {
    this.ids = new Int32Array(capacity);
    this.xs = new Float32Array(capacity);
    this.ys = new Float32Array(capacity);
    this.masses = new Float32Array(capacity);
  }

  reserve(extra: number): void {
    const need = this.length + extra;
    if (need <= this.ids.length) return;
    const size = Math.max(need, this.ids.length * 2);
    const ids = new Int32Array(size);
    const xs = new Float32Array(size);
    const ys = new Float32Array(size);
    const masses = new Float32Array(size);
    ids.set(this.ids.subarray(0, this.length));
    xs.set(this.xs.subarray(0, this.length));
    ys.set(this.ys.subarray(0, this.length));
    masses.set(this.masses.subarray(0, this.length));
    this.ids = ids;
    this.xs = xs;
    this.ys = ys;
    this.masses = masses;
  }
}

/** The battle, advanced a step at a time so it can be run in slices. */
export class ArenaSim {
  private readonly rng: ArenaRng;
  private readonly n: number;
  private readonly x: Float64Array;
  private readonly y: Float64Array;
  private readonly dx: Float64Array;
  private readonly dy: Float64Array;
  private readonly mass: Float64Array;
  private readonly rad: Float64Array;
  private readonly alive: Uint8Array;
  private readonly target: Int32Array;
  private readonly r0: number;
  private readonly rb: number;
  private order: Int32Array;
  private nAlive: number;
  private step = 0;
  private finished = false;
  // The broad phase: small discs by cell, big ones in a list.
  private readonly cols: number;
  private readonly head: Int32Array;
  private readonly nextInCell: Int32Array;
  private bigs: number[] = [];
  private readonly waveCounts: number[] = [];
  private readonly boosters: ArenaBooster[] = [];
  private readonly eats: ArenaEat[] = [];
  private readonly rounds: ArenaRound[] = [];
  private readonly nudges: { step: number; disc: number }[] = [];
  private finalStep = -1;
  private lastEat = 0;
  // The final. `locked[prey]` is the one disc that may eat it; any other meeting
  // bounces, so the final is a clear run of duels, not a pile-up.
  private readonly locked: Int32Array;
  private hunter = -1;
  private prey = -1;
  private sweeping = false;
  private huntEnd = 0;
  private chipsLanded = 0;
  private nextChip = 0;
  private recoil = 0;
  private readonly frameStart: Int32Array;
  private readonly radius: Float32Array;
  private readonly rec: Growable;
  private readonly peak: Float32Array;

  constructor(seed: Seed4, dots: number) {
    this.n = dots;
    this.rng = makeRng(seed);
    this.x = new Float64Array(dots);
    this.y = new Float64Array(dots);
    this.dx = new Float64Array(dots);
    this.dy = new Float64Array(dots);
    this.mass = new Float64Array(dots);
    this.rad = new Float64Array(dots);
    this.alive = new Uint8Array(dots);
    this.target = new Int32Array(dots).fill(-1);
    this.locked = new Int32Array(dots).fill(-1);
    this.peak = new Float32Array(dots);
    this.r0 = ARENA_R0 * Math.sqrt(COVER / dots);
    this.rb = this.r0 * 0.85;
    this.order = new Int32Array(dots);
    this.nAlive = dots;
    this.cols = Math.ceil((2 * ARENA_R0) / CELL) + 2;
    this.head = new Int32Array(this.cols * this.cols);
    this.nextInCell = new Int32Array(dots);
    this.frameStart = new Int32Array(HARD_STOP + 3);
    this.radius = new Float32Array(HARD_STOP + 3);
    this.rec = new Growable(dots * 120);

    const maxR = ARENA_R0 - this.r0 * 2;
    for (let i = 0; i < dots; i++) {
      // Even over the disc: rejection, not a sin/cos.
      let px = 0;
      let py = 0;
      do {
        px = (this.rng.float() * 2 - 1) * maxR;
        py = (this.rng.float() * 2 - 1) * maxR;
      } while (px * px + py * py > maxR * maxR);
      this.x[i] = px;
      this.y[i] = py;
      this.setDirection(i, this.rng.float() - 0.5, this.rng.float() - 0.5);
      this.mass[i] = 1;
      this.rad[i] = this.r0;
      this.alive[i] = 1;
      this.peak[i] = 1;
      this.order[i] = i;
    }

    const total = Math.max(12, Math.round(dots * BOOSTER_SHARE));
    let placed = 0;
    for (let w = 0; w < WAVE_SHARE.length; w++) {
      const count =
        w < WAVE_SHARE.length - 1
          ? Math.round(total * (WAVE_SHARE[w] ?? 0))
          : total - placed;
      this.waveCounts.push(count);
      placed += count;
    }
    this.record();
  }

  private setDirection(i: number, ax: number, ay: number): void {
    const l = Math.sqrt(ax * ax + ay * ay) || 1;
    this.dx[i] = ax / l;
    this.dy[i] = ay / l;
  }

  private radiusOf(mass: number): number {
    return this.r0 * Math.sqrt(mass);
  }

  private record(): void {
    const { rec, order, x, y, mass, step } = this;
    const n = order.length;
    this.frameStart[step] = rec.length;
    this.radius[step] = tableRadius(step);
    rec.reserve(n);
    for (let k = 0; k < n; k++) {
      const q = order[k] as number;
      const at = rec.length + k;
      rec.ids[at] = q;
      rec.xs[at] = x[q] as number;
      rec.ys[at] = y[q] as number;
      rec.masses[at] = mass[q] as number;
    }
    rec.length += n;
    this.frameStart[step + 1] = rec.length;
  }

  private cellOf(v: number): number {
    const c = Math.floor((v + ARENA_R0) / CELL) + 1;
    return c < 0 ? 0 : c >= this.cols ? this.cols - 1 : c;
  }

  private rebuildGrid(): void {
    this.head.fill(-1);
    this.bigs = [];
    const { order, rad, x, y } = this;
    // Descending, so a cell walks back up in id order.
    for (let k = order.length - 1; k >= 0; k--) {
      const q = order[k] as number;
      if ((rad[q] as number) > SMALL_R) continue;
      const c =
        this.cellOf(x[q] as number) + this.cellOf(y[q] as number) * this.cols;
      this.nextInCell[q] = this.head[c] as number;
      this.head[c] = q;
    }
    for (let k = 0; k < order.length; k++) {
      const q = order[k] as number;
      if ((rad[q] as number) > SMALL_R) this.bigs.push(q);
    }
  }

  private clampToTable(q: number, R: number): void {
    const r = this.rad[q] as number;
    const px = this.x[q] as number;
    const py = this.y[q] as number;
    const limit = R - r;
    if (limit <= 0) {
      this.x[q] = 0;
      this.y[q] = 0;
      return;
    }
    const d2 = px * px + py * py;
    if (d2 <= limit * limit) return;
    const d = Math.sqrt(d2);
    const nx = px / d;
    const ny = py / d;
    this.x[q] = nx * limit;
    this.y[q] = ny * limit;
    // Off the wall: drop the outward part of its heading.
    const dot = (this.dx[q] as number) * nx + (this.dy[q] as number) * ny;
    if (dot > 0) {
      this.setDirection(
        q,
        (this.dx[q] as number) - 2 * dot * nx,
        (this.dy[q] as number) - 2 * dot * ny,
      );
    }
  }

  /** The nearest smaller disc in range, for a chaser. */
  private nearestPrey(q: number, sense: number): number {
    const px = this.x[q] as number;
    const py = this.y[q] as number;
    const m = this.mass[q] as number;
    let best = -1;
    let bestD = sense * sense;
    const scan = (o: number) => {
      if (o === q || !this.alive[o] || (this.mass[o] as number) >= m) return;
      const ex = (this.x[o] as number) - px;
      const ey = (this.y[o] as number) - py;
      const d2 = ex * ex + ey * ey;
      if (d2 < bestD) {
        bestD = d2;
        best = o;
      }
    };
    const c0 = this.cellOf(px - sense);
    const c1 = this.cellOf(px + sense);
    const r0 = this.cellOf(py - sense);
    const r1 = this.cellOf(py + sense);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        for (
          let o = this.head[c + r * this.cols] as number;
          o >= 0;
          o = this.nextInCell[o] as number
        ) {
          scan(o);
        }
      }
    }
    for (const o of this.bigs) scan(o);
    return best;
  }

  private moveAll(R: number, pressure: number): void {
    const { order } = this;
    const chaseNow = this.step % CHASE_EVERY === 0;
    const chase = 0.22 + 0.33 * pressure;
    const pace = (1 + 0.45 * pressure) / STEP_HZ;
    for (let k = 0; k < order.length; k++) {
      const q = order[k] as number;
      const m = this.mass[q] as number;
      if (chaseNow) {
        const sense = (this.rad[q] as number) * 7 + 70;
        this.target[q] = m > 1 ? this.nearestPrey(q, sense) : -1;
      }
      let ux = (this.dx[q] as number) + (this.rng.float() - 0.5) * 0.4;
      let uy = (this.dy[q] as number) + (this.rng.float() - 0.5) * 0.4;
      const lean = this.leanIn(q, R);
      ux += lean.x;
      uy += lean.y;
      const t = this.target[q] as number;
      if (t >= 0 && this.alive[t] && (this.mass[t] as number) < m) {
        const tx = (this.x[t] as number) - (this.x[q] as number);
        const ty = (this.y[t] as number) - (this.y[q] as number);
        const tl = Math.sqrt(tx * tx + ty * ty) || 1;
        ux = ux * (1 - chase) + (chase * tx) / tl;
        uy = uy * (1 - chase) + (chase * ty) / tl;
      }
      this.setDirection(q, ux, uy);
      const sp = speedOf(m) * pace;
      this.x[q] = (this.x[q] as number) + (this.dx[q] as number) * sp;
      this.y[q] = (this.y[q] as number) + (this.dy[q] as number) * sp;
      this.clampToTable(q, R);
    }
  }

  /** Near the wall a disc leans back toward the middle, so the big ones don't all
   *  end up circling the rim with an empty table between them. */
  private leanIn(q: number, R: number): { x: number; y: number } {
    const px = this.x[q] as number;
    const py = this.y[q] as number;
    const far = (px * px + py * py) / (R * R);
    if (far <= 0.45) return { x: 0, y: 0 };
    const pull = (far - 0.45) * 1.1;
    return { x: (-px / R) * pull, y: (-py / R) * pull };
  }

  private dropWaves(R: number): void {
    for (let w = 0; w < WAVE_STEPS.length; w++) {
      if (WAVE_STEPS[w] !== this.step) continue;
      const count = this.waveCounts[w] ?? 0;
      const reach = R - this.rb * 3;
      for (let k = 0; k < count; k++) {
        let px = 0;
        let py = 0;
        do {
          px = (this.rng.float() * 2 - 1) * reach;
          py = (this.rng.float() * 2 - 1) * reach;
        } while (px * px + py * py > reach * reach);
        this.boosters.push({
          x: px,
          y: py,
          from: this.step,
          until: Number.MAX_SAFE_INTEGER,
          taker: -1,
          gain: 1,
        });
      }
    }
  }

  private grow(q: number, by: number): void {
    const m = (this.mass[q] as number) + by;
    this.mass[q] = m;
    this.rad[q] = this.radiusOf(m);
    if (m > (this.peak[q] as number)) this.peak[q] = m;
  }

  private takeBoosters(R: number): void {
    for (const b of this.boosters) {
      if (b.until !== Number.MAX_SAFE_INTEGER) continue;
      if (b.x * b.x + b.y * b.y > R * R) {
        b.until = this.step;
        continue;
      }
      let taker = -1;
      const consider = (o: number) => {
        if (taker >= 0 || !this.alive[o]) return;
        // A chip in the duel can be taken from a little way off: the two can't
        // pin each other out of reach of one lying between them.
        const reach = (this.rad[o] as number) + this.rb + (b.gain > 1 ? 16 : 0);
        const ex = (this.x[o] as number) - b.x;
        const ey = (this.y[o] as number) - b.y;
        if (ex * ex + ey * ey < reach * reach) taker = o;
      };
      const c0 = this.cellOf(b.x - SMALL_R - this.rb);
      const c1 = this.cellOf(b.x + SMALL_R + this.rb);
      const r0 = this.cellOf(b.y - SMALL_R - this.rb);
      const r1 = this.cellOf(b.y + SMALL_R + this.rb);
      for (let r = r0; r <= r1 && taker < 0; r++) {
        for (let c = c0; c <= c1 && taker < 0; c++) {
          for (
            let o = this.head[c + r * this.cols] as number;
            o >= 0 && taker < 0;
            o = this.nextInCell[o] as number
          ) {
            consider(o);
          }
        }
      }
      for (const o of this.bigs) {
        if (taker >= 0) break;
        consider(o);
      }
      if (taker >= 0) {
        b.until = this.step;
        b.taker = taker;
        if (b.gain > 1) b.gain = this.chipGain(taker);
        this.grow(taker, b.gain);
      }
    }
  }

  private eat(a: number, b: number): void {
    this.eats.push({
      step: this.step,
      eater: a,
      eaten: b,
      mass: this.mass[b] as number,
      x: this.x[b] as number,
      y: this.y[b] as number,
    });
    this.grow(a, this.mass[b] as number);
    this.alive[b] = 0;
    this.nAlive--;
    this.lastEat = this.step;
  }

  /** Two discs meet: returns true if `p` went down. */
  private meet(p: number, q: number, mayEat: boolean): boolean {
    if (!this.alive[p] || !this.alive[q]) return false;
    const ex = (this.x[q] as number) - (this.x[p] as number);
    const ey = (this.y[q] as number) - (this.y[p] as number);
    const rr = (this.rad[p] as number) + (this.rad[q] as number);
    const d2 = ex * ex + ey * ey;
    if (d2 >= rr * rr) return false;
    const mp = this.mass[p] as number;
    const mq = this.mass[q] as number;
    if (mayEat && mp !== mq) {
      if (mp > mq) {
        this.eat(p, q);
        return false;
      }
      this.eat(q, p);
      return true;
    }
    // Equal, or the eating is ahead of its curve: they bounce apart.
    if (this.finalStep >= 0 && this.nAlive === 2) this.recoil = RECOIL_STEPS;
    const d = Math.sqrt(d2) || 1e-9;
    const nx = d2 === 0 ? 1 : ex / d;
    const ny = d2 === 0 ? 0 : ey / d;
    const push = (rr - d) / 2 + 0.01;
    this.x[p] = (this.x[p] as number) - nx * push;
    this.y[p] = (this.y[p] as number) - ny * push;
    this.x[q] = (this.x[q] as number) + nx * push;
    this.y[q] = (this.y[q] as number) + ny * push;
    this.setDirection(p, -nx, -ny);
    this.setDirection(q, nx, ny);
    return false;
  }

  private mayEat(p: number, q: number): boolean {
    if (this.finalStep < 0) return this.nAlive > aliveFloor(this.step, this.n);
    // A hunt blocked for too long: anything goes, so a battle always ends.
    if (this.step > this.huntEnd + FORCE_AFTER) return true;
    return this.locked[q] === p || this.locked[p] === q;
  }

  private collide(): void {
    const { order, cols } = this;
    for (let k = 0; k < order.length; k++) {
      const p = order[k] as number;
      if (!this.alive[p]) continue;
      const big = (this.rad[p] as number) > SMALL_R;
      const reach = big ? (this.rad[p] as number) + SMALL_R : CELL;
      const c0 = this.cellOf((this.x[p] as number) - reach);
      const c1 = this.cellOf((this.x[p] as number) + reach);
      const r0 = this.cellOf((this.y[p] as number) - reach);
      const r1 = this.cellOf((this.y[p] as number) + reach);
      let down = false;
      for (let r = r0; r <= r1 && !down; r++) {
        for (let c = c0; c <= c1 && !down; c++) {
          for (
            let q = this.head[c + r * cols] as number;
            q >= 0 && !down;
            q = this.nextInCell[q] as number
          ) {
            // A small pair is met from its lower id; a big disc meets every
            // small one it reaches.
            if (q === p || (!big && q < p)) continue;
            down = this.meet(p, q, this.mayEat(p, q));
          }
        }
      }
      if (down || !big) continue;
      for (const q of this.bigs) {
        if (q <= p) continue;
        if (this.meet(p, q, this.mayEat(p, q))) break;
      }
    }
  }

  private compact(): void {
    const { order, alive } = this;
    let n = 0;
    for (let k = 0; k < order.length; k++) {
      const q = order[k] as number;
      if (alive[q]) order[n++] = q;
    }
    if (n !== order.length) this.order = order.subarray(0, n);
  }

  private tieBreak(a: number, b: number): void {
    const w = this.rng.int(2) === 0 ? a : b;
    this.grow(w, 1);
    this.nudges.push({ step: this.step, disc: w });
  }

  private tableMass(): number {
    let total = 0;
    for (let k = 0; k < this.order.length; k++) {
      total += this.mass[this.order[k] as number] as number;
    }
    return total;
  }

  private lock(hunter: number, prey: number, until: number): void {
    if (this.mass[hunter] === this.mass[prey]) this.tieBreak(hunter, prey);
    const big =
      (this.mass[hunter] as number) > (this.mass[prey] as number)
        ? hunter
        : prey;
    const small = big === hunter ? prey : hunter;
    this.hunter = big;
    this.prey = small;
    this.locked[small] = big;
    this.sweeping = false;
    this.huntEnd = until;
    this.rounds.push({ from: this.step, pairs: [big, small] });
  }

  /** The next beat of the final: scraps all at once, then one duel at a time, the
   *  smallest going to any disc bigger than it, so the lead can change hands. */
  private planBeat(): void {
    const ids = Array.from(this.order);
    const total = this.tableMass();
    const scraps = ids.filter(
      (q) => (this.mass[q] as number) < total * SCRAP_SHARE,
    );
    const solid = ids.filter((q) => !scraps.includes(q));
    if (scraps.length > 0 && solid.length >= 2) {
      const pairs: number[] = [];
      for (const s of scraps) {
        let best = solid[0] as number;
        let bestD = Infinity;
        for (const b of solid) {
          const ex = (this.x[b] as number) - (this.x[s] as number);
          const ey = (this.y[b] as number) - (this.y[s] as number);
          const d = ex * ex + ey * ey;
          if (d < bestD) {
            bestD = d;
            best = b;
          }
        }
        this.locked[s] = best;
        pairs.push(best, s);
      }
      this.sweeping = true;
      this.hunter = -1;
      this.prey = -1;
      this.huntEnd = this.step + SWEEP_STEPS;
      this.rounds.push({ from: this.step, pairs });
      return;
    }
    let smallest = ids[0] as number;
    for (const q of ids) {
      if ((this.mass[q] as number) < (this.mass[smallest] as number))
        smallest = q;
    }
    const others = ids.filter((q) => q !== smallest);
    const hunter = others[this.rng.int(others.length)] as number;
    const beats = Math.max(1, ids.length - 2);
    const room = Math.floor((DUEL_STEP - this.step) / beats);
    this.lock(hunter, smallest, this.step + Math.max(MIN_BEAT, room));
  }

  /** Two left: foil chips land one by one, each big enough to swap the lead, so
   *  who is ahead stays in question until the very end. */
  private landChip(R: number): void {
    const reach = R * 0.62;
    let px = 0;
    let py = 0;
    do {
      px = (this.rng.float() * 2 - 1) * reach;
      py = (this.rng.float() * 2 - 1) * reach;
    } while (px * px + py * py > reach * reach);
    this.boosters.push({
      x: px,
      y: py,
      from: this.step,
      until: Number.MAX_SAFE_INTEGER,
      taker: -1,
      gain: 2, // until it is taken: see chipGain
    });
    this.chipsLanded++;
    this.nextChip = this.step + CHIP_EVERY;
  }

  /** A chip lifts whoever is behind past whoever is ahead, and gives the leader
   *  only a little: the lead swaps, and neither runs away with it. */
  private chipGain(taker: number): number {
    const other = (
      this.order[0] === taker ? this.order[1] : this.order[0]
    ) as number;
    const behind = (this.mass[other] as number) - (this.mass[taker] as number);
    const small = Math.round(this.tableMass() * 0.02);
    return Math.max(small, Math.round(behind * 1.25));
  }

  private nearestChip(q: number): { x: number; y: number } | null {
    let best: ArenaBooster | null = null;
    let bestD = Infinity;
    for (const b of this.boosters) {
      if (b.until !== Number.MAX_SAFE_INTEGER || b.gain <= 1) continue;
      const ex = b.x - (this.x[q] as number);
      const ey = b.y - (this.y[q] as number);
      const d = ex * ex + ey * ey;
      if (d < bestD) {
        bestD = d;
        best = b;
      }
    }
    return best;
  }

  private moveFinal(R: number): void {
    const huntOn =
      this.prey >= 0 && this.alive[this.prey] && this.alive[this.hunter];
    let sweepOn = false;
    if (this.sweeping) {
      for (let k = 0; k < this.order.length && !sweepOn; k++) {
        const q = this.order[k] as number;
        const h = this.locked[q] as number;
        sweepOn = h >= 0 && this.alive[h] === 1;
      }
    }
    if (!huntOn && !sweepOn) {
      this.prey = -1;
      this.hunter = -1;
      this.sweeping = false;
      if (this.nAlive > 2) {
        this.planBeat();
      } else if (this.nAlive === 2) {
        this.huntEnd = LAST_STEP;
        if (
          this.chipsLanded < DUEL_CHIPS &&
          this.step >= this.nextChip &&
          this.step < CHOMP_STEP - RECOIL_STEPS
        ) {
          this.landChip(R);
        }
        if (this.step >= CHOMP_STEP) {
          for (const b of this.boosters) {
            if (b.until === Number.MAX_SAFE_INTEGER) b.until = this.step;
          }
          this.lock(
            this.order[0] as number,
            this.order[1] as number,
            Math.max(LAST_STEP, this.step + 6),
          );
        }
      }
    }

    const duel = this.nAlive === 2 && this.prey < 0;
    const parting =
      duel && (this.recoil > 0 || this.step >= CHOMP_STEP - RECOIL_STEPS);
    if (this.recoil > 0) this.recoil--;
    const { order } = this;
    for (let k = 0; k < order.length; k++) {
      const q = order[k] as number;
      const sweptTo = this.sweeping ? (this.locked[q] as number) : -1;
      if (q === this.hunter || (sweptTo >= 0 && this.alive[sweptTo])) {
        // The hunter runs its prey down; a scrap is pulled in to whoever owns it.
        const to = q === this.hunter ? this.prey : sweptTo;
        const tx = (this.x[to] as number) - (this.x[q] as number);
        const ty = (this.y[to] as number) - (this.y[q] as number);
        const tl = Math.sqrt(tx * tx + ty * ty) || 1;
        const gap = tl - (this.rad[q] as number) - (this.rad[to] as number);
        const left = Math.max(1, this.huntEnd - this.step);
        const natural = speedOf(this.mass[q] as number) / STEP_HZ;
        const sp = Math.max(natural, gap / left + 0.5);
        this.setDirection(q, tx / tl, ty / tl);
        this.x[q] = (this.x[q] as number) + (this.dx[q] as number) * sp;
        this.y[q] = (this.y[q] as number) + (this.dy[q] as number) * sp;
      } else if (duel) {
        // The last two race for the chips, or circle while none are left.
        const chip = parting ? null : this.nearestChip(q);
        const lean = this.leanIn(q, R);
        let ux = (this.dx[q] as number) + lean.x;
        let uy = (this.dy[q] as number) + lean.y;
        if (chip) {
          ux = chip.x - (this.x[q] as number);
          uy = chip.y - (this.y[q] as number);
        } else if (parting) {
          const other = (order[0] === q ? order[1] : order[0]) as number;
          ux = (this.x[q] as number) - (this.x[other] as number) + lean.x * 200;
          uy = (this.y[q] as number) - (this.y[other] as number) + lean.y * 200;
        }
        this.setDirection(q, ux, uy);
        // Bigger is slower here too, which keeps the trailing disc in the race.
        const other = (order[0] === q ? order[1] : order[0]) as number;
        const pace =
          (this.mass[q] as number) > (this.mass[other] as number) ? 0.8 : 1.1;
        const sp =
          (parting ? PART_SPEED : chip ? DUEL_SPEED * pace : DUEL_SPEED * 0.4) /
          STEP_HZ;
        this.x[q] = (this.x[q] as number) + (this.dx[q] as number) * sp;
        this.y[q] = (this.y[q] as number) + (this.dy[q] as number) * sp;
      } else {
        const lean = this.leanIn(q, R);
        const ux =
          (this.dx[q] as number) + (this.rng.float() - 0.5) * 0.4 + lean.x;
        const uy =
          (this.dy[q] as number) + (this.rng.float() - 0.5) * 0.4 + lean.y;
        this.setDirection(q, ux, uy);
        const sp = (speedOf(this.mass[q] as number) * 0.7) / STEP_HZ;
        this.x[q] = (this.x[q] as number) + (this.dx[q] as number) * sp;
        this.y[q] = (this.y[q] as number) + (this.dy[q] as number) * sp;
      }
      this.clampToTable(q, R);
    }
  }

  /** One step. False once one disc is left. */
  advance(): boolean {
    if (this.finished) return false;
    if (this.nAlive <= 1) {
      this.finished = true;
      return false;
    }
    this.step++;
    const R = tableRadius(this.step);
    this.dropWaves(R);
    this.rebuildGrid();
    if (this.finalStep < 0 && this.step >= FINAL_STEP) {
      this.finalStep = this.step;
    }
    if (this.finalStep >= 0) {
      this.moveFinal(R);
    } else {
      // Behind the curve, everyone hurries: 0 on pace, 1 at half again too many.
      const floor = aliveFloor(this.step, this.n);
      const pressure = Math.min(1, Math.max(0, this.nAlive / floor - 1) * 2);
      this.moveAll(R, pressure);
    }
    this.rebuildGrid();
    this.takeBoosters(R);
    this.collide();
    // Few and big in the final: a second pass keeps a pile-up from overlapping.
    if (this.finalStep >= 0) this.collide();
    this.compact();
    for (let k = 0; k < this.order.length; k++) {
      const q = this.order[k] as number;
      this.rad[q] = this.radiusOf(this.mass[q] as number);
    }
    this.record();
    if (this.nAlive <= 1 || this.step >= HARD_STOP) {
      this.finished = true;
      return false;
    }
    return true;
  }

  get done(): boolean {
    return this.finished;
  }

  /** The recording. Call once done. */
  result(): ArenaRun {
    const survivor = this.order[0] ?? 0;
    return {
      dots: this.n,
      r0: this.r0,
      frameStart: this.frameStart.subarray(0, this.step + 2),
      ids: this.rec.ids.subarray(0, this.rec.length),
      xs: this.rec.xs.subarray(0, this.rec.length),
      ys: this.rec.ys.subarray(0, this.rec.length),
      masses: this.rec.masses.subarray(0, this.rec.length),
      radius: this.radius.subarray(0, this.step + 1),
      eats: this.eats,
      boosters: this.boosters,
      rounds: this.rounds,
      nudges: this.nudges,
      finalStep: this.finalStep < 0 ? this.step : this.finalStep,
      lastStep: this.lastEat > 0 ? this.lastEat : this.step,
      survivor,
      peak: this.peak,
    };
  }
}

/** The whole battle at once: tests and any caller with no frame to protect. */
export function runArena(seed: Seed4, dots: number): ArenaRun {
  const sim = new ArenaSim(seed, dots);
  while (sim.advance());
  return sim.result();
}
