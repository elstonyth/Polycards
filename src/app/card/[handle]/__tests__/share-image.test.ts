// @vitest-environment node
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let cardResult: {
  status: string;
  card?: { slabImage: string | null; image: string };
};
vi.mock('@/lib/data/cards', () => ({
  getCardResult: async () => cardResult,
}));

const { GET } = await import('../share.jpg/route');

const BACKGROUND = [0x17, 0x17, 0x17];
const ART = [200, 30, 30];

// A portrait slab like a baked composite: the same ~0.59 aspect, transparent
// outside its rounded corners.
const slabWebp = () =>
  sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="590" height="1000"><rect width="590" height="1000" rx="90" fill="rgb(${ART})"/></svg>`,
    ),
  )
    .webp()
    .toBuffer();

const request = (handle: string) =>
  GET(new Request(`http://localhost/card/${handle}/share.jpg`), {
    params: Promise.resolve({ handle }),
  });

async function pixels(res: Response) {
  const { data, info } = await sharp(Buffer.from(await res.arrayBuffer()))
    .raw()
    .toBuffer({ resolveWithObject: true });
  return (x: number, y: number) => {
    const at = (y * info.width + x) * info.channels;
    return [...data.subarray(at, at + 3)];
  };
}

const expectNear = (actual: number[], wanted: number[]) =>
  actual.forEach((value, i) =>
    expect(Math.abs(value - (wanted[i] ?? 0))).toBeLessThan(12),
  );

const fetchMock = vi.fn();

beforeEach(async () => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => new Response(await slabWebp()));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GET /card/[handle]/share.jpg', () => {
  it('serves the whole slab on an opaque square, not a crop of it', async () => {
    cardResult = {
      status: 'ok',
      card: { slabImage: 'https://cdn.test/whole.webp', image: 'raw.webp' },
    };
    const res = await request('whole-1');

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(res.headers.get('cache-control')).toContain('public');

    const clone = res.clone();
    const meta = await sharp(Buffer.from(await clone.arrayBuffer())).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual([
      'jpeg',
      1080,
      1080,
    ]);

    const at = await pixels(res);
    // Canvas margin, then the slab's top and bottom edges both on the canvas.
    expectNear(at(5, 5), BACKGROUND);
    expectNear(at(540, 30), BACKGROUND);
    expectNear(at(540, 70), ART);
    expectNear(at(540, 1010), ART);
    // The slab's own transparent corner must not flatten to black: that is the
    // black tile Facebook showed.
    expectNear(at(262, 64), BACKGROUND);
  });

  it('prefers the baked slab and falls back to the raw card photo', async () => {
    cardResult = {
      status: 'ok',
      card: { slabImage: 'https://cdn.test/prefer.webp', image: 'raw.webp' },
    };
    await request('prefer-1');
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://cdn.test/prefer.webp',
    );

    fetchMock.mockClear();
    cardResult = {
      status: 'ok',
      card: { slabImage: null, image: 'https://cdn.test/raw-only.webp' },
    };
    await request('raw-1');
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://cdn.test/raw-only.webp',
    );
  });

  it('composes one art URL once, however often it is requested', async () => {
    cardResult = {
      status: 'ok',
      card: { slabImage: 'https://cdn.test/once.webp', image: '' },
    };
    const first = await (await request('once-1')).arrayBuffer();
    const second = await (await request('once-1')).arrayBuffer();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The memoised bytes must survive being handed to every Response.
    expect(first.byteLength).toBeGreaterThan(0);
    expect(second.byteLength).toBe(first.byteLength);
  });

  it('sends a card with no usable art to the site image, uncached', async () => {
    cardResult = {
      status: 'ok',
      card: { slabImage: 'https://cdn.test/gone.webp', image: '' },
    };
    fetchMock.mockImplementation(async () => new Response('', { status: 404 }));
    const res = await request('gone-1');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/seo/og.png');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('retries after a failed fetch instead of remembering the failure', async () => {
    cardResult = {
      status: 'ok',
      card: { slabImage: 'https://cdn.test/blip.webp', image: '' },
    };
    fetchMock.mockImplementationOnce(async () => {
      throw new Error('network');
    });
    expect((await request('blip-1')).status).toBe(302);
    // The memo evicts on the rejection's own microtask.
    await Promise.resolve();
    expect((await request('blip-1')).status).toBe(200);
  });

  it.each(['notfound', 'error'])(
    'sends a %s lookup to the site image without fetching',
    async (status) => {
      cardResult = { status };
      const res = await request('missing-1');
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/seo/og.png');
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});
