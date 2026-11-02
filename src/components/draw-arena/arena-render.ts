import { HOLO_STOPS } from '@/lib/lucky-draw';
import type { ArenaRun } from '@/lib/arena/engine';
import { ARENA_R0 } from '@/lib/arena/engine';
import { LAST_EAT_AT, REVEAL_MS, stepAt } from '@/lib/arena/timeline';

// The arena on a canvas, no React. A matte round table under one lamp, ringed in
// the Lucky Draw's holo foil; every disc a token with a player's picture on it.
// Everything is drawn from the recording, so any moment of the show can be drawn
// at any time; the springs and sparks only add life when time is moving.

export type ArenaCast = {
  run: ArenaRun;
  /** Entry index per disc. */
  owners: Int32Array;
  /** Display name per entry. */
  names: readonly string[];
  me: number | null;
};

/** Pictures for the discs that get big enough to show one. */
export type TokenSprites = {
  get: (entry: number) => CanvasImageSource | null;
};

export type ArenaEvent =
  | { kind: 'eat'; share: number; mine: boolean }
  | { kind: 'wave' }
  | { kind: 'last' };

export type ArenaRenderer = {
  resize: (cssWidth: number, cssHeight: number) => void;
  /** Draw moment `t` (ms). `dt` is seconds since the last draw; 0 means a jump. */
  draw: (t: number, dt: number) => void;
};

const TOKEN_MIN_R = 1.9; // css px: below this a face can't be seen, so a dot
const SHADOW_MIN_R = 7;
const LABEL_MIN_R = 17;
const DOT_COLOR = '#9a9ea8';
const DOT_FED = '#c9ccd3';
const ME_COLOR = '#ffffff';
const FLOOR_IN = '#1d1d21';
const FLOOR_MID = '#131315';
const FLOOR_OUT = '#0c0c0d';
const INTRO_MS = 1_400;
const ABSORB_S = 0.17;
const MAX_ABSORBS = 90;
const MAX_RIPPLES = 16;
const MAX_GLINTS = 40;

type Absorb = {
  x: number;
  y: number;
  r: number;
  eater: number;
  eaten: number;
  age: number;
};
type Ripple = {
  x: number;
  y: number;
  from: number;
  to: number;
  age: number;
  life: number;
  alpha: number;
  gold: boolean;
};
type Glint = { x: number; y: number; age: number; c: string };

