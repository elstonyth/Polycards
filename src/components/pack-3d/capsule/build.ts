// The 3D capsule packs' async half: builds one capsule as a three.js model from
// its own textures (all sampled from the tier's approved picture) and the
// numbers fitted to that picture. Import it dynamically (it pulls in three.js);
// the sync lookup is ./index.ts.
//
//   const capsule = openCapsule3d('gold-capsule', { resolution: 'half', anisotropy });
//   if (!capsule) return;                    // no 3D model: flat image
//   await capsule.ready;                     // every texture decoded
//   const model = await capsule.model();     // THREE.Group, built once
//   scene.add(model);
//   model.lean(12, -4);                      // small leans only (degrees)
//   ...
//   capsule.dispose();                       // geometry, materials, textures
//
// The model frames like the approved picture: picture height = 1 model unit
// at the model's origin, so a camera with fov model.restView.fov at
// model.restView.distance down the model's +z sees exactly the picture's pose.
// Leans turn the capsule about its own centre, about the screen's vertical
// (yaw) and horizontal (pitch) axes; the capsule never turns to its back.
//
// Three draw calls: the cap (with the logo drawn in its shader: no logo
// geometry), the contents and the live glass. The logo's distance-field mask
// is shared by every open capsule of the same resolution (reference counted).
// No renderer state is made here and no environment map is used. No workers,
// no wasm: pictures decode with createImageBitmap where it works, else <img>.

import * as THREE from 'three';
import { CAPSULE_LOGO_ATLAS } from './capsule-manifest';
import {
  CAPSULE_DETAIL,
  CONTENTS_RADIUS,
  capsuleShapes,
  shapeBytes,
  type LatheArrays,
} from './capsule-geometry';
import {
  CAP_FRAGMENT,
  CAP_VERTEX,
  CONTENTS_FRAGMENT,
  CONTENTS_VERTEX,
  GLASS_FRAGMENT,
  GLASS_VERTEX,
} from './capsule-shaders';
import type {
  Capsule3dAssets,
  Capsule3dResolution,
  Capsule3dTexture,
} from './capsule-types';
import { capsule3dAssets } from './index';

export type Capsule3dTextureRole =
  'cap' | 'glass' | 'logo-ink' | 'contents' | 'detail' | 'logo-mask';

/** One texture a capsule holds on the GPU. */
export type Capsule3dTextureInfo = {
  role: Capsule3dTextureRole;
  url: string;
  width: number;
  height: number;
  /** RGBA8, with the mip chain (x 4/3) where the texture has one. */
  bytes: number;
  /** The logo mask is shared by every open capsule of this resolution. */
  shared: boolean;
};

/** The logo's raised-edge look and the contents' far side (defaults per ink). */
export type Capsule3dLook = {
  /** Raised edge width, capsule radii. */
  bevel: number;
  /** Raised edge height / width (how far the edge bends the normal). */
  relief: number;
  edgeShade: number;
  spec: number;
  /** Soft contact shade round the logo, strength and width (capsule radii). */
  ao: number;
  aoWidth: number;
  /** Glitter: half-width (deg) of the front band whose stones fill the
   *  grazing bands while leaning. */
  bandDeg: number;
};

const LOOK: Record<'dark' | 'white', Capsule3dLook> = {
  dark: {
    bevel: 0.009,
    relief: 0.7,
    edgeShade: 0.5,
    spec: 0.9,
    ao: 0.1,
    aoWidth: 0.012,
    bandDeg: 35,
  },
  white: {
    bevel: 0.009,
    relief: 1.1,
    edgeShade: 0.8,
    spec: 0.25,
    ao: 0.3,
    aoWidth: 0.014,
    bandDeg: 35,
  },
};

export type OpenCapsule3dOptions = {
  /** 'full' (default) or 'half' (the phone textures). */
  resolution?: Capsule3dResolution;
  /** Texture filtering quality (renderer.capabilities.getMaxAnisotropy()). */
  anisotropy?: number;
  /** Overrides on the logo / glitter look. */
  look?: Partial<Capsule3dLook>;
};

export type Capsule3dStats = {
  drawCalls: number;
  triangles: number;
  vertices: number;
  /** Positions + 16-bit indices. */
  geometryBytes: number;
  /** This capsule's own textures. */
  textureBytes: number;
  /** The shared logo mask (once for all open capsules of a resolution). */
  sharedTextureBytes: number;
  /** geometry + own textures (+ the shared mask, counted in full). */
  gpuBytes: number;
};

