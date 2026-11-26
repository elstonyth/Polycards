// One growing sprite atlas for every cell the 3D reel draws: Pokémon sprites,
// custom card art (One Piece) and ticket tiles with their amount baked in.
// Images load through an Image element with crossOrigin anonymous (never
// fetch); a host without CORS fails to load and the cell falls back to the
// neutral card back. Small pixel sprites are cropped to the figure and drawn
// mass-centred at native size; larger art is scaled down to fit the tile.
import * as THREE from 'three';
import { NEUTRAL_CARD_SPRITE, type HReelCell } from '@/lib/hreel';
import { spritePng } from '@/lib/mock/pokedex';

export const TILE = 128;
const COLS = 16;
const ROWS = 8;
const ALPHA_MIN = 12;

export type AtlasSlot = {
  /** Tile origin in uv (top-left, flipY off). */
  u0: number;
  v0: number;
  /** Tile side divided by the figure's larger side. */
  scale: number;
};

const srcOf = (c: HReelCell) =>
  c.image ?? (c.dex > 0 ? spritePng(c.dex) : NEUTRAL_CARD_SPRITE);
export const atlasKey = (c: HReelCell) => `${srcOf(c)}|${c.label ?? ''}`;

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    const timer = setTimeout(() => resolve(null), 8000);
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

export class Atlas {
  readonly texture: THREE.CanvasTexture;
  readonly tileUv: [number, number] = [1 / COLS, 1 / ROWS];
  readonly bytes = COLS * TILE * ROWS * TILE * 4;
  private canvas = document.createElement('canvas');
  private ctx: CanvasRenderingContext2D;
  private scratch = document.createElement('canvas');
  private sctx: CanvasRenderingContext2D;
  private slots = new Map<string, AtlasSlot>();
  private pending = new Map<string, Promise<void>>();
  private next = 0;
  private gen = 0;

  constructor() {
    this.canvas.width = COLS * TILE;
    this.canvas.height = ROWS * TILE;
    this.ctx = this.canvas.getContext('2d')!;
    this.sctx = this.scratch.getContext('2d', { willReadFrequently: true })!;
    const t = new THREE.CanvasTexture(this.canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    t.magFilter = THREE.NearestFilter;
    t.minFilter = THREE.NearestFilter;
    t.generateMipmaps = false;
    t.flipY = false;
    this.texture = t;
  }

  slot(c: HReelCell): AtlasSlot | undefined {
    return this.slots.get(atlasKey(c));
  }

  /** Load every cell not in the atlas yet; one texture upload per call. */
  async ensure(cells: readonly HReelCell[]): Promise<void> {
    const missing = () => {
      const m = new Map<string, HReelCell>();
      for (const c of cells) {
        const k = atlasKey(c);
        if (!this.slots.has(k) && !this.pending.has(k)) m.set(k, c);
      }
      return m;
    };
    let want = missing();
    if (
      want.size > 0 &&
      this.next + this.pending.size + want.size > COLS * ROWS
    ) {
      // Full: start over with only what this call needs (rare; big packs
      // rotate their whole pool through the reel across idle cycles).
      this.reset();
      want = missing();
    }
    const waits = cells
      .map((c) => this.pending.get(atlasKey(c)))
      .filter((p): p is Promise<void> => p !== undefined);
    if (want.size > 0) {
      const gen = this.gen;
      const batch = Promise.all(
        [...want].map(async ([k, c]) => {
          // A custom sprite whose host refuses CORS (the media bucket allows
          // only the live site's origins) falls back to the species sprite,
          // then to the neutral card back.
          const img =
            (await loadImage(srcOf(c))) ??
            (c.image && c.dex > 0 ? await loadImage(spritePng(c.dex)) : null) ??
            (await loadImage(NEUTRAL_CARD_SPRITE));
          if (gen !== this.gen) return;
          this.draw(k, c, img);
        }),
      ).then(() => {
        for (const k of want.keys()) this.pending.delete(k);
        if (gen === this.gen) this.texture.needsUpdate = true;
      });
      for (const k of want.keys()) this.pending.set(k, batch);
      waits.push(batch);
    }
    await Promise.all(waits);
  }

  dispose() {
    this.gen++;
    this.texture.dispose();
  }

  private reset() {
    this.gen++;
    this.pending.clear();
    this.slots.clear();
    this.next = 0;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private draw(key: string, c: HReelCell, img: HTMLImageElement | null) {
    if (this.next >= COLS * ROWS) return;
    const i = this.next++;
    const tx = (i % COLS) * TILE;
    const ty = Math.floor(i / COLS) * TILE;
    const slot: AtlasSlot = {
      u0: tx / this.canvas.width,
      v0: ty / this.canvas.height,
      scale: 1,
    };
    this.slots.set(key, slot);
    const ctx = this.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.rect(tx + 1, ty + 1, TILE - 2, TILE - 2);
    ctx.clip();
    if (img && img.naturalWidth) this.drawFigure(img, tx, ty, slot);
    if (c.label) {
      // A ticket's amount over its art: the whole tile is shown, so the label
      // stays inside the visible square.
      slot.scale = 1;
      ctx.font = `800 ${Math.round(TILE * 0.24)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.lineWidth = 5;
      ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx.fillStyle = '#fff';
      ctx.strokeText(c.label, tx + TILE / 2, ty + TILE - 12);
      ctx.fillText(c.label, tx + TILE / 2, ty + TILE - 12);
    }
    ctx.restore();
  }

  private drawFigure(
    img: HTMLImageElement,
    tx: number,
    ty: number,
    slot: AtlasSlot,
  ) {
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    const ctx = this.ctx;
    if (Math.max(w, h) > TILE) {
      // Card art: fit the whole picture, smoothed.
      const k = TILE / Math.max(w, h);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(
        img,
        tx + (TILE - w * k) / 2,
        ty + (TILE - h * k) / 2,
        w * k,
        h * k,
      );
      return;
    }
    // Pixel sprite: crop to the figure, mass-centre it, native pixels.
    this.scratch.width = w;
    this.scratch.height = h;
    this.sctx.clearRect(0, 0, w, h);
    this.sctx.drawImage(img, 0, 0);
    let data: Uint8ClampedArray;
    try {
      data = this.sctx.getImageData(0, 0, w, h).data;
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
    slot.scale = TILE / Math.max(maxX - minX + 1, maxY - minY + 1);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(
      img,
      tx + TILE / 2 - Math.round(sx / n),
      ty + TILE / 2 - Math.round(sy / n),
    );
  }
}
