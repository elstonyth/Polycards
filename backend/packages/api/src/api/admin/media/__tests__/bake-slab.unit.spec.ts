import sharp from 'sharp';
import {
  composeSlab,
  fetchBytes,
  isAllowedImageUrl,
  SLAB_WINDOW,
} from '../bake-slab';

// SSRF guard for the server-side slab-bake fetch (frame + card image). Public
// hosts and storefront-relative paths are allowed (a strict CDN allowlist would
// break legit baking); internal / metadata / loopback targets are rejected.
describe('isAllowedImageUrl', () => {
  // These lists assume no S3 (dev/test): our local file provider origin
  // (localhost:9000) is trusted, every OTHER loopback/internal host is not.
  const originalS3 = process.env.S3_FILE_URL;
  const originalBackend = process.env.MEDUSA_BACKEND_URL;
  beforeAll(() => {
    delete process.env.S3_FILE_URL;
    delete process.env.MEDUSA_BACKEND_URL; // → defaults to http://localhost:9000
  });
  afterAll(() => {
    if (originalS3 === undefined) delete process.env.S3_FILE_URL;
    else process.env.S3_FILE_URL = originalS3;
    if (originalBackend === undefined) delete process.env.MEDUSA_BACKEND_URL;
    else process.env.MEDUSA_BACKEND_URL = originalBackend;
  });

  it.each([
    ['CDN https URL', 'https://cdn.polycards.example/slab-abc.webp'],
    ['public http URL', 'http://images.example.com/card.jpg'],
    ['storefront-relative path', '/images/test-card.webp'],
    ['relative cdn path', '/cdn/test-pack.webp'],
    // Our own local file provider — the one loopback origin we must reach to
    // bake our stored card/frame images (dev/test, S3 unset).
    ['local file provider origin', 'http://localhost:9000/static/x.png'],
  ])('allows %s', (_label, url) => {
    expect(isAllowedImageUrl(url)).toBe(true);
  });

  it.each([
    ['cloud metadata IP', 'http://169.254.169.254/latest/meta-data'],
    ['loopback IPv4', 'http://127.0.0.1/frame.png'],
    ['integer-form loopback', 'http://2130706433/frame.png'],
    ['hex-form loopback', 'http://0x7f000001/frame.png'],
    ['octal-form loopback', 'http://0177.0.0.1/frame.png'],
    ['RFC-1918 10/8', 'http://10.0.0.5/x.png'],
    ['RFC-1918 172.16/12', 'http://172.16.0.1/x.png'],
    ['RFC-1918 192.168/16', 'http://192.168.1.1/x.png'],
    ['0.0.0.0', 'http://0.0.0.0/x.png'],
    // localhost on a NON-file-provider port stays blocked (origin mismatch) —
    // only the exact local file origin is trusted, not loopback in general.
    ['localhost, other port', 'http://localhost:8080/x.png'],
    ['localhost, port 80', 'http://localhost/x.png'],
    ['IPv6 loopback', 'http://[::1]/x.png'],
    ['IPv4-mapped IPv6 loopback', 'http://[::ffff:127.0.0.1]/x.png'],
    ['IPv4-mapped IPv6 metadata', 'http://[::ffff:169.254.169.254]/x.png'],
    ['IPv6 link-local fe80', 'http://[fe80::1]/x.png'],
    [
      'IPv6 link-local mid-range (fe80::/10 is fe80-febf)',
      'http://[fe95::1]/x.png',
    ],
    ['IPv6 link-local range top', 'http://[febf::1]/x.png'],
    ['file: scheme', 'file:///etc/passwd'],
    ['protocol-relative', '//evil.example.com/x.png'],
    ['garbage', 'not a url'],
    ['empty', ''],
  ])('rejects %s', (_label, url) => {
    expect(isAllowedImageUrl(url)).toBe(false);
  });

  it('blocks the local file origin once S3 (prod CDN) is configured', () => {
    process.env.S3_FILE_URL = 'https://cdn.polycards.example';
    try {
      expect(isAllowedImageUrl('http://localhost:9000/static/x.png')).toBe(false);
    } finally {
      delete process.env.S3_FILE_URL;
    }
  });
});

