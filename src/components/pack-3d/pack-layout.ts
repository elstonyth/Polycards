// Every layout number the 3D pack uses, in one place. A pack's numbers come
// from its geometry file (the shape of
// docs/research/home-3d/pack-back/151-back-geometry.json): fractions of the art,
// measured on the BACK art with y down from the top. `toPackLayout` turns them
// into the front art's frame once, so nothing else has to think about mirroring.
//
// The 3D sleeve is one pack height tall (1 scene unit); the art's aspect sets
// its width. Thickness numbers below are in pack heights too.

/** One periodic run of painted ridges along one axis of the art. */
export type PackRidgeRun = {
  /** Where the ridges start and stop along their axis (fractions). */
  from: number;
  to: number;
  /** Distance between crests, and the position of one crest (fractions). */
  pitch: number;
  crest: number;
};

/** The layout file's shape. Fractions of the image, BACK art, y down. */
export type PackGeometry = {
  pack?: string;
  image: { width: number; height: number };
  /** Alpha (0..255) where the art's outline sits. */
  alphaThreshold: number;
  bounds: { x0: number; x1: number; y0: number; y1: number };
  /** Straight side edges between the shoulders. */
  body: { x0: number; x1: number };
  crimpTop: { y0: number; y1: number };
  crimpBottom: { y0: number; y1: number };
  /** The fin seal band down the back. */
  finSeal: { x0: number; x1: number };
  printArea?: { x0: number; x1: number; y0: number; y1: number };
  /**
   * Measured from the art by `measurePackArt` (pack-measure.ts), same frame as
   * the rest: the outline as [y, left, right] knots, and the painted ridges.
   * Optional: without them the model falls back to a drawn outline and no
   * ridge relief.
   */
  outline?: ReadonlyArray<readonly [number, number, number]>;
  /** Top and bottom edges of the opaque art (sub-pixel), y fractions. */
  edges?: { top: number; bottom: number };
  ridges?: {
    top?: PackRidgeRun;
    bottom?: PackRidgeRun;
    /** Along x, on the back art. */
    fin?: PackRidgeRun;
  };
};

export type PackOutlineKnot = { y: number; x0: number; x1: number };

/** The layout in the FRONT art's frame: x = front u (0 left), y down. */
export type PackLayout = {
  /** Image width over height. */
  aspect: number;
  /** One texel, as a fraction of width and of height. */
  texel: { x: number; y: number };
  /** The sealed top and bottom edges. */
  top: number;
  bottom: number;
  crimpTop: { y0: number; y1: number };
  crimpBottom: { y0: number; y1: number };
  body: { x0: number; x1: number };
  /** The back's fin seal band, in front u. */
  fin: { x0: number; x1: number };
  /** Opaque span of the art per row, sorted by y. */
  outline: readonly PackOutlineKnot[];
  /** Painted ridges: crimps along y, fin along front u. */
  ridges: {
    top: PackRidgeRun | null;
    bottom: PackRidgeRun | null;
    fin: PackRidgeRun | null;
  };
};

/**
 * The sleeve's physical shape, in pack heights. A real booster is about
 * 135 x 73 mm and 4 to 5 mm through the belly; the crimped seals are two foil
 * layers pressed flat.
 */
export const PACK_PROPORTIONS = {
  /** Half the sleeve's depth at the middle of the belly. */
  bellyHalf: 0.0155,
  /** Half the depth of a crimped seal (two foil layers). */
  sealHalf: 0.0006,
  /** How far below the crimp the sleeve reaches its full depth. */
  shoulder: 0.09,
  /** The side folds' width, as a share of the local half depth. */
  foldRatio: 0.9,
  /** Depth lost toward the sides (across) and toward the ends (along). */
  crownAcross: 0.22,
  crownAlong: 0.1,
  /** The fin seal stands this far proud of the back, with soft edges. */
  finRaise: 0.0016,
  finEdge: 0.005,
  /** Share of the fin's raise kept where it runs flat through the crimps. */
  finInCrimp: 0.35,
} as const;

export type PackProportions = { [K in keyof typeof PACK_PROPORTIONS]: number };

/**
 * How strongly the normal relief tilts the light on the painted ridges: the
 * steepest slope (rise over run) of the crimp ridges and of the fin's ridges.
 * Gentle on purpose; the ridges are already painted.
 */
export const PACK_RELIEF = {
  crimpSlope: 0.45,
  finSlope: 0.3,
} as const;

export type PackRelief = { [K in keyof typeof PACK_RELIEF]: number };

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

/** Back-art x to front-art x: the back is the front mirrored left to right. */
const mirrorX = (x: number): number => 1 - x;

function mirrorRun(run: PackRidgeRun | undefined): PackRidgeRun | null {
  if (!run) return null;
  return {
    from: mirrorX(run.to),
    to: mirrorX(run.from),
    pitch: run.pitch,
    crest: mirrorX(run.crest),
  };
}

/**
 * A drawn outline for packs without a measured one: full width through the
 * crimps, easing in to the straight body edges over the shoulders.
 */
