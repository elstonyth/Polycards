// @vitest-environment node
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let packImage: string | null;
vi.mock('@/lib/data/packs', () => ({
  getPackBySlug: async () =>
    packImage === null ? null : { pack: { image: packImage } },
}));

const { GET } = await import('../share.jpg/route');

const request = (slug: string) =>
  GET(new Request(`http://localhost/slots/${slug}/share.jpg`), {
    params: Promise.resolve({ slug }),
  });

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GET /slots/[slug]/share.jpg', () => {
  it('reads our own pack art from disk, never through the public site', async () => {
    packImage = '/images/polycards/bronze-pack.webp';
    const res = await request('bronze-pack');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual([
      'jpeg',
      1080,
      1080,
    ]);
  });

  it('fetches pack art hosted on the CDN', async () => {
    packImage = 'https://cdn.test/pack.webp';
    fetchMock.mockImplementation(
      async () =>
        new Response(
          await sharp({
            create: {
              width: 500,
              height: 900,
              channels: 4,
              background: { r: 10, g: 200, b: 10, alpha: 1 },
            },
          })
            .webp()
            .toBuffer(),
        ),
    );
    const res = await request('cdn-pack');
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(packImage);
    expect(res.status).toBe(200);
  });

  it.each([
    ['an unknown pack', null],
    ['a missing public file', '/images/polycards/no-such-pack.webp'],
    ['a path out of public/', '/../../package.json'],
    ['an empty image', ''],
  ])('sends %s to the site image without fetching', async (_label, image) => {
    packImage = image;
    const res = await request('fallback');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/seo/og.png');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