// fetchBytes network contract: redirects are walked manually with every hop
// re-validated (a public URL 3xx-ing to an internal host is the classic SSRF
// bypass), and storefront-relative paths resolve against STOREFRONT_URL
// instead of throwing inside Node's fetch. fetch is mocked — no sockets.
describe('fetchBytes', () => {
  const png = new Uint8Array([1, 2, 3]);
  const redirect = (location: string) =>
    new Response(null, { status: 302, headers: { location } });
  let fetchMock: jest.SpyInstance;
  const originalStorefrontUrl = process.env.STOREFRONT_URL;

  beforeEach(() => {
    fetchMock = jest.spyOn(globalThis, 'fetch');
  });
  afterEach(() => {
    fetchMock.mockRestore();
    if (originalStorefrontUrl === undefined) delete process.env.STOREFRONT_URL;
    else process.env.STOREFRONT_URL = originalStorefrontUrl;
  });

  it('resolves storefront-relative paths against STOREFRONT_URL', async () => {
    process.env.STOREFRONT_URL = 'https://shop.example.com/';
    fetchMock.mockResolvedValue(new Response(png, { status: 200 }));
    expect(await fetchBytes('/cdn/cards/x.webp')).toEqual(Buffer.from(png));
    expect(fetchMock).toHaveBeenCalledWith(
      'https://shop.example.com/cdn/cards/x.webp',
      expect.objectContaining({ redirect: 'manual' }),
    );
  });

  it('follows an allowed redirect and returns the bytes', async () => {
    fetchMock
      .mockResolvedValueOnce(redirect('https://cdn.example.com/real.webp'))
      .mockResolvedValueOnce(new Response(png, { status: 200 }));
    expect(await fetchBytes('https://images.example.com/a.webp')).toEqual(
      Buffer.from(png),
    );
  });

  it('refuses a redirect to an internal host', async () => {
    fetchMock.mockResolvedValueOnce(
      redirect('http://169.254.169.254/latest/meta-data'),
    );
    expect(await fetchBytes('https://images.example.com/a.webp')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1); // never fetched the target
  });

  it('gives up after too many redirect hops', async () => {
    fetchMock.mockResolvedValue(
      redirect('https://images.example.com/loop.webp'),
    );
    expect(await fetchBytes('https://images.example.com/a.webp')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(4); // initial + 3 hops
  });
});

// composeSlab geometry contract: output = frame-sized webp; the card photo
// covers the window rect (SLAB_WINDOW insets — sampled from the constant below
// so this test tracks a re-measure); frame layers on top; the thin recess gap
// around the card stays transparent (no plate).
describe('composeSlab', () => {
  const makeFrame = (w: number, h: number) =>
    sharp({
      // fully transparent "frame" — lets the test sample the photo underneath
      create: {
        width: w,
        height: h,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .png()
      .toBuffer();
  const makePhoto = () =>
    sharp({
      create: {
        width: 300,
        height: 420,
        channels: 3,
        background: { r: 255, g: 0, b: 0 },
      },
    })
      .png()
      .toBuffer();

  it('outputs a frame-sized webp with the photo inside the window', async () => {
    const out = await composeSlab(await makeFrame(400, 669), await makePhoto());
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(400);
    expect(meta.height).toBe(669);

    const { data, info } = await sharp(out)
      .raw()
      .toBuffer({ resolveWithObject: true });
    const px = (x: number, y: number) => (y * info.width + x) * info.channels;
    // Geometry derived from SLAB_WINDOW so the samples move with a re-measure.
    const left = Math.round(400 * SLAB_WINDOW.left);
    const top = Math.round(669 * SLAB_WINDOW.top);
    const winW = 400 - left - Math.round(400 * SLAB_WINDOW.right);
    const cx = left + Math.round(winW / 2);
    const cy =
      top + Math.round((669 * (1 - SLAB_WINDOW.top - SLAB_WINDOW.bottom)) / 2);
    // window centre → the red photo shows through the transparent frame
    const c = px(cx, cy);
    expect(data[c]).toBeGreaterThan(200); // R
    expect(data[c + 1]).toBeLessThan(50); // G
    // the thin recess gap just inside the window's left edge, level with the
    // card, stays TRANSPARENT — the removed grey recess plate would have
    // painted this pixel opaque, so this pins the plate's removal.
    const g = px(left, cy);
    expect(data[g + 3]).toBe(0); // alpha
    // above the window (label area) → still transparent
    const t = px(cx, Math.round(669 * 0.1));
    expect(data[t + 3]).toBe(0); // alpha
  });

  it('caps output at 1600px wide', async () => {
    const out = await composeSlab(
      await makeFrame(3200, 5400),
      await makePhoto(),
    );
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(1600);
  });

  // Decode-bomb guard: fetchBytes caps BYTES (20 MB) but not DIMENSIONS, so a
  // low-entropy megapixel image from an admin-set slab_frame_url / card.image
  // would drive a full-raster sharp decode (same primitive as the avatar route).
  // composeSlab must refuse to decode an image whose pixel count exceeds the
  // ceiling instead of materializing it. (Legit frames — e.g. the 17 MP frame in
  // the 1600px-cap test above — stay under the ceiling.)
  it('refuses to decode an over-limit frame (36 MP > ceiling)', async () => {
    await expect(
      composeSlab(await makeFrame(6000, 6000), await makePhoto()),
    ).rejects.toThrow();
  });

  it('refuses to decode an over-limit card photo (36 MP > ceiling)', async () => {
    await expect(
      composeSlab(await makeFrame(400, 669), await makeFrame(6000, 6000)),
    ).rejects.toThrow();
  });

  // The old cap was width-only, so a frame narrower than MAX_FRAME_WIDTH but
  // pathologically TALL skipped the resize entirely and ballooned the create
  // canvas + composite (fw×fh RGBA). Bound the height too — downscaling to fit
  // (aspect preserved), never a silent bake failure.
  it('downscales a pathologically tall frame to bound the composite canvas', async () => {
    const out = await composeSlab(await makeFrame(1000, 9000), await makePhoto());
    const meta = await sharp(out).metadata();
    expect(meta.height).toBe(4000); // capped
    expect(meta.width).toBe(444); // aspect preserved (1000 × 4000/9000)
  });

  it('does not upscale a small frame', async () => {
    const out = await composeSlab(await makeFrame(400, 669), await makePhoto());
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(400);
    expect(meta.height).toBe(669);
  });

  // A narrow-tall scan passes the input guards (≤20MB, ≤32MP) but width-fitting
  // it balloons cardH into the resize allocation below, overflowing the frame
  // canvas — reject it before that allocation instead of letting the worker OOM.
  it('rejects a degenerate narrow-tall card scan', async () => {
    const tallPhoto = sharp({
      create: { width: 40, height: 4000, channels: 3, background: { r: 0, g: 128, b: 0 } },
    })
      .png()
      .toBuffer();
    await expect(
      composeSlab(await makeFrame(400, 669), await tallPhoto),
    ).rejects.toThrow(/too tall/);
  });

  it('renders the label text layer when label fields are passed', async () => {
    const { LABEL_BOX } = await import('../label.js');
    const out = await composeSlab(await makeFrame(400, 669), await makePhoto(), {
      set: 'Pokemon Surging Sparks',
      name: 'Pikachu ex #238',
      grade: '10',
      year: '2024',
      note: 'SPECIAL ILLUSTRATION RARE',
    });
    const { data, info } = await sharp(out)
      .raw()
      .toBuffer({ resolveWithObject: true });
    // ink somewhere inside the label box band (the frame is transparent here,
    // so any non-zero alpha in the band is label text)
    const y0 = Math.round(669 * LABEL_BOX.top);
    const y1 = Math.round(669 * (LABEL_BOX.top + LABEL_BOX.height));
    let ink = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = 0; x < info.width; x++) {
        if (data[(y * info.width + x) * info.channels + 3] > 0) ink++;
      }
    }
    expect(ink).toBeGreaterThan(100);
  });
});

// §9 PSA-only bake: the PSA-branded frame must never assert a PSA grade for
// another grader's slab. The gate lives INSIDE bakeSlabImage (one guard for
// every caller) and fires before any container/network use.
describe('bakeSlabImage PSA gate', () => {
  const fields = {
    handle: 'x',
    image: 'https://cdn.example.com/x.webp',
    grade: '10',
    name: 'Pikachu ex #238',
    set: 'Pokemon Surging Sparks',
  };

  it.each([['CGC'], ['BGS'], ['SGC'], [''], ['  ']])(
    'returns null for grader %p without touching the container',
    async (grader) => {
      const { bakeSlabImage } = await import('../bake-slab.js');
      const container = new Proxy(
        {},
        {
          get() {
            throw new Error('container must not be touched for a non-PSA card');
          },
        },
      );
      await expect(
        bakeSlabImage(
          container as unknown as Parameters<typeof bakeSlabImage>[0],
          { ...fields, grader },
        ),
      ).resolves.toBeNull();
    },
  );
});