function drawnOutline(geometry: PackGeometry): PackOutlineKnot[] {
  const { bounds, crimpTop, crimpBottom } = geometry;
  const body = { x0: mirrorX(geometry.body.x1), x1: mirrorX(geometry.body.x0) };
  const full = { x0: mirrorX(bounds.x1), x1: mirrorX(bounds.x0) };
  const reach = 0.065;
  const knots: PackOutlineKnot[] = [];
  const at = (y: number, k: number) =>
    knots.push({
      y,
      x0: full.x0 + (body.x0 - full.x0) * k,
      x1: full.x1 + (body.x1 - full.x1) * k,
    });
  at(bounds.y0, 0);
  for (let i = 0; i <= 8; i++) {
    const t = i / 8;
    at(crimpTop.y1 + reach * t, 1 - (1 - t) ** 2);
  }
  for (let i = 8; i >= 0; i--) {
    const t = i / 8;
    at(crimpBottom.y0 - reach * t, 1 - (1 - t) ** 2);
  }
  at(bounds.y1, 0);
  return knots;
}

/** The layout file in the front art's frame. Throws on numbers out of range. */
export function toPackLayout(geometry: PackGeometry): PackLayout {
  const { image, crimpTop, crimpBottom } = geometry;
  if (!(image.width > 0 && image.height > 0))
    throw new Error('Pack geometry needs the image size.');
  if (
    !(crimpTop.y1 > crimpTop.y0 && crimpBottom.y0 > crimpTop.y1) ||
    !(crimpBottom.y1 > crimpBottom.y0)
  )
    throw new Error('Pack geometry crimps are out of order.');
  const outline = geometry.outline
    ? geometry.outline
        .map(([y, left, right]) => ({
          y,
          x0: mirrorX(right),
          x1: mirrorX(left),
        }))
        .sort((a, b) => a.y - b.y)
    : drawnOutline(geometry);
  const top = geometry.edges?.top ?? geometry.bounds.y0;
  const bottom = geometry.edges?.bottom ?? geometry.bounds.y1;
  return {
    aspect: image.width / image.height,
    texel: { x: 1 / image.width, y: 1 / image.height },
    top,
    bottom,
    crimpTop: { ...crimpTop },
    crimpBottom: { ...crimpBottom },
    body: { x0: mirrorX(geometry.body.x1), x1: mirrorX(geometry.body.x0) },
    fin: { x0: mirrorX(geometry.finSeal.x1), x1: mirrorX(geometry.finSeal.x0) },
    outline,
    ridges: {
      top: geometry.ridges?.top ?? null,
      bottom: geometry.ridges?.bottom ?? null,
      fin: mirrorRun(geometry.ridges?.fin),
    },
  };
}

/** The opaque span of the art at height `y` (front u). */
export function outlineAt(
  layout: PackLayout,
  y: number,
): { x0: number; x1: number } {
  const knots = layout.outline;
  const first = knots[0];
  const last = knots[knots.length - 1];
  if (!first || !last) return { ...layout.body };
  if (y <= first.y) return { x0: first.x0, x1: first.x1 };
  if (y >= last.y) return { x0: last.x0, x1: last.x1 };
  let lo = 0;
  let hi = knots.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((knots[mid] as PackOutlineKnot).y <= y) lo = mid;
    else hi = mid;
  }
  const a = knots[lo] as PackOutlineKnot;
  const b = knots[hi] as PackOutlineKnot;
  const k = b.y > a.y ? (y - a.y) / (b.y - a.y) : 0;
  return { x0: a.x0 + (b.x0 - a.x0) * k, x1: a.x1 + (b.x1 - a.x1) * k };
}

/**
 * 0 on the crimped seals, rising to 1 a `shoulder` below them: how far the
 * sleeve has puffed out at height `y`. Steep near the seal, like foil
 * pulled over the cards.
 */
export function puff(
  layout: PackLayout,
  y: number,
  shape: PackProportions = PACK_PROPORTIONS,
): number {
  const fromSeal = Math.min(y - layout.crimpTop.y1, layout.crimpBottom.y0 - y);
  const t = clamp01(fromSeal / shape.shoulder);
  return 1 - (1 - t) ** 3;
}

/**
 * Ramps from 0 on the sealed top and bottom edges to 1 a hair inside them, so
 * the front and back faces meet in a single line there.
 */
export function sealRamp(layout: PackLayout, y: number): number {
  const reach = 0.0025;
  return clamp01(Math.min(y - layout.top, layout.bottom - y) / reach);
}

/** Half the sleeve's depth down its centre line at height `y`. */
export function halfDepth(
  layout: PackLayout,
  y: number,
  shape: PackProportions = PACK_PROPORTIONS,
): number {
  const middle = (layout.top + layout.bottom) / 2;
  const half = (layout.bottom - layout.top) / 2;
  const along = 1 - shape.crownAlong * ((y - middle) / half) ** 2;
  const belly = shape.bellyHalf * along;
  return (
    sealRamp(layout, y) *
    (shape.sealHalf + (belly - shape.sealHalf) * puff(layout, y, shape))
  );
}

/** How far the fin seal stands proud of the back at (front u, y). */
export function finRaise(
  layout: PackLayout,
  u: number,
  y: number,
  shape: PackProportions = PACK_PROPORTIONS,
): number {
  const e = shape.finEdge;
  const step = (a: number, b: number, x: number) => {
    const t = clamp01((x - a) / (b - a));
    return t * t * (3 - 2 * t);
  };
  const across =
    step(layout.fin.x0 - e, layout.fin.x0 + e, u) *
    (1 - step(layout.fin.x1 - e, layout.fin.x1 + e, u));
  const keep =
    shape.finInCrimp + (1 - shape.finInCrimp) * puff(layout, y, shape);
  return shape.finRaise * across * keep * sealRamp(layout, y);
}
