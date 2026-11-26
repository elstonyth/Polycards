/** The three live 3D icons (models: scripts/build-holo-icons.py). */
export type HoloKind = 'crown' | 'gift' | 'vault';

/** How long a tap's play runs, in seconds. */
export const PLAY_SECONDS: Record<HoloKind, number> = {
  crown: 1.1,
  gift: 1.9,
  vault: 2.8,
};

/**
 * Where the moving parts are during a tap's play. Every field is 0 at rest;
 * `lid`, `door` and `glow` run 0..1, `hop` 0..1, `turn` and `wheel` are
 * radians.
 */
export type HoloPose = {
  turn: number;
  hop: number;
  lid: number;
  wheel: number;
  door: number;
  glow: number;
};

const REST: HoloPose = { turn: 0, hop: 0, lid: 0, wheel: 0, door: 0, glow: 0 };

/** The vault wheel has six spokes, so 1.5 turns lands on the look it left. */
const WHEEL_TURNS = 1.5;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
/** 0..1 across [a, b]. */
const span = (p: number, a: number, b: number) => clamp01((p - a) / (b - a));
const easeOut = (v: number) => 1 - (1 - v) ** 3;
const easeInOut = (v: number) =>
  v < 0.5 ? 4 * v ** 3 : 1 - (-2 * v + 2) ** 3 / 2;

/**
 * The pose `p` of the way (0..1) through a tap's play: the crown turns once
 * with a hop, the gift's lid pops and settles, the vault's wheel turns and
 * then its door swings open and shut. Rest at both ends, so a play joins the
 * idle motion without a jump.
 */
export function actionPose(kind: HoloKind, p: number): HoloPose {
  if (!(p > 0 && p < 1)) return REST;
  const arc = Math.sin(Math.PI * p);
  if (kind === 'crown')
    return { ...REST, turn: easeInOut(p) * Math.PI * 2, hop: arc, glow: arc };
  // Opens over [a, b], shuts over [c, 1].
  const open = (a: number, b: number, c: number) =>
    easeOut(span(p, a, b)) - easeInOut(span(p, c, 1));
  if (kind === 'gift') {
    const lid = open(0, 0.22, 0.72);
    return { ...REST, lid, glow: lid };
  }
  const door = open(0.3, 0.55, 0.8);
  return {
    ...REST,
    wheel: easeInOut(span(p, 0, 0.34)) * WHEEL_TURNS * Math.PI * 2,
    door,
    glow: door,
  };
}
