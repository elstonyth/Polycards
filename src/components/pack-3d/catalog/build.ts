// The 3D pack catalogue's async half: builds one bundled pack as a three.js
// model from its own front, back plate, geometry, material and ink. Import it
// dynamically (it pulls in three.js); the sync lookup is ./index.ts.
//
//   const pack = openPack3d('151', { resolution: 'half', envMap, anisotropy });
//   if (!pack) return;                       // no bundled set: flat image
//   const front = await pack.frontReady;     // decoded; { width, height, bytes }
//   const model = await pack.model();        // back face shows the front for now
//   scene.add(model);
//   await pack.showBack(details);            // plate + live text, swapped in place
//   ...
//   pack.dispose();                          // every texture, bitmap and canvas
//
// or in one call: await buildPack3d('151', { details, envMap, anisotropy }).
//
// Fronts only: until showBack() the model's back texture is a clone of the
// front texture. A clone shares the front's three.js Source, so the renderer
// keeps ONE GPU texture for both (same source, same sampling settings), and the
// side folds, where the shader blends the two faces, take the front's own rim
// colour. showBack() decodes the plate, prints the details on a canvas, then
// releases the clone's GPU binding (dispose: the shared texture stays alive for
// the front) and gives the clone a new Source holding the canvas. The renderer
// uploads it as a new texture on the next frame; the mesh and material are
// never rebuilt (createPackModel binds the texture object, not its pixels).
//
// No renderer state is made here: the caller passes the environment map, the
// anisotropy and any foil overrides (e.g. a lighter material on weak devices),
// which sit on top of the pack's own approved material. No workers, no wasm:
// pictures decode with createImageBitmap where it exists, else an <img>.

import * as THREE from 'three';
import { createPackModel, type PackModel } from '../pack-model';
import type { PackFoilSettings } from '../pack-material';
import {
  renderPackBack,
  type DrawOptions,
  type PackBackDetails,
  type PrintLayout,
} from '../pack-print';
import { packPrintSpecFromGeometry } from '../pack-print-template';
import { pack3dAssets } from './index';
import { PACK_3D_SETTINGS } from './pack-3d-settings';
import type { Pack3dAssets, Pack3dResolution } from './pack-3d-types';

/** One texture the pack holds on the GPU. */
export type Pack3dTextureInfo = {
  role: 'front' | 'back';
  url: string;
  width: number;
  height: number;
  /** RGBA8 with the full mip chain (width x height x 4 x 4/3). */
  bytes: number;
};

export type OpenPack3dOptions = {
  /** 'full' (default) or 'half' (the phone pictures). */
  resolution?: Pack3dResolution;
  /** Reflections, shared across packs; null/absent uses the scene's. */
  envMap?: THREE.Texture | null;
  /** Texture filtering quality (renderer.capabilities.getMaxAnisotropy()). */
  anisotropy?: number;
  /** Foil overrides on top of the pack's own material (e.g. a lite material). */
  foil?: Partial<PackFoilSettings>;
  /** CSS font-family for the live text; in the app, the family next/font
   *  registered for Geist (default "Geist, sans-serif"). */
  fonts?: DrawOptions['fonts'];
};

export type Pack3dBack = {
  /** The bound back texture (its image is the printed canvas). */
  texture: THREE.Texture;
  info: Pack3dTextureInfo;
  /** The live text's layout and fit report; null when nothing was printed. */
  layout: PrintLayout | null;
};

export type Pack3d = {
  readonly id: string;
  readonly resolution: Pack3dResolution;
  readonly assets: Pack3dAssets;
  /** The front decoded into a texture (not yet on the GPU). */
  readonly frontReady: Promise<Pack3dTextureInfo>;
  /** The sleeve, built once. Until showBack() its back face shows the front. */
  model(): Promise<PackModel>;
  /**
   * Decodes the back plate, prints `details` on it (null prints nothing) with
   * this pack's spec and ink, and swaps it in. Calling it again reprints.
   * Resolves null when a later call or dispose() overtook it.
   */
  showBack(details: PackBackDetails | null): Promise<Pack3dBack | null>;
  /** The GPU textures this pack holds right now (one while fronts only). */
  textures(): Pack3dTextureInfo[];
  /** Frees the geometry, the material, every texture, bitmap and canvas. */
  dispose(): void;
};

