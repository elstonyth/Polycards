// Types of the 3D capsule packs (type-only: no three.js at runtime).

export type Capsule3dResolution = 'full' | 'half';

/** One texture file: URL (with ?v=content hash) and pixel size. */
export type Capsule3dTexture = {
  url: string;
  width: number;
  height: number;
};

/** A capsule's own textures at one resolution. */
export type Capsule3dTextureSet = {
  /** The cap's material capture, sampled from the picture's cap (sRGB). */
  capMatcap: Capsule3dTexture;
  /** The live glass layer: straight colour (sRGB) + opacity. */
  glassMatcap: Capsule3dTexture;
  /** The logo ink by normal (sRGB) + its raised edge's specular strength (alpha). */
  logoMatcap: Capsule3dTexture;
  /** The picture's glass half (the ticket contents), cropped. */
  contents: Capsule3dTexture;
  /** Glitter caps only: the stones as an albedo ratio, sRGB(ratio / 4), cropped. */
  detail?: Capsule3dTexture;
};

/**
 * The capsule and camera fitted to the approved picture, in capsule-radius
 * units: the picture's camera has vertical field of view F (degrees) and sits
 * at the origin looking down -z; the capsule's centre is at (tx, ty, -D), its
 * axis tilted back by elev and rolled by roll (degrees, three.js Euler 'ZXY'
 * (-elev, 0, roll)). HC: half the cylinder's length; SEAM: the cap / glass
 * join's height on the axis.
 */
export type Capsule3dFit = {
  F: number;
  elev: number;
  roll: number;
  D: number;
  tx: number;
  ty: number;
  HC: number;
  SEAM: number;
};

/**
 * One logo block placed on the cap: the block's anchor lands at azimuth phi0
 * (radians from the cap's front meridian toward +x) and meridian position m0,
 * at k capsule radii per logo viewBox unit. `inflate` (viewBox units) grows
 * the outline along its distance field: each picture's raised logo is bolder
 * than the site's vector paths, by an amount fitted per tier and block.
 */
export type Capsule3dLogoPlace = {
  k: number;
  phi0: number;
  m0: number;
  inflate: number;
};

export type Capsule3dAssets = {
  tier: string;
  /** The approved picture's pixel size (the model frames like it). */
  picture: { width: number; height: number };
  fit: Capsule3dFit;
  logo: {
    /** The picture's logo ink. */
    ink: 'dark' | 'white';
    mark: Capsule3dLogoPlace;
    word: Capsule3dLogoPlace;
  };
  /** 'glitter': the cap carries a surface detail texture (Diamond). */
  cap: 'metal' | 'glitter';
  /** Where the contents crop sits in the picture: [x0, y0, w, h], 0..1, y from the top. */
  contentsRect: readonly number[];
  /** Where the detail crop sits in the picture (glitter caps only). */
  detailRect: readonly number[] | null;
  files: Record<Capsule3dResolution, Capsule3dTextureSet>;
};

/** One logo block in the shared distance-field atlas. */
export type Capsule3dLogoBlock = {
  /** The block's box in logo viewBox units (y down). */
  box: { x0: number; y0: number; x1: number; y1: number };
  /** The anchor (viewBox units) a placement puts at (phi0, m0). */
  cx: number;
  cy: number;
};

/** The shared logo mask: a signed distance field of the vector logo. */
export type Capsule3dLogoAtlas = {
  /** viewBox units encoded each side of 0.5 (value = 0.5 + d / (2 range)). */
  range: number;
  blocks: { mark: Capsule3dLogoBlock; word: Capsule3dLogoBlock };
  files: Record<
    Capsule3dResolution,
    Capsule3dTexture & {
      /** Each block's rect in the atlas: [u0, v0, du, dv], 0..1, v from the top. */
      rects: { mark: readonly number[]; word: readonly number[] };
    }
  >;
};