export type Capsule3dModel = THREE.Group & {
  /** Turns about the capsule's centre (lean() sets it). Not called `pivot`:
   *  three.js r187 has its own Object3D.pivot (a Vector3). */
  readonly leanGroup: THREE.Group;
  /** The rest pose (the picture's) and capsule-radius scale. */
  readonly rig: THREE.Group;
  readonly meshes: {
    cap: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
    contents: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
    glass: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  };
  /** A camera with this vertical fov (deg) at this distance down +z, aspect
   *  as the picture, frames the model exactly as the approved picture. */
  readonly restView: { fov: number; distance: number; aspect: number };
  /** Leans away from the picture's pose (degrees): yaw about the screen's
   *  vertical, pitch about its horizontal. lean(0, 0) is the picture. */
  lean(yawDeg: number, pitchDeg: number): void;
  /** 0..1, for fades (1 draws exactly as opaque). */
  setOpacity(opacity: number): void;
  /** Frees the geometry and materials (textures belong to the handle). */
  dispose(): void;
};

export type Capsule3d = {
  readonly id: string;
  readonly resolution: Capsule3dResolution;
  readonly assets: Capsule3dAssets;
  /** Every texture decoded (not yet on the GPU). */
  readonly ready: Promise<Capsule3dTextureInfo[]>;
  /** The model, built once. */
  model(): Promise<Capsule3dModel>;
  /** The textures this capsule holds (own + the shared logo mask). */
  textures(): Capsule3dTextureInfo[];
  /** Draw calls, triangles and byte counts (geometry counted once built). */
  stats(): Capsule3dStats;
  /** Frees the geometry, materials, own textures and bitmaps; releases the
   *  shared logo mask. */
  dispose(): void;
};

type Picture = ImageBitmap | HTMLImageElement;

const DEG = Math.PI / 180;
const gpuBytes = (w: number, h: number, mips: boolean) =>
  Math.round(w * h * 4 * (mips ? 4 / 3 : 1));

/** createImageBitmap with working options (the catalogue's gate, from
 *  three.js GLTFLoader: Safari before 17 and Firefox before 98 ignore or
 *  reject imageOrientation / premultiplyAlpha). */
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

/** Decodes a same-origin picture, flipped for upload (straight alpha). */
async function decodePicture(url: string): Promise<Picture> {
  if (bitmapsUsable()) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`capsule-3d: ${url} answered ${res.status}`);
      return await createImageBitmap(await res.blob(), {
        imageOrientation: 'flipY',
        premultiplyAlpha: 'none',
      });
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

function closePicture(p: Picture | null): void {
  if (p && isBitmap(p)) p.close();
}

type TextureSpec = {
  srgb: boolean;
  mips: boolean;
  anisotropy?: number;
};

function makeTexture(
  picture: Picture,
  name: string,
  spec: TextureSpec,
): THREE.Texture {
  const t = new THREE.Texture(picture);
  t.name = name;
  t.flipY = !isBitmap(picture);
  t.colorSpace = spec.srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.generateMipmaps = spec.mips;
  t.minFilter = spec.mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  if (spec.mips && spec.anisotropy) t.anisotropy = spec.anisotropy;
  t.needsUpdate = true;
  return t;
}

// ------------------------------------------------------------- shared logo mask
type SharedLogo = {
  refs: number;
  picture: Picture | null;
  texture: THREE.Texture | null;
  ready: Promise<THREE.Texture>;
};
const sharedLogo: Partial<Record<Capsule3dResolution, SharedLogo>> = {};

function acquireLogo(res: Capsule3dResolution): Promise<THREE.Texture> {
  let s = sharedLogo[res];
  if (!s) {
    const entry: SharedLogo = {
      refs: 0,
      picture: null,
      texture: null,
      ready: null!,
    };
    entry.ready = decodePicture(CAPSULE_LOGO_ATLAS.files[res].url).then((p) => {
      entry.picture = p;
      entry.texture = makeTexture(p, `capsule-logo-mask-${res}`, {
        srgb: false,
        mips: true,
      });
      return entry.texture;
    });
    entry.ready.catch(() => {});
    sharedLogo[res] = entry;
    s = entry;
  }
  s.refs++;
  return s.ready;
}