type Picture = ImageBitmap | HTMLImageElement;
type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

const gpuBytes = (w: number, h: number) => Math.round((w * h * 4 * 4) / 3);

const NO_DETAILS: PackBackDetails = {
  price: null,
  productLine: [],
  odds: null,
  buyback: null,
};

/**
 * Decodes a same-origin picture. `flipY`: three.js cannot flip an ImageBitmap
 * on upload, so a bitmap meant for a texture is decoded upside down here and
 * the texture's flipY turned off. premultiplyAlpha 'none' keeps the straight
 * alpha an <img> upload gives.
 */
async function decodePicture(url: string, flipY: boolean): Promise<Picture> {
  if (bitmapsUsable()) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`pack-3d: ${url} answered ${res.status}`);
      return await createImageBitmap(
        await res.blob(),
        flipY
          ? { imageOrientation: 'flipY', premultiplyAlpha: 'none' }
          : { premultiplyAlpha: 'none' },
      );
    } catch {
      // fall through to <img>
    }
  }
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
  await img.decode();
  return img;
}

/** createImageBitmap with working options: the same gate as three.js's
 *  GLTFLoader (Safari before 17 and Firefox before 98 ignore or reject
 *  imageOrientation / premultiplyAlpha). */
function bitmapsUsable(): boolean {
  if (typeof createImageBitmap !== 'function' || typeof fetch !== 'function')
    return false;
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  const safari = /^((?!chrome|android).)*safari/i.test(ua);
  const safariVersion = Number(/Version\/(\d+)/.exec(ua)?.[1] ?? -1);
  const firefoxVersion = Number(/Firefox\/(\d+)\./.exec(ua)?.[1] ?? -1);
  if (safari && safariVersion < 17) return false;
  if (ua.includes('Firefox') && firefoxVersion < 98) return false;
  return true;
}

const isBitmap = (p: Picture): p is ImageBitmap =>
  typeof ImageBitmap !== 'undefined' && p instanceof ImageBitmap;

function closePicture(p: Picture | null): void {
  if (p && isBitmap(p)) p.close();
}

function makeCanvas(width: number, height: number): AnyCanvas {
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    return c;
  }
  return new OffscreenCanvas(width, height);
}

function freeCanvas(c: AnyCanvas): void {
  c.width = 0;
  c.height = 0;
}

/** Waits for the weights the live text uses, in the family it draws with. */
async function loadFonts(
  weights: number[],
  fonts: DrawOptions['fonts'],
): Promise<void> {
  if (typeof document === 'undefined' || !document.fonts) return;
  const family = fonts?.sans ?? 'Geist, sans-serif';
  await Promise.all(
    [...new Set(weights.map(Math.round))].map((w) =>
      document.fonts.load(`${w} 40px ${family}`, 'RM 0.1% Pokémon'),
    ),
  );
}

/**
 * Starts one bundled pack: the front starts decoding now; nothing else is
 * fetched until model() / showBack(). Null for a pack with no bundled set.
 */
