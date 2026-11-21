// The catalogue's back handling:
// the no-odds rule, hideBack(), releaseCanvas, the quarter spin back and the
// quarter spin handle, and their byte accounting. Node has no canvas or
// ImageBitmap, so pictures, canvases and the print are stand-ins; the GPU
// side (re-binding the front without an upload) is proven on the bench.
import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PackBackDetails } from '../pack-print';
import { openPack3d, printableBack } from './build';
import { PACK_3D_ASSETS } from './pack-3d-manifest';

const render = vi.hoisted(() => ({ calls: 0 }));

vi.mock('../pack-print', async (importOriginal) => {
  const real = await importOriginal<typeof import('../pack-print')>();
  return {
    ...real,
    // the print itself is pack-print.test.ts's job: here, one canvas the
    // plate's size, made through the caller's createCanvas as the real one is
    renderPackBack: (
      plates: { live: { width: number; height: number } },
      _details: unknown,
      _spec: unknown,
      options: { createCanvas?: (w: number, h: number) => unknown } = {},
    ) => {
      render.calls++;
      const canvas = options.createCanvas?.(
        plates.live.width,
        plates.live.height,
      );
      return { canvas, layout: { plate: 'live', runs: [], fit: [] } };
    },
  };
});

class FakeBitmap {
  closed = false;
  constructor(
    readonly width: number,
    readonly height: number,
    readonly url: string,
    readonly flipped: boolean,
  ) {}
  close() {
    this.closed = true;
  }
}

class FakeCanvas {
  draws = 0;
  constructor(
    public width: number,
    public height: number,
  ) {}
  getContext() {
    return {
      imageSmoothingEnabled: false,
      imageSmoothingQuality: 'low',
      drawImage: () => {
        this.draws++;
      },
    };
  }
}

const ODDS = [
  { label: 'Immortal', chance: '0.2%' },
  { label: 'Legendary', chance: '2.4%' },
];
const DETAILS: PackBackDetails = {
  price: 'RM 600.00',
  productLine: ['Silver Pack', 'Pokémon', 'Classic', 'Graded'],
  odds: ODDS,
  buyback: { headline: '90% instant buyback', rule: 'Rule.' },
};

const sizeOf = (url: string): [number, number] => {
  const path = url.split('?')[0] ?? '';
  for (const a of Object.values(PACK_3D_ASSETS)) {
    if (path === a.front.split('?')[0] || path === a.back.split('?')[0])
      return [a.width, a.height];
    if (path === a.frontHalf.split('?')[0] || path === a.backHalf.split('?')[0])
      return [a.halfWidth, a.halfHeight];
  }
  throw new Error(`no size for ${url}`);
};

let bitmaps: FakeBitmap[] = [];
let fetched: string[] = [];

