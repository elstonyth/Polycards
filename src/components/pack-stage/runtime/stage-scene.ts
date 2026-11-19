/**
 * Pack stage scene (plan section 4): the renderer, the camera, the one shared
 * studio environment, the host-pixel to world mapping and the GPU memory
 * arithmetic. Renderer and camera settings match the tuned capture harness
 * (docs/research/home-3d/pack-3d/harness/stage.js): fov 28, NeutralToneMapping,
 * exposure 1, sRGB output, studio reflections from `buildStudioEnvironment`.
 * The canvas is transparent: the page shows through.
 */
import * as THREE from 'three';

import { buildStudioEnvironment } from '@/components/pack-3d/pack-studio';
import type { Pose, StageLayout } from '../contract';

export const CAMERA_FOV_DEG = 28;
/** Camera distance D in world units (a pack is 1 unit tall). */
export const CAMERA_DISTANCE = 10;
export const DPR_CAP_FULL = 2;
export const DPR_CAP_LITE = 1.5;
/** MSAA only below this pixel ratio (plan: `antialias: dpr < 1.5`). */
export const MSAA_BELOW_DPR = 1.5;

const HALF_FOV_TAN = Math.tan(((CAMERA_FOV_DEG / 2) * Math.PI) / 180);

/** World units per host CSS px: k = 2 * D * tan(fov / 2) / hostH. */
export function worldPerPixel(hostH: number): number {
  return hostH > 0 ? (2 * CAMERA_DISTANCE * HALF_FOV_TAN) / hostH : 0;
}

/** The CSS `perspective` (px) that matches the camera: D / k. */
export function cssPerspective(hostH: number): number {
  return hostH / (2 * HALF_FOV_TAN);
}

export function dprCap(tier: 'full' | 'lite'): number {
  return tier === 'lite' ? DPR_CAP_LITE : DPR_CAP_FULL;
}

/**
 * Places a 1-unit-tall model so it lands on the HTML picture it replaces.
 * Pose units are host CSS px (+y down); the slot's linear position
 * `cx + (index - track) * step` is added here, not in the pose.
 */
export function placeModel(
  object: THREE.Object3D,
  pose: Readonly<Pose>,
  slotX: number,
  layout: Readonly<StageLayout>,
  hostW: number,
  hostH: number,
): void {
  const k = worldPerPixel(hostH);
  object.position.set(
    (slotX + pose.dx - hostW / 2) * k,
    -(layout.cy + pose.dy - hostH / 2) * k,
    pose.z * k,
  );
  // CSS `rotateY() rotateX()` with y flipped: rotation.x = -rotX, order YXZ.
  object.rotation.set(-pose.rotX, pose.rotY, 0, 'YXZ');
  object.scale.setScalar(layout.artH * k * pose.scale);
}

export type StageScene = {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  environment: THREE.WebGLRenderTarget;
  /** The environment map's GPU bytes (half-float PMREM cube with its levels). */
  environmentBytes: number;
  /** MSAA samples of the default framebuffer (0 = none). */
  samples: number;
};

export function createStageScene(opts: {
  canvas: HTMLCanvasElement;
  antialias: boolean;
  failIfMajorPerformanceCaveat: boolean;
}): StageScene {
  const renderer = new THREE.WebGLRenderer({
    canvas: opts.canvas,
    alpha: true,
    premultipliedAlpha: true,
    antialias: opts.antialias,
    powerPreference: 'default',
    failIfMajorPerformanceCaveat: opts.failIfMajorPerformanceCaveat,
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.setClearColor(0x000000, 0);

  const gl = renderer.getContext();
  const attrs = gl.getContextAttributes();
  const samples = attrs?.antialias
    ? Number(gl.getParameter(gl.SAMPLES)) || 0
    : 0;

  const environment = buildStudioEnvironment(renderer);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(CAMERA_FOV_DEG, 1, 0.1, 100);
  camera.position.set(0, 0, CAMERA_DISTANCE);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();

  return {
    renderer,
    scene,
    camera,
    environment,
    environmentBytes: renderTargetBytes(environment),
    samples,
  };
}

function bytesPerTexel(type: THREE.TextureDataType): number {
  if (type === THREE.FloatType) return 16;
  if (type === THREE.HalfFloatType) return 8;
  return 4;
}

/**
 * A render target's colour bytes. three 0.187's PMREM is a half-float cube map
 * (6 faces) with its prefiltered levels listed in `texture.mipmaps`.
 */
export function renderTargetBytes(target: THREE.WebGLRenderTarget): number {
  const faces = (target as { isWebGLCubeRenderTarget?: boolean })
    .isWebGLCubeRenderTarget
    ? 6
    : 1;
  const bpt = bytesPerTexel(target.texture.type);
  const levels = (target.texture.mipmaps ?? []) as {
    width?: number;
    height?: number;
  }[];
  let px = 0;
  if (levels.length > 0 && levels.every((m) => m.width && m.height)) {
    for (const m of levels) px += (m.width ?? 0) * (m.height ?? 0);
  } else {
    px = target.width * target.height;
    if (target.texture.generateMipmaps) px = (px * 4) / 3;
  }
  return Math.round(px * faces * bpt);
}

/**
 * The canvas's own GPU memory: without MSAA a back buffer, the displayed front
 * buffer and a 32-bit depth buffer (12 bytes per device pixel); with MSAA the
 * multisampled colour and depth plus the resolve and front buffers.
 */
export function drawingBufferBytes(
  width: number,
  height: number,
  samples: number,
): number {
  const px = Math.max(0, width) * Math.max(0, height);
  return samples > 0 ? px * (samples * 8 + 8) : px * 12;
}
