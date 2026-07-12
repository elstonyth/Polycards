import sharp from 'sharp';
import { composeSlab, isAllowedImageUrl } from '../bake-slab';

// SSRF guard for the server-side slab-bake fetch (frame + card image). Public
// hosts and storefront-relative paths are allowed (a strict CDN allowlist would
// break legit baking); internal / metadata / loopback targets are rejected.
describe('isAllowedImageUrl', () => {
  it.each([
    ['CDN https URL', 'https://cdn.pixelslot.example/slab-abc.webp'],
    ['public http URL', 'http://images.example.com/card.jpg'],
    ['storefront-relative path', '/images/test-card.webp'],
    ['relative cdn path', '/cdn/test-pack.webp'],
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
    ['localhost', 'http://localhost:9000/static/x.png'],
    ['IPv6 loopback', 'http://[::1]/x.png'],
    ['file: scheme', 'file:///etc/passwd'],
    ['protocol-relative', '//evil.example.com/x.png'],
    ['garbage', 'not a url'],
    ['empty', ''],
  ])('rejects %s', (_label, url) => {
    expect(isAllowedImageUrl(url)).toBe(false);
  });
});

// composeSlab geometry contract: output = frame-sized webp; the card photo
// covers the window rect (insets 28.33% / 10.47% / 6.66%); frame layers on top.
describe('composeSlab', () => {
  const makeFrame = (w: number, h: number) =>
    sharp({
      // fully transparent "frame" — lets the test sample the photo underneath
      create: { width: w, height: h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toBuffer();
  const makePhoto = () =>
    sharp({
      create: { width: 300, height: 420, channels: 3, background: { r: 255, g: 0, b: 0 } },
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
    // window centre → the red photo shows through the transparent frame
    const cy = Math.round(669 * 0.2833 + (669 * (1 - 0.2833 - 0.0666)) / 2);
    const c = px(200, cy);
    expect(data[c]).toBeGreaterThan(200); // R
    expect(data[c + 1]).toBeLessThan(50); // G
    // above the window (label area) → still transparent
    const t = px(200, Math.round(669 * 0.1));
    expect(data[t + 3]).toBe(0); // alpha
  });

  it('caps output at 1600px wide', async () => {
    const out = await composeSlab(await makeFrame(3200, 5352), await makePhoto());
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(1600);
  });
});