export function openPack3d(
  id: string,
  options: OpenPack3dOptions = {},
): Pack3d | null {
  const assets = pack3dAssets(id);
  const settings = PACK_3D_SETTINGS[id];
  if (!assets || !settings) return null;
  const resolution = options.resolution ?? 'full';
  const half = resolution === 'half';
  const frontUrl = half ? assets.frontHalf : assets.front;
  const backUrl = half ? assets.backHalf : assets.back;

  let disposed = false;
  let frontPicture: Picture | null = null;
  let frontTexture: THREE.Texture | null = null;
  let backTexture: THREE.Texture | null = null;
  let backCanvas: AnyCanvas | null = null;
  let backInfo: Pack3dTextureInfo | null = null;
  let built: PackModel | null = null;
  let building: Promise<PackModel> | null = null;
  let backCall = 0;

  const frontReady = (async (): Promise<Pack3dTextureInfo> => {
    const picture = await decodePicture(frontUrl, true);
    if (disposed) {
      closePicture(picture);
      throw new Error('pack-3d: disposed');
    }
    frontPicture = picture;
    const texture = new THREE.Texture(picture);
    texture.flipY = !isBitmap(picture);
    texture.name = `pack-3d-${id}-front`;
    frontTexture = texture;
    return {
      role: 'front',
      url: frontUrl,
      width: picture.width,
      height: picture.height,
      bytes: gpuBytes(picture.width, picture.height),
    };
  })();
  // a caller that never awaits it must not see an unhandled rejection
  frontReady.catch(() => {});

  const material = settings.material;
  const model = (): Promise<PackModel> => {
    building ??= frontReady.then(() => {
      if (disposed || !frontTexture) throw new Error('pack-3d: disposed');
      // fronts only: the back is the front's own texture (shared Source)
      backTexture = frontTexture.clone();
      backTexture.name = `pack-3d-${id}-back`;
      built = createPackModel({
        front: frontTexture,
        back: backTexture,
        geometry: settings.geometry,
        ...('foil' in material
          ? {
              relief: material.relief,
              foil: { ...material.foil, ...options.foil },
            }
          : { foil: options.foil }),
        envMap: options.envMap ?? null,
        anisotropy: options.anisotropy,
        disposeTextures: false,
      });
      return built;
    });
    return building;
  };

  const spec = packPrintSpecFromGeometry({
    ...settings.backGeometry,
    printInk: settings.ink,
  });

  const showBack = async (
    details: PackBackDetails | null,
  ): Promise<Pack3dBack | null> => {
    const call = ++backCall;
    const current = () => !disposed && call === backCall;
    const decoding = decodePicture(backUrl, false);
    let plate: Picture | null = null;
    const scratch: AnyCanvas[] = [];
    try {
      try {
        await model();
      } catch (e) {
        if (disposed) return null;
        throw e;
      }
      plate = await decoding;
      if (!current()) return null;
      if (details)
        await loadFonts(
          [
            spec.price.font.weight,
            spec.productLine.font.weight,
            spec.odds.font.weight,
            spec.buyback.font.weight,
          ],
          options.fonts,
        );
      if (!current()) return null;
      const { canvas, layout } = renderPackBack(
        { live: plate, noOdds: plate },
        details ?? NO_DETAILS,
        spec,
        {
          fonts: options.fonts,
          createCanvas: (w, h) => {
            const c = makeCanvas(w, h);
            scratch.push(c);
            return c;
          },
        },
      );
      const texture = backTexture;
      if (!texture) return null;
      // release the old binding (the front's shared texture, or the last
      // print), then point the same texture object at the new canvas
      texture.dispose();
      texture.source = new THREE.Source(canvas);
      texture.flipY = true;
      texture.needsUpdate = true;
      if (backCanvas) freeCanvas(backCanvas);
      backCanvas = canvas;
      backInfo = {
        role: 'back',
        url: backUrl,
        width: canvas.width,
        height: canvas.height,
        bytes: gpuBytes(canvas.width, canvas.height),
      };
      return { texture, info: backInfo, layout: details ? layout : null };
    } finally {
      // a decode still running when we leave early is closed when it lands
      if (plate) closePicture(plate);
      else decoding.then(closePicture, () => {});
      for (const c of scratch) if (c !== backCanvas) freeCanvas(c);
    }
  };

  return {
    id,
    resolution,
    assets,
    frontReady,
    model,
    showBack,
    textures() {
      // fronts only, the back shares the front's GPU texture: not counted
      return [frontInfo(), backInfo].filter(
        (t): t is Pack3dTextureInfo => t !== null,
      );
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      built?.dispose();
      frontTexture?.dispose();
      backTexture?.dispose();
      closePicture(frontPicture);
      frontPicture = null;
      if (backCanvas) freeCanvas(backCanvas);
      backCanvas = null;
      backInfo = null;
    },
  };

  function frontInfo(): Pack3dTextureInfo | null {
    const p = frontPicture;
    return p
      ? {
          role: 'front',
          url: frontUrl,
          width: p.width,
          height: p.height,
          bytes: gpuBytes(p.width, p.height),
        }
      : null;
  }
}

/**
 * One call: opens the pack, builds the model and, when `details` is given
 * (null = the plate without live text), prints and shows the back. Null for a
 * pack with no bundled set.
 */
export async function buildPack3d(
  id: string,
  options: OpenPack3dOptions & { details?: PackBackDetails | null } = {},
): Promise<Pack3d | null> {
  const pack = openPack3d(id, options);
  if (!pack) return null;
  try {
    await pack.model();
    if (options.details !== undefined) await pack.showBack(options.details);
    return pack;
  } catch (e) {
    pack.dispose();
    throw e;
  }
}
