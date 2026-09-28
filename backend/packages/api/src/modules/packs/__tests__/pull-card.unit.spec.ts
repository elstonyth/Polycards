import sharp from 'sharp';
import {
  composePullCard,
  formatPulledAt,
  imageSafeName,
  renderPullCard,
  type PullCardInput,
} from '../pull-card';

// The look itself is judged from Linux renders (fonts only resolve there — see
// pull-card.ts); these pin the contract the Telegram path relies on: a JPEG of
// the right shape from any art, never a throw from renderPullCard, and the two
// pieces of copy logic.

const INPUT: PullCardInput = {
  rarity: 'Legendary',
  cardName: 'Pikachu & Zekrom GX #112',
  grader: 'PSA',
  grade: '10',
  set: 'Pokemon Japanese Tag Bolt',
  priceMyr: 2290.6,
  buybackMyr: 2061.54,
  buybackPercent: 90,
  who: 'ATYH',
  revealedAt: new Date('2026-09-28T07:26:00Z'),
  siteHost: 'polycards.gg',
};

const png = (width: number, height: number) =>
  sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 200, g: 60, b: 120, alpha: 0.6 },
    },
  })
    .png()
    .toBuffer();

describe('formatPulledAt', () => {
  // The audience's clock, not the container's UTC: 07:26Z is 3:26 pm in KL.
  it('formats in Malaysia time', () => {
    expect(formatPulledAt(new Date('2026-09-28T07:26:00Z'))).toMatch(
      /^28 Sept? 2026, 3:26 pm$/,
    );
  });
});

describe('imageSafeName', () => {
  it('keeps names the bundled faces can draw', () => {
    expect(imageSafeName('ATYH')).toBe('ATYH');
    expect(imageSafeName('  Zoë_99 ')).toBe('Zoë_99');
  });

  // No bundled face covers these — they would ship as tofu boxes.
  it.each(['王小明', 'fire🔥', '   '])('falls back to Anonymous for %p', (name) => {
    expect(imageSafeName(name)).toBe('Anonymous');
  });
});

describe('composePullCard', () => {
  it('renders a graded pull as a 1080-wide JPEG', async () => {
    const jpeg = await composePullCard(INPUT, {
      slab: await png(160, 270),
      card: null,
      pack: await png(92, 166),
    });
    const meta = await sharp(jpeg).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.width).toBe(1080);
    expect(meta.height).toBeGreaterThan(1400);
    expect(meta.hasAlpha).toBe(false);
  });

  it('renders a raw card, with no grade and no pack art', async () => {
    const jpeg = await composePullCard(
      { ...INPUT, grader: '', grade: '', set: '' },
      { slab: null, card: await png(125, 175), pack: null },
    );
    expect((await sharp(jpeg).metadata()).width).toBe(1080);
  });

  // A name far past one line must wrap / clip, not push the canvas wider.
  it('keeps a pathologically long name inside the canvas', async () => {
    const jpeg = await composePullCard(
      { ...INPUT, cardName: 'Pretend Comedian Pikachu '.repeat(6) },
      { slab: await png(160, 270), card: null, pack: null },
    );
    expect((await sharp(jpeg).metadata()).width).toBe(1080);
  });

  it('refuses to render with no card art at all', async () => {
    await expect(
      composePullCard(INPUT, { slab: null, card: null, pack: null }),
    ).rejects.toThrow('no card art');
  });
});

describe('renderPullCard', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('reports, never throws, when there is no art to fetch', async () => {
    const result = await renderPullCard(INPUT, {
      slab: null,
      card: null,
      pack: null,
    });
    expect(result.photo).toBeNull();
    expect(result.error).toContain('no card art');
  });

  // The art fetch goes through the SSRF-guarded fetchBytes, like the rest of
  // the Telegram path: a private host is refused before any network call.
  it('refuses a private-host URL and says so', async () => {
    const result = await renderPullCard(INPUT, {
      slab: 'http://127.0.0.1/slab.png',
      card: null,
      pack: null,
    });
    expect(result.photo).toBeNull();
    expect(result.error).toContain('blocked');
  });

  it('falls back to the bare photo when the slab is unreachable, and warns about the pack', async () => {
    const photo = await png(125, 175);
    global.fetch = (async (url: string) => {
      const u = String(url);
      if (u.endsWith('/card.png')) return new Response(new Uint8Array(photo));
      return new Response('nope', { status: 404 });
    }) as unknown as typeof fetch;

    const result = await renderPullCard(INPUT, {
      slab: 'https://cdn.example/slab.png',
      card: 'https://cdn.example/card.png',
      pack: 'https://cdn.example/pack.png',
    });

    expect(result.photo).not.toBeNull();
    expect(result.error).toBeUndefined();
    expect(result.warning).toContain('slab art: HTTP 404');
    expect(result.warning).toContain('pack art: HTTP 404');
  });
});