const cssFont = (cssVar: string, fallback: string): string => {
  if (typeof window === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(cssVar)
    .trim();
  return v ? `${v}, ${fallback}` : fallback;
};

function makeShadow(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  if (g) {
    const r = g.createRadialGradient(32, 32, 10, 32, 32, 32);
    r.addColorStop(0, 'rgba(0,0,0,.62)');
    r.addColorStop(0.62, 'rgba(0,0,0,.34)');
    r.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = r;
    g.fillRect(0, 0, 64, 64);
  }
  return c;
}

export function createArenaRenderer(
  canvas: HTMLCanvasElement,
  cast: ArenaCast,
  sprites: TokenSprites,
  onEvent?: (e: ArenaEvent) => void,
): ArenaRenderer {
  const ctx = canvas.getContext('2d');
  const { run, owners, names, me } = cast;
  const n = run.dots;
  const lastFrame = run.radius.length - 1;
  const totalMass = (() => {
    const at = run.frameStart[lastFrame] as number;
    return run.masses[at] as number;
  })();
  const sansFont = cssFont('--font-geist-sans', 'system-ui, sans-serif');
  const headFont = cssFont('--font-nekst', 'system-ui, sans-serif');
  const shadow = typeof document === 'undefined' ? null : makeShadow();

  let dpr = 1;
  let W = 0;
  let H = 0;
  const cam = { x: 0, y: 0, h: ARENA_R0 * 0.5, kick: 0 };
  let eatCursor = 0;
  let waveSeen = 0;
  let boosterCursor = 0;
  let nudgeCursor = 0;
  let lastFired = false;
  let lastStepDrawn = -1;
  let clock = 0;
  let clockT = 0;
  const absorbs: Absorb[] = [];
  const ripples: Ripple[] = [];
  const glints: Glint[] = [];
  const posX = new Float32Array(n);
  const posY = new Float32Array(n);
  // A disc's shown radius springs to its real one, so a meal lands with weight.
  const shownR = new Float32Array(n);
  const velR = new Float32Array(n);
  const labels: { name: string; size: number; x: number; y: number }[] = [];
  const takenBoosters = run.boosters
    .filter((b) => b.taker >= 0)
    .sort((a, b) => a.until - b.until);
  const waveSteps = Array.from(new Set(run.boosters.map((b) => b.from))).sort(
    (a, b) => a - b,
  );

  const resetCursors = (step: number) => {
    eatCursor = 0;
    while (
      eatCursor < run.eats.length &&
      (run.eats[eatCursor]?.step ?? 0) <= step
    ) {
      eatCursor++;
    }
    boosterCursor = 0;
    while (
      boosterCursor < takenBoosters.length &&
      (takenBoosters[boosterCursor]?.until ?? 0) <= step
    ) {
      boosterCursor++;
    }
    nudgeCursor = 0;
    while (
      nudgeCursor < run.nudges.length &&
      (run.nudges[nudgeCursor]?.step ?? 0) <= step
    ) {
      nudgeCursor++;
    }
    waveSeen = waveSteps.filter((w) => w <= step).length;
    lastFired = step >= run.lastStep;
    absorbs.length = 0;
    ripples.length = 0;
    glints.length = 0;
  };

  const spawnEvents = (step: number) => {
    while (waveSeen < waveSteps.length && (waveSteps[waveSeen] ?? 0) <= step) {
      waveSeen++;
      onEvent?.({ kind: 'wave' });
    }
    while (
      boosterCursor < takenBoosters.length &&
      (takenBoosters[boosterCursor]?.until ?? 0) <= step
    ) {
      const b = takenBoosters[boosterCursor++];
      if (b && b.gain > 1 && ripples.length < MAX_RIPPLES) {
        ripples.push({
          x: b.x,
          y: b.y,
          from: 10,
          to: 150,
          age: 0,
          life: 0.5,
          alpha: 0.8,
          gold: false,
        });
        onEvent?.({ kind: 'wave' });
      }
      if (b && glints.length < MAX_GLINTS) {
        glints.push({
          x: b.x,
          y: b.y,
          age: 0,
          c: HOLO_STOPS[boosterCursor % HOLO_STOPS.length] ?? '#fff',
        });
      }
    }
    let biggest = 0;
    let biggestMine = false;
    while (eatCursor < run.eats.length) {
      const e = run.eats[eatCursor];
      if (!e || e.step > step) break;
      eatCursor++;
      const r = run.r0 * Math.sqrt(e.mass);
      if (absorbs.length < MAX_ABSORBS) {
        absorbs.push({
          x: e.x,
          y: e.y,
          r,
          eater: e.eater,
          eaten: e.eaten,
          age: 0,
        });
      }
      const share = e.mass / totalMass;
      if (share >= 0.008 && ripples.length < MAX_RIPPLES) {
        ripples.push({
          x: e.x,
          y: e.y,
          from: r,
          to: r * 1.9 + 30,
          age: 0,
          life: 0.55,
          alpha: Math.min(0.5, 0.22 + share * 2),
          gold: false,
        });
        cam.kick = Math.max(cam.kick, Math.min(0.035, share * 0.18));
      }
      if (share > biggest) {
        biggest = share;
        biggestMine = owners[e.eater] === me || owners[e.eaten] === me;
      }
    }
    if (biggest > 0) {
      onEvent?.({ kind: 'eat', share: biggest, mine: biggestMine });
    }
    if (!lastFired && step >= run.lastStep) {
      lastFired = true;
      onEvent?.({ kind: 'last' });
      const at = run.frameStart[lastFrame] as number;
      const r = run.r0 * Math.sqrt(run.masses[at] as number);
      for (let k = 0; k < 3; k++) {
        ripples.push({
          x: run.xs[at] as number,
          y: run.ys[at] as number,
          from: r,
          to: r * (1.7 + k * 0.6),
          age: -k * 0.16,
          life: 1.1,
          alpha: 0.85,
          gold: true,
        });
      }
    }
  };

  const updateCamera = (
    t: number,
    step: number,
    R: number,
    from: number,
    to: number,
    dt: number,
  ) => {
    let tx = 0;
    let ty = 0;
    let th = R * 1.05;
    if (t < INTRO_MS) {
      const x = t / INTRO_MS;
      const e = 1 - (1 - x) * (1 - x) * (1 - x);
      th = R * (0.66 + 0.39 * e);
    }
    if (t >= LAST_EAT_AT) {
      const at = run.frameStart[lastFrame] as number;
      tx = run.xs[at] as number;
      ty = run.ys[at] as number;
      th = run.r0 * Math.sqrt(run.masses[at] as number) * 1.75;
    } else if (to - from <= 2 && step >= run.finalStep) {
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      let maxR = 0;
      for (let k = from; k < to; k++) {
        const id = run.ids[k] as number;
        const r = run.r0 * Math.sqrt(run.masses[k] as number);
        const x = posX[id] as number;
        const y = posY[id] as number;
        if (x - r < x0) x0 = x - r;
        if (x + r > x1) x1 = x + r;
        if (y - r < y0) y0 = y - r;
        if (y + r > y1) y1 = y + r;
        if (r > maxR) maxR = r;
      }
      tx = (x0 + x1) / 2;
      ty = (y0 + y1) / 2;
      th = Math.min(
        R * 1.05,
        Math.max((Math.max(x1 - x0, y1 - y0) / 2) * 1.32, maxR * 1.7),
      );
    }
    const k = dt === 0 ? 1 : 1 - Math.exp(-dt * (t >= LAST_EAT_AT ? 2.4 : 3.4));
    cam.x += (tx - cam.x) * k;
    cam.y += (ty - cam.y) * k;
    cam.h += (th - cam.h) * k;
    cam.kick *= dt === 0 ? 0 : Math.exp(-dt * 9);
  };

  const drawFloor = (
    S: number,
    ox: number,
    oy: number,
    R: number,
    fin: boolean,
  ) => {
    if (!ctx) return;
    const cx = ox;
    const cy = oy;
    const rr = R * S;
    const lamp = ctx.createRadialGradient(
      cx,
      cy - rr * 0.28,
      rr * 0.05,
      cx,
      cy,
      rr,
    );
    lamp.addColorStop(0, FLOOR_IN);
    lamp.addColorStop(0.62, FLOOR_MID);
    lamp.addColorStop(1, FLOOR_OUT);
    ctx.fillStyle = lamp;
    ctx.beginPath();
    ctx.arc(cx, cy, rr, 0, Math.PI * 2);
    ctx.fill();

    // The house mark, printed into the table.
    const size = Math.round(150 * S);
    if (size >= 8) {
      ctx.save();
      ctx.globalAlpha = fin ? 0.035 : 0.055;
      ctx.fillStyle = '#ffffff';
      ctx.font = `900 ${size}px ${headFont}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('POLYCARDS', cx, cy);
      ctx.restore();
    }

    // The foil rim: a thin ring whose light turns slowly, like the old wheel's.
    const width = Math.max(1.6 * dpr, Math.min(4 * dpr, rr * 0.012));
    const stroke = (lineWidth: number, alpha: number) => {
      ctx.globalAlpha = alpha;
      ctx.lineWidth = lineWidth;
      ctx.beginPath();
      ctx.arc(cx, cy, rr, 0, Math.PI * 2);
      ctx.stroke();
    };
    if (typeof ctx.createConicGradient === 'function') {
      const foil = ctx.createConicGradient(clock * 0.7, cx, cy);
      const stops = [...HOLO_STOPS, HOLO_STOPS[0]];
      stops.forEach((c, i) => foil.addColorStop(i / (stops.length - 1), c));
      ctx.strokeStyle = foil;
    } else {
      ctx.strokeStyle = HOLO_STOPS[3];
    }
    stroke(width * 3.4, 0.12);
    stroke(width, 0.95);
    ctx.globalAlpha = 1;
  };

  const drawBoosters = (step: number, S: number, ox: number, oy: number) => {
    if (!ctx) return;
    const base = run.r0 * 0.85 * S;
    run.boosters.forEach((b, i) => {
      if (b.from > step || b.until <= step) return;
      const grow = Math.min(1, (step - b.from + 1) / 7);
      const px = ox + b.x * S;
      const py = oy + b.y * S;
      if (px < -8 || py < -8 || px > W + 8 || py > H + 8) return;
      const pulse = 0.82 + 0.18 * Math.sin(clock * 7 + i);
      const r = Math.max((b.gain > 1 ? 4.2 : 1.9) * dpr, base) * grow * pulse;
      const c = HOLO_STOPS[i % HOLO_STOPS.length] ?? '#fff';
      ctx.fillStyle = c;
      ctx.globalAlpha = 0.16;
      ctx.beginPath();
      ctx.arc(px, py, r * 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      // A chip of foil: a diamond, so it can't be mistaken for a disc.
      ctx.beginPath();
      ctx.moveTo(px, py - r * 1.3);
      ctx.lineTo(px + r, py);
      ctx.lineTo(px, py + r * 1.3);
      ctx.lineTo(px - r, py);
      ctx.closePath();
      ctx.fill();
    });
  };

  const drawToken = (
    id: number,
    px: number,
    py: number,
    r: number,
    crown: number,
  ) => {
    if (!ctx) return;
    const owner = owners[id] as number;
    const mine = owner === me;
    if (shadow && r / dpr >= SHADOW_MIN_R) {
      const sr = r * 1.32;
      ctx.drawImage(shadow, px - sr, py - sr + r * 0.2, sr * 2, sr * 2);
    }
    const sprite = sprites.get(owner);
    if (sprite) {
      ctx.drawImage(sprite, px - r, py - r, r * 2, r * 2);
    } else {
      // Past the picture cap: a plain disc, still readable on the table.
      ctx.fillStyle = DOT_COLOR;
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fill();
    }
    const rc = r / dpr;
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.lineWidth = mine
      ? Math.max(1.2 * dpr, r * 0.09)
      : Math.max(0.5 * dpr, r * 0.05);
    ctx.strokeStyle = mine ? ME_COLOR : 'rgba(228,228,231,.72)';
    ctx.stroke();
    if (crown > 0 && typeof ctx.createConicGradient === 'function') {
      const foil = ctx.createConicGradient(clock * 1.4, px, py);
      const stops = [...HOLO_STOPS, HOLO_STOPS[0]];
      stops.forEach((c, i) => foil.addColorStop(i / (stops.length - 1), c));
      ctx.strokeStyle = foil;
      ctx.lineWidth = Math.max(2.5 * dpr, r * 0.05);
      ctx.globalAlpha = crown;
      ctx.beginPath();
      ctx.arc(px, py, r * 1.045, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    // Once the winner is told the panel names them; a label would peek out from
    // under the prize.
    if (rc >= LABEL_MIN_R && W / dpr >= 220 && clockT < REVEAL_MS) {
      labels.push({
        name: mine ? 'You' : (names[owner] ?? ''),
        size: Math.max(10, Math.min(14, rc * 0.36)) * dpr,
        x: px,
        y: Math.min(py + r + 3 * dpr, H - 16 * dpr),
      });
    }
  };

  const drawLabels = () => {
    if (!ctx) return;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3 * dpr;
    ctx.strokeStyle = 'rgba(10,10,10,.82)';
    ctx.fillStyle = '#fafafa';
    for (const l of labels) {
      const short = l.name.length > 13 ? `${l.name.slice(0, 12)}…` : l.name;
      ctx.font = `600 ${l.size}px ${sansFont}`;
      ctx.strokeText(short, l.x, l.y);
      ctx.fillText(short, l.x, l.y);
    }
    labels.length = 0;
  };

  const draw = (t: number, dt: number) => {
    if (!ctx || !W) return;
    clockT = t;
    clock += dt;
    const s = stepAt(t, run.lastStep);
    const i = Math.min(Math.floor(s), lastFrame);
    const f = i >= lastFrame ? 0 : s - i;
    if (dt === 0 || i < lastStepDrawn) {
      resetCursors(i);
      for (let k = 0; k < n; k++) {
        shownR[k] = 0;
        velR[k] = 0;
      }
    } else if (i !== lastStepDrawn) {
      spawnEvents(i);
    }
    lastStepDrawn = i;

    const R =
      (run.radius[i] as number) +
      ((run.radius[Math.min(i + 1, lastFrame)] as number) -
        (run.radius[i] as number)) *
        f;
    const from = run.frameStart[i] as number;
    const to = run.frameStart[i + 1] as number;
    const nextFrom = i >= lastFrame ? to : (run.frameStart[i + 1] as number);
    const nextTo = i >= lastFrame ? to : (run.frameStart[i + 2] as number);

    // Positions first: the camera and the meals read them.
    let j = nextFrom;
    for (let k = from; k < to; k++) {
      const id = run.ids[k] as number;
      while (j < nextTo && (run.ids[j] as number) < id) j++;
      const x0 = run.xs[k] as number;
      const y0 = run.ys[k] as number;
      if (j < nextTo && run.ids[j] === id) {
        posX[id] = x0 + ((run.xs[j] as number) - x0) * f;
        posY[id] = y0 + ((run.ys[j] as number) - y0) * f;
      } else {
        posX[id] = x0;
        posY[id] = y0;
      }
    }

    updateCamera(t, s, R, from, to, dt);

    const half = Math.min(W, H) / 2;
    const S = (half / cam.h) * (1 + cam.kick);
    const ox = W / 2 - cam.x * S;
    const oy = H / 2 - cam.y * S;

    ctx.clearRect(0, 0, W, H);
    drawFloor(S, ox, oy, R, s >= run.finalStep);
    drawBoosters(i, S, ox, oy);

    // The final's hunts: a hairline from each hunter to its prey.
    if (s >= run.finalStep && s < run.lastStep) {
      let round: ArenaRun['rounds'][number] | null = null;
      for (const r of run.rounds) if (r.from <= s) round = r;
      if (round) drawHunts(round.pairs);
    }

    // Dots in one path per colour; tokens after, smallest first, biggest on top.
    const tokens: number[] = [];
    ctx.fillStyle = DOT_COLOR;
    ctx.beginPath();
    // Capped: at 11 fps or under, a full step would make this spring blow up.
    const springDt = Math.min(dt, 1 / 30);
    const fed: number[] = [];
    const mine: number[] = [];
    for (let k = from; k < to; k++) {
      const id = run.ids[k] as number;
      const m = run.masses[k] as number;
      const real = run.r0 * Math.sqrt(m) * S;
      let r = real;
      if (real / dpr >= 2.5) {
        if (dt === 0 || shownR[id] === 0) {
          shownR[id] = real;
          velR[id] = 0;
        } else {
          // Underdamped: overshoots a little, then settles.
          const v =
            (velR[id] as number) +
            (160 * (real - (shownR[id] as number)) -
              15 * (velR[id] as number)) *
              springDt;
          velR[id] = v;
          shownR[id] = (shownR[id] as number) + v * springDt;
        }
        r = shownR[id] as number;
      }
      if (r / dpr >= TOKEN_MIN_R) {
        tokens.push(k);
        continue;
      }
      const owner = owners[id] as number;
      if (owner === me) {
        mine.push(k);
        continue;
      }
      if (m > 1) {
        fed.push(k);
        continue;
      }
      const px = ox + (posX[id] as number) * S;
      const py = oy + (posY[id] as number) * S;
      const dot = Math.max(0.9 * dpr, r);
      ctx.moveTo(px + dot, py);
      ctx.arc(px, py, dot, 0, Math.PI * 2);
    }
    ctx.fill();
    const dots = (list: number[], color: string, grow: number) => {
      if (list.length === 0) return;
      ctx.fillStyle = color;
      ctx.beginPath();
      for (const k of list) {
        const id = run.ids[k] as number;
        const px = ox + (posX[id] as number) * S;
        const py = oy + (posY[id] as number) * S;
        const real = run.r0 * Math.sqrt(run.masses[k] as number) * S;
        const dot = Math.max(1 * dpr, real) * grow;
        ctx.moveTo(px + dot, py);
        ctx.arc(px, py, dot, 0, Math.PI * 2);
      }
      ctx.fill();
    };
    dots(fed, DOT_FED, 1);
    dots(mine, ME_COLOR, 1.25);

    // Meals: the eaten disc slides into its eater and is gone.
    for (let a = absorbs.length - 1; a >= 0; a--) {
      const m = absorbs[a];
      if (!m) continue;
      m.age += dt;
      const x = m.age / ABSORB_S;
      if (x >= 1) {
        absorbs.splice(a, 1);
        continue;
      }
      const e = x * x;
      const px = m.x + ((posX[m.eater] as number) - m.x) * e;
      const py = m.y + ((posY[m.eater] as number) - m.y) * e;
      const r = m.r * S * (1 - e);
      if (r < 0.4) continue;
      ctx.globalAlpha = 1 - e * 0.5;
      // A disc big enough to show a face keeps it on the way down.
      const face =
        r / dpr >= TOKEN_MIN_R ? sprites.get(owners[m.eaten] as number) : null;
      if (face) {
        const sx = ox + px * S;
        const sy = oy + py * S;
        ctx.drawImage(face, sx - r, sy - r, r * 2, r * 2);
      } else {
        ctx.fillStyle = owners[m.eaten] === me ? ME_COLOR : DOT_FED;
        ctx.beginPath();
        ctx.arc(ox + px * S, oy + py * S, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;

    tokens.sort(
      (a, b) => (run.masses[a] as number) - (run.masses[b] as number),
    );
    const crown = t >= LAST_EAT_AT ? Math.min(1, (t - LAST_EAT_AT) / 500) : 0;
    for (const k of tokens) {
      const id = run.ids[k] as number;
      const px = ox + (posX[id] as number) * S;
      const py = oy + (posY[id] as number) * S;
      const r = shownR[id] as number;
      if (px + r < -40 || py + r < -40 || px - r > W + 40 || py - r > H + 40) {
        continue;
      }
      drawToken(id, px, py, r, to - from === 1 ? crown : 0);
    }
    drawLabels();

    // Rings on the table where something big went down.
    for (let a = ripples.length - 1; a >= 0; a--) {
      const r = ripples[a];
      if (!r) continue;
      r.age += dt;
      if (r.age >= r.life) {
        ripples.splice(a, 1);
        continue;
      }
      if (r.age < 0) continue;
      const x = r.age / r.life;
      const e = 1 - (1 - x) * (1 - x) * (1 - x);
      ctx.globalAlpha = r.alpha * (1 - x);
      ctx.strokeStyle = r.gold ? '#ffb020' : '#ffffff';
      ctx.lineWidth = Math.max(1, (r.gold ? 2.4 : 1.4) * dpr * (1 - x * 0.6));
      ctx.beginPath();
      ctx.arc(
        ox + r.x * S,
        oy + r.y * S,
        (r.from + (r.to - r.from) * e) * S,
        0,
        Math.PI * 2,
      );
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // A booster taken: one four-point glint.
    for (let a = glints.length - 1; a >= 0; a--) {
      const g = glints[a];
      if (!g) continue;
      g.age += dt;
      if (g.age >= 0.32) {
        glints.splice(a, 1);
        continue;
      }
      const x = g.age / 0.32;
      const L = (2 + 7 * x) * dpr;
      const px = ox + g.x * S;
      const py = oy + g.y * S;
      ctx.globalAlpha = 1 - x;
      ctx.strokeStyle = g.c;
      ctx.lineWidth = 1 * dpr;
      ctx.beginPath();
      ctx.moveTo(px - L, py);
      ctx.lineTo(px + L, py);
      ctx.moveTo(px, py - L);
      ctx.lineTo(px, py + L);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // A tie in the final is settled with a +1, in plain sight.
    while (
      nudgeCursor < run.nudges.length &&
      (run.nudges[nudgeCursor]?.step ?? 0) <= i
    ) {
      const b = run.nudges[nudgeCursor++];
      if (b && dt > 0 && ripples.length < MAX_RIPPLES) {
        const r = run.r0 * Math.sqrt(2) * 2;
        ripples.push({
          x: posX[b.disc] as number,
          y: posY[b.disc] as number,
          from: r,
          to: r * 3,
          age: 0,
          life: 0.6,
          alpha: 0.7,
          gold: false,
        });
      }
    }

    function drawHunts(pairs: number[]) {
      if (!ctx) return;
      const alive = new Set<number>();
      for (let k = from; k < to; k++) alive.add(run.ids[k] as number);
      ctx.save();
      ctx.lineWidth = 1 * dpr;
      ctx.strokeStyle = 'rgba(250,250,250,.42)';
      ctx.setLineDash([3 * dpr, 4 * dpr]);
      ctx.lineDashOffset = -clock * 26 * dpr;
      ctx.beginPath();
      for (let k = 0; k + 1 < pairs.length; k += 2) {
        const a = pairs[k] as number;
        const b = pairs[k + 1] as number;
        if (!alive.has(a) || !alive.has(b)) continue;
        ctx.moveTo(ox + (posX[a] as number) * S, oy + (posY[a] as number) * S);
        ctx.lineTo(ox + (posX[b] as number) * S, oy + (posY[b] as number) * S);
      }
      ctx.stroke();
      ctx.restore();
    }
  };

  return {
    resize(cssWidth, cssHeight) {
      dpr = Math.min(2, window.devicePixelRatio || 1);
      W = canvas.width = Math.round(cssWidth * dpr);
      H = canvas.height = Math.round(cssHeight * dpr);
    },
    draw,
  };
}

/** What the show says beside the arena at a step. */
export type ArenaHud = {
  alive: number;
  leaders: { entry: number; share: number }[];
  mine: { alive: number; total: number; share: number } | null;
};

const LEADERS = 3;

/** Read the recording at a step: who holds how much of the table. */
export function arenaHud(cast: ArenaCast, step: number): ArenaHud {
  const { run, owners, me } = cast;
  const i = Math.min(Math.floor(step), run.radius.length - 1);
  const from = run.frameStart[i] as number;
  const to = run.frameStart[i + 1] as number;
  const byOwner = new Map<number, number>();
  let total = 0;
  let mineAlive = 0;
  for (let k = from; k < to; k++) {
    const owner = owners[run.ids[k] as number] as number;
    const m = run.masses[k] as number;
    total += m;
    byOwner.set(owner, (byOwner.get(owner) ?? 0) + m);
    if (owner === me) mineAlive++;
  }
  const leaders = [...byOwner.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, LEADERS)
    .map(([entry, mass]) => ({ entry, share: mass / total }));
  let mineTotal = 0;
  if (me != null) {
    for (let k = 0; k < owners.length; k++) if (owners[k] === me) mineTotal++;
  }
  return {
    alive: to - from,
    leaders,
    mine:
      me == null || mineTotal === 0
        ? null
        : {
            alive: mineAlive,
            total: mineTotal,
            share: (byOwner.get(me) ?? 0) / total,
          },
  };
}