function releaseLogo(res: Capsule3dResolution): void {
  const s = sharedLogo[res];
  if (!s) return;
  s.refs--;
  if (s.refs > 0) return;
  delete sharedLogo[res];
  s.texture?.dispose();
  closePicture(s.picture);
  // a decode still running is freed (texture and bitmap) when it lands
  if (!s.texture)
    s.ready.then(
      (t) => {
        t.dispose();
        closePicture(s.picture);
      },
      () => {},
    );
}

/** Bytes of the shared logo mask at a resolution. */
export function capsuleLogoBytes(res: Capsule3dResolution): number {
  const f = CAPSULE_LOGO_ATLAS.files[res];
  return gpuBytes(f.width, f.height, true);
}

// ------------------------------------------------------------- the rest pose
/** The picture's camera and the capsule's rest placement, in capsule radii. */
export function capsuleRest(assets: Capsule3dAssets) {
  const { fit, picture } = assets;
  const aspect = picture.width / picture.height;
  const quaternion = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(-fit.elev * DEG, 0, fit.roll * DEG, 'ZXY'),
  );
  const world = new THREE.Matrix4().compose(
    new THREE.Vector3(fit.tx, fit.ty, -fit.D),
    quaternion,
    new THREE.Vector3(1, 1, 1),
  );
  const proj = new THREE.PerspectiveCamera(fit.F, aspect, 0.1, 100);
  proj.updateProjectionMatrix();
  const mvp = proj.projectionMatrix.clone().multiply(world);
  const camLocal = new THREE.Vector3(0, 0, 0).applyMatrix4(
    world.clone().invert(),
  );
  // model units: the picture's height at the capsule's depth = 1
  const scale = 1 / (2 * fit.D * Math.tan((fit.F * DEG) / 2));
  return { aspect, quaternion, mvp, camLocal, scale };
}

function geometryOf(l: LatheArrays): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(l.positions, 3));
  g.setIndex(new THREE.BufferAttribute(l.index, 1));
  g.computeBoundingSphere();
  return g;
}

const rectV4 = (r: readonly number[]) =>
  new THREE.Vector4(r[0] ?? 0, r[1] ?? 0, r[2] ?? 1, r[3] ?? 1);

// ------------------------------------------------------------- open
/**
 * Starts one capsule: every texture starts decoding now; the model is built on
 * the first model() call. Null for a pack with no 3D capsule.
 */
