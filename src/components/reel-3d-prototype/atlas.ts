// PROTOTYPE, throwaway: one sprite atlas for every reel cell on /reel-preview.
// Static PNG sprites are loaded with an Image element (crossOrigin anonymous,
// never fetch), cropped to the figure and drawn mass-centred into 128 px tiles
// on one canvas: nearest filtering, no mipmaps, sRGB.
import * as THREE from 'three';
import { spritePng } from '@/lib/mock/pokedex';

export const TILE = 128;
const COLS = 6;
const ALPHA_MIN = 12;

export type AtlasSlot = {
  /** Tile origin in uv (top-left, flipY off). */
  u0: number;
  v0: number;
  /** Tile side divided by the figure's larger side. */
  scale: number;
};

export type Atlas = {
  texture: THREE.CanvasTexture;
  slots: Map<number, AtlasSlot>;
  tileUv: [number, number];
  bytes: number;
};

function loadImage(
  src: string,
  timeoutMs: number,
): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    const timer = setTimeout(() => resolve(null), timeoutMs);
    img.onload = () => {
      clearTimeout(timer);
      resolve(img);
    };
    img.onerror = () => {
      clearTimeout(timer);
      resolve(null);
    };
    img.src = src;
  });
}

export async function buildAtlas(dexes: readonly number[]): Promise<Atlas> {
  const unique = [...new Set(dexes)];
  const rows = Math.ceil(unique.length / COLS);
  const canvas = document.createElement('canvas');
  canvas.width = COLS * TILE;
  canvas.height = rows * TILE;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  const scratch = document.createElement('canvas');
  const sctx = scratch.getContext('2d', { willReadFrequently: true })!;

  const images = await Promise.all(
    unique.map((dex) => loadImage(spritePng(dex), 8000)),
  );
  const slots = new Map<number, AtlasSlot>();
  unique.forEach((dex, i) => {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    const tx = col * TILE;
    const ty = row * TILE;
    const slot: AtlasSlot = {
      u0: tx / canvas.width,
      v0: ty / canvas.height,
      scale: 1,
    };
    slots.set(dex, slot);
    const img = images[i];
    if (!img || !img.naturalWidth) return;
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    scratch.width = w;
    scratch.height = h;
    sctx.clearRect(0, 0, w, h);
    sctx.drawImage(img, 0, 0);
    let data: Uint8ClampedArray;
    try {
      data = sctx.getImageData(0, 0, w, h).data;
    } catch {
      return; // tainted: leave the tile blank
    }
    let minX = w;
    let minY = h;
    let maxX = -1;
    let maxY = -1;
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if ((data[(y * w + x) * 4 + 3] ?? 0) > ALPHA_MIN) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
          sx += x;
          sy += y;
          n++;
        }
      }
    }
    if (n === 0) return;
    const cx = Math.round(sx / n);
    const cy = Math.round(sy / n);
    const figMax = Math.max(maxX - minX + 1, maxY - minY + 1);
    slot.scale = TILE / figMax;
    ctx.save();
    ctx.beginPath();
    ctx.rect(tx + 1, ty + 1, TILE - 2, TILE - 2);
    ctx.clip();
    // Native pixels, no resampling: the mass centre lands on the tile centre.
    ctx.drawImage(img, tx + TILE / 2 - cx, ty + TILE / 2 - cy);
    ctx.restore();
  });

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.flipY = false;
  texture.needsUpdate = true;
  return {
    texture,
    slots,
    tileUv: [TILE / canvas.width, TILE / canvas.height],
    bytes: canvas.width * canvas.height * 4,
  };
}