beforeEach(() => {
  bitmaps = [];
  fetched = [];
  render.calls = 0;
  vi.stubGlobal('ImageBitmap', FakeBitmap);
  vi.stubGlobal('OffscreenCanvas', FakeCanvas);
  vi.stubGlobal('fetch', async (url: string) => {
    fetched.push(url);
    return { ok: true, status: 200, blob: async () => ({ url }) };
  });
  vi.stubGlobal(
    'createImageBitmap',
    async (blob: { url: string }, opts?: { imageOrientation?: string }) => {
      const [w, h] = sizeOf(blob.url);
      const b = new FakeBitmap(
        w,
        h,
        blob.url,
        opts?.imageOrientation === 'flipY',
      );
      bitmaps.push(b);
      return b;
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const ID = 'silver-pack';
const A = PACK_3D_ASSETS[ID]!;
const gpu = (w: number, h: number) => Math.round((w * h * 4 * 4) / 3);
const quarter = [
  Math.round(A.halfWidth / 2),
  Math.round(A.halfHeight / 2),
] as const;

describe('printableBack (the no-odds rule)', () => {
  it('needs pull odds rows', () => {
    expect(printableBack(DETAILS)).toBe(true);
    expect(printableBack({ ...DETAILS, odds: null })).toBe(false);
    expect(printableBack({ ...DETAILS, odds: [] })).toBe(false);
    expect(printableBack(null)).toBe(false);
  });
});

describe('showBack', () => {
  it('never prints a back without pull odds, and changes nothing', async () => {
    const pack = openPack3d(ID, { resolution: 'half' })!;
    await pack.model();
    for (const d of [
      null,
      { ...DETAILS, odds: null },
      { ...DETAILS, odds: [] },
    ])
      expect(await pack.showBack(d)).toBeNull();
    expect(render.calls).toBe(0);
    expect(fetched.some((u) => u.includes('back'))).toBe(false);
    expect(pack.textures().map((t) => t.role)).toEqual(['front']);
    pack.dispose();
  });

  it('prints at the variant size and counts GPU, canvas and transient bytes', async () => {
    const pack = openPack3d(ID, { resolution: 'half' })!;
    const back = (await pack.showBack(DETAILS))!;
    expect(back.info).toMatchObject({
      role: 'back',
      width: A.halfWidth,
      height: A.halfHeight,
    });
    expect(back.info.bytes).toBe(gpu(A.halfWidth, A.halfHeight));
    expect(pack.textures().map((t) => t.role)).toEqual(['front', 'back']);
    // the print canvas is still held (no releaseCanvas)
    expect(pack.canvasBytes()).toBe(A.halfWidth * A.halfHeight * 4);
    // decoded plate + the print canvas
    expect(back.transientBytes).toBe(2 * A.halfWidth * A.halfHeight * 4);
    expect(bitmaps.find((b) => b.url.includes('back-half'))?.closed).toBe(true);
    pack.dispose();
  });

  it('downscale 2: the quarter spin back from back-half.webp, whatever the resolution', async () => {
    const pack = openPack3d(ID, { resolution: 'full' })!;
    const back = (await pack.showBack(DETAILS, { downscale: 2 }))!;
    expect(fetched.filter((u) => u.includes('/back'))).toEqual([A.backHalf]);
    expect([back.info.width, back.info.height]).toEqual(quarter);
    expect(back.info.bytes).toBe(gpu(quarter[0], quarter[1]));
    // decoded half plate + quarter plate canvas + quarter print canvas
    expect(back.transientBytes).toBe(
      A.halfWidth * A.halfHeight * 4 + 2 * quarter[0] * quarter[1] * 4,
    );
    // only the print canvas survives the print
    expect(pack.canvasBytes()).toBe(quarter[0] * quarter[1] * 4);
    pack.dispose();
  });

  it('releaseCanvas frees the print canvas once the renderer uploads it', async () => {
    const pack = openPack3d(ID, { resolution: 'half' })!;
    const back = (await pack.showBack(DETAILS, {
      releaseCanvas: true,
      downscale: 2,
    }))!;
    const canvas = back.texture.image as FakeCanvas;
    expect(canvas.width).toBe(quarter[0]);
    expect(pack.canvasBytes()).toBe(quarter[0] * quarter[1] * 4);
    back.texture.onUpdate?.(back.texture); // what three calls after the upload
    expect(canvas.width).toBe(0);
    expect(pack.canvasBytes()).toBe(0);
    // the GPU copy is still counted
    expect(pack.textures().map((t) => t.role)).toEqual(['front', 'back']);
    pack.dispose();
  });
});

describe('hideBack', () => {
  it("puts the front's own Source back without bumping its version, and frees the back", async () => {
    const pack = openPack3d(ID, { resolution: 'half' })!;
    const model = await pack.model();
    const front = model.material.map as THREE.Texture;
    const before = { textures: pack.textures(), version: front.source.version };
    const back = (await pack.showBack(DETAILS))!;
    const canvas = back.texture.image as FakeCanvas;
    const dispose = vi.spyOn(back.texture, 'dispose');
    pack.hideBack();
    expect(dispose).toHaveBeenCalledOnce();
    expect(back.texture.source).toBe(front.source);
    expect(back.texture.flipY).toBe(front.flipY);
    expect(front.source.version).toBe(before.version);
    expect(canvas.width).toBe(0);
    expect(pack.canvasBytes()).toBe(0);
    expect(pack.textures()).toEqual(before.textures);
    pack.hideBack(); // no-op
    pack.dispose();
  });

  it('cancels a print in flight', async () => {
    const pack = openPack3d(ID, { resolution: 'half' })!;
    await pack.model();
    const p = pack.showBack(DETAILS);
    pack.hideBack();
    expect(await p).toBeNull();
    expect(pack.textures().map((t) => t.role)).toEqual(['front']);
    pack.dispose();
  });
});

describe('the quarter spin handle (downscale 2 on open)', () => {
  it('draws front-half at half size, unflipped, and counts it', async () => {
    const pack = openPack3d(ID, { resolution: 'half', downscale: 2 })!;
    const info = await pack.frontReady;
    expect([info.width, info.height]).toEqual(quarter);
    expect(info.bytes).toBe(gpu(quarter[0], quarter[1]));
    const decoded = bitmaps.find((b) => b.url.includes('front-half'))!;
    expect(decoded.flipped).toBe(false);
    expect(decoded.closed).toBe(true);
    expect(pack.canvasBytes()).toBe(quarter[0] * quarter[1] * 4);
    const model = await pack.model();
    expect((model.material.map as THREE.Texture).flipY).toBe(true);
    await pack.showBack(DETAILS, { downscale: 2, releaseCanvas: true });
    expect(pack.textures().map((t) => t.bytes)).toEqual([
      gpu(quarter[0], quarter[1]),
      gpu(quarter[0], quarter[1]),
    ]);
    pack.dispose();
    expect(pack.canvasBytes()).toBe(0);
  });
});