export function openCapsule3d(
  id: string,
  options: OpenCapsule3dOptions = {},
): Capsule3d | null {
  const assets = capsule3dAssets(id);
  if (!assets) return null;
  const resolution: Capsule3dResolution = options.resolution ?? 'full';
  const set = assets.files[resolution];
  const look = { ...LOOK[assets.logo.ink], ...options.look };
  const anisotropy = options.anisotropy ?? 8;

  let disposed = false;
  let logoHeld = true;
  const pictures: Picture[] = [];
  const own: {
    role: Capsule3dTextureRole;
    file: Capsule3dTexture;
    texture: THREE.Texture;
    mips: boolean;
  }[] = [];
  let logoTexture: THREE.Texture | null = null;
  let built: Capsule3dModel | null = null;
  let building: Promise<Capsule3dModel> | null = null;
  let geometryBytes = 0,
    triangles = 0,
    vertices = 0;

  const ownSpecs: [
    Capsule3dTextureRole,
    Capsule3dTexture | undefined,
    TextureSpec,
  ][] = [
    ['cap', set.capMatcap, { srgb: true, mips: false }],
    ['glass', set.glassMatcap, { srgb: true, mips: false }],
    ['logo-ink', set.logoMatcap, { srgb: true, mips: false }],
    ['contents', set.contents, { srgb: true, mips: true, anisotropy }],
    ['detail', set.detail, { srgb: true, mips: true, anisotropy }],
  ];

  const logoReady = acquireLogo(resolution);
  const ready = (async (): Promise<Capsule3dTextureInfo[]> => {
    const loads = ownSpecs
      .filter(([, file]) => file)
      .map(async ([role, file, spec]) => {
        const p = await decodePicture(file!.url);
        if (disposed) {
          closePicture(p);
          throw new Error('capsule-3d: disposed');
        }
        pictures.push(p);
        own.push({
          role,
          file: file!,
          texture: makeTexture(p, `capsule-${id}-${role}`, spec),
          mips: spec.mips,
        });
      });
    const [logo] = await Promise.all([logoReady, ...loads]);
    if (disposed) throw new Error('capsule-3d: disposed');
    logoTexture = logo;
    return textures();
  })();
  ready.catch(() => {});

  const tex = (role: Capsule3dTextureRole) =>
    own.find((o) => o.role === role)?.texture ?? null;

  function textures(): Capsule3dTextureInfo[] {
    const list: Capsule3dTextureInfo[] = own.map((o) => ({
      role: o.role,
      url: o.file.url,
      width: o.file.width,
      height: o.file.height,
      bytes: gpuBytes(o.file.width, o.file.height, o.mips),
      shared: false,
    }));
    if (logoTexture) {
      const f = CAPSULE_LOGO_ATLAS.files[resolution];
      list.push({
        role: 'logo-mask',
        url: f.url,
        width: f.width,
        height: f.height,
        bytes: capsuleLogoBytes(resolution),
        shared: true,
      });
    }
    return list;
  }

  const buildModel = (): Capsule3dModel => {
    const { fit } = assets;
    const rest = capsuleRest(assets);
    const shapes = capsuleShapes(
      { HC: fit.HC, SEAM: fit.SEAM },
      CAPSULE_DETAIL,
    );
    geometryBytes = shapeBytes(shapes);
    triangles =
      shapes.cap.triangles + shapes.glass.triangles + shapes.contents.triangles;
    vertices =
      shapes.cap.vertices + shapes.glass.vertices + shapes.contents.vertices;
    const atlas = CAPSULE_LOGO_ATLAS;
    const atlasFile = atlas.files[resolution];
    const ppu =
      (atlasFile.rects.word[2]! * atlasFile.width) /
      (atlas.blocks.word.box.x1 - atlas.blocks.word.box.x0);
    const box = (b: 'mark' | 'word') => {
      const B = atlas.blocks[b].box;
      return new THREE.Vector4(B.x0, B.y0, B.x1, B.y1);
    };
    const place = (b: 'mark' | 'word') => {
      const p = assets.logo[b];
      return new THREE.Vector4(p.k, p.phi0, p.m0, p.inflate);
    };
    const opacity = { value: 1 };
    const lean = { value: new THREE.Vector2(0, 0) };
    const glitter = assets.cap === 'glitter' && !!tex('detail');
    const capMat = new THREE.ShaderMaterial({
      name: `capsule-${id}-cap`,
      vertexShader: CAP_VERTEX,
      fragmentShader: CAP_FRAGMENT,
      defines: glitter ? { USE_DETAIL: '' } : {},
      uniforms: {
        uHC: { value: fit.HC },
        uMatcap: { value: tex('cap') },
        uLogoMatcap: { value: tex('logo-ink') },
        uLogoSdf: { value: logoTexture },
        uMark: { value: place('mark') },
        uWord: { value: place('word') },
        uMarkBox: { value: box('mark') },
        uWordBox: { value: box('word') },
        uMarkAnchor: {
          value: new THREE.Vector2(atlas.blocks.mark.cx, atlas.blocks.mark.cy),
        },
        uWordAnchor: {
          value: new THREE.Vector2(atlas.blocks.word.cx, atlas.blocks.word.cy),
        },
        uMarkRect: { value: rectV4(atlasFile.rects.mark) },
        uWordRect: { value: rectV4(atlasFile.rects.word) },
        uSdfTexel: {
          value: new THREE.Vector2(1 / atlasFile.width, 1 / atlasFile.height),
        },
        uSdfPpu: { value: ppu },
        uSdfRange: { value: atlas.range },
        uBevel: { value: look.bevel },
        uRelief: { value: look.relief },
        uEdgeShade: { value: look.edgeShade },
        uSpec: { value: look.spec },
        uAO: { value: look.ao },
        uAOWidth: { value: look.aoWidth },
        uOpacity: opacity,
        uRestMVP: { value: rest.mvp },
        uPhiC: { value: Math.atan2(rest.camLocal.x, rest.camLocal.z) },
        uBand: { value: look.bandDeg * DEG },
        uCamLocal: { value: rest.camLocal },
        uDetail: { value: tex('detail') },
        uDetailRect: { value: rectV4(assets.detailRect ?? [0, 0, 1, 1]) },
        uDetailSize: {
          value: new THREE.Vector2(
            set.detail?.width ?? 1,
            set.detail?.height ?? 1,
          ),
        },
        uLean: lean,
      },
      toneMapped: false,
    });
    const contentsMat = new THREE.ShaderMaterial({
      name: `capsule-${id}-contents`,
      vertexShader: CONTENTS_VERTEX,
      fragmentShader: CONTENTS_FRAGMENT,
      uniforms: {
        uMap: { value: tex('contents') },
        uRect: { value: rectV4(assets.contentsRect) },
        uRestMVP: { value: rest.mvp },
        uCamLocal: { value: rest.camLocal },
        uRi: { value: CONTENTS_RADIUS },
        uHC: { value: fit.HC },
        uYmin: { value: -fit.HC - 0.55 },
        uYmax: { value: fit.SEAM - 0.1 },
        uShift: { value: 0.62 },
        uBackDim: { value: 0.85 },
        uOpacity: opacity,
      },
      toneMapped: false,
    });
    const glassMat = new THREE.ShaderMaterial({
      name: `capsule-${id}-glass`,
      vertexShader: GLASS_VERTEX,
      fragmentShader: GLASS_FRAGMENT,
      uniforms: {
        uHC: { value: fit.HC },
        uMatcap: { value: tex('glass') },
        uOpacity: opacity,
      },
      transparent: true,
      depthWrite: false,
      toneMapped: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
    const cap = new THREE.Mesh(geometryOf(shapes.cap), capMat);
    cap.name = 'capsule-cap';
    const contents = new THREE.Mesh(geometryOf(shapes.contents), contentsMat);
    contents.name = 'capsule-contents';
    const glass = new THREE.Mesh(geometryOf(shapes.glass), glassMat);
    glass.name = 'capsule-glass';
    glass.renderOrder = 2;

    const rig = new THREE.Group();
    rig.name = 'capsule-rig';
    rig.quaternion.copy(rest.quaternion);
    rig.scale.setScalar(rest.scale);
    rig.add(cap, contents, glass);
    const leanGroup = new THREE.Group();
    leanGroup.name = 'capsule-lean';
    leanGroup.position.set(fit.tx * rest.scale, fit.ty * rest.scale, 0);
    leanGroup.add(rig);
    const group = new THREE.Group() as Capsule3dModel;
    group.name = `capsule-${id}`;
    group.add(leanGroup);
    const euler = new THREE.Euler(0, 0, 0, 'YXZ');
    Object.assign(group, {
      leanGroup,
      rig,
      meshes: { cap, contents, glass },
      restView: {
        fov: fit.F,
        distance: fit.D * rest.scale,
        aspect: rest.aspect,
      },
      lean(yawDeg: number, pitchDeg: number) {
        euler.set(pitchDeg * DEG, yawDeg * DEG, 0, 'YXZ');
        leanGroup.quaternion.setFromEuler(euler);
        lean.value.set(yawDeg * DEG, pitchDeg * DEG);
      },
      setOpacity(o: number) {
        const v = Math.max(0, Math.min(1, o));
        opacity.value = v;
        capMat.transparent = v < 1;
        contentsMat.transparent = v < 1;
      },
      dispose() {
        for (const m of [cap, contents, glass]) {
          m.geometry.dispose();
          m.material.dispose();
        }
      },
    });
    return group;
  };

  const model = (): Promise<Capsule3dModel> => {
    building ??= ready.then(() => {
      if (disposed) throw new Error('capsule-3d: disposed');
      built = buildModel();
      return built;
    });
    return building;
  };

  return {
    id,
    resolution,
    assets,
    ready,
    model,
    textures,
    stats() {
      const t = textures();
      const textureBytes = t
        .filter((x) => !x.shared)
        .reduce((s, x) => s + x.bytes, 0);
      const sharedTextureBytes = capsuleLogoBytes(resolution);
      return {
        drawCalls: 3,
        triangles,
        vertices,
        geometryBytes,
        textureBytes,
        sharedTextureBytes,
        gpuBytes: geometryBytes + textureBytes + sharedTextureBytes,
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      built?.dispose();
      for (const o of own) o.texture.dispose();
      for (const p of pictures) closePicture(p);
      own.length = 0;
      pictures.length = 0;
      logoTexture = null;
      if (logoHeld) {
        logoHeld = false;
        releaseLogo(resolution);
      }
    },
  };
}

/** One call: opens the capsule and builds its model. Null for no 3D capsule. */
export async function buildCapsule3d(
  id: string,
  options: OpenCapsule3dOptions = {},
): Promise<Capsule3d | null> {
  const capsule = openCapsule3d(id, options);
  if (!capsule) return null;
  try {
    await capsule.model();
    return capsule;
  } catch (e) {
    capsule.dispose();
    throw e;
  }
}
