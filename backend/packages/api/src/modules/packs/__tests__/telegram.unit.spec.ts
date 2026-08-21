import sharp from 'sharp';
import {
  buildApexCaption,
  escapeHtml,
  postApexPull,
  resetTelegramWarnings,
  type ApexCaptionInput,
} from '../telegram';

const caption = (over: Partial<ApexCaptionInput> = {}): string =>
  buildApexCaption({
    who: 'Headshot001',
    profileUrl: 'https://polycards.gg/profile/headshot-001',
    rarity: 'Legendary',
    cardName: 'Meowth',
    grade: 'PSA 10',
    set: 'ME02: Phantasmal Flames',
    packTitle: 'Starter Pack',
    priceMyr: 701.32,
    siteUrl: 'https://polycards.gg',
    ...over,
  });

describe('buildApexCaption', () => {
  it('names the tier, the puller, the card, the pack and the RM value', () => {
    const text = caption();
    expect(text).toContain('LEGENDARY PULL');
    expect(text).toContain('Headshot001');
    expect(text).toContain('Meowth');
    expect(text).toContain('PSA 10');
    expect(text).toContain('Starter Pack');
    expect(text).toContain('RM 701.32');
  });

  it('always renders the price at 2dp', () => {
    expect(caption({ priceMyr: 1200 })).toContain('RM 1,200.00');
    expect(caption({ priceMyr: 0.5 })).toContain('RM 0.50');
  });

  it('links the puller to their profile only when they have a handle', () => {
    expect(caption()).toContain(
      '<a href="https://polycards.gg/profile/headshot-001">Headshot001</a>',
    );
    const noHandle = caption({ profileUrl: null, who: 'Elston' });
    expect(noHandle).toContain('<b>Elston</b>');
    expect(noHandle).not.toContain('/profile/');
  });

  it('drops the grade and set lines for a raw card', () => {
    const raw = caption({ grade: '  ', set: '' });
    expect(raw).toContain('<b>Meowth</b>');
    expect(raw).not.toContain(' · ');
    expect(raw).not.toContain('🃏');
  });

  // first_name/handle are customer-controlled at signup: an unescaped caption
  // would let a customer inject a link into the public marketing channel.
  it('escapes customer- and admin-supplied text', () => {
    const evil = caption({
      who: '<a href="http://evil.example">clickme</a>',
      profileUrl: null,
      cardName: 'Tom & Jerry',
    });
    expect(evil).not.toContain('<a href="http://evil.example"');
    expect(evil).toContain('&lt;a href=&quot;http://evil.example&quot;&gt;');
    expect(evil).toContain('Tom &amp; Jerry');
  });

  it('clamps to the 1024-char Telegram caption limit', () => {
    expect(caption({ cardName: 'x'.repeat(2000) }).length).toBeLessThanOrEqual(
      1024,
    );
  });
});

describe('escapeHtml', () => {
  it('escapes &, < and > (and & first, so it is not double-escaped)', () => {
    expect(escapeHtml('a & <b> "c"')).toBe('a &amp; &lt;b&gt; &quot;c&quot;');
  });
});

// --- postApexPull gates -----------------------------------------------------
// The gates decide what becomes a permanent public post, so they get a real
// check. fetch is stubbed: a call means "we posted".

type Row = Record<string, unknown>;

let warned: string[] = [];

const fakeContainer = (rows: {
  odds?: Row[];
  pulls?: Row[];
  cards?: Row[];
  packs?: Row[];
  disabled?: string[];
}) => ({
  resolve: (key: string) => {
    if (key === 'customer') {
      return {
        // Real shape: a lowercase kebab handle (HANDLE_RE) derived from the
        // name at signup, and a first_name the customer has since changed.
        retrieveCustomer: async () => ({
          first_name: 'Elston',
          metadata: { handle: 'old-name-1a2b' },
        }),
      };
    }
    if (key === 'logger') return { warn: (m: string) => warned.push(m) };
    return {
      listPackOdds: async () => rows.odds ?? [{ rarity: 'Legendary' }],
      listPulls: async () => rows.pulls ?? [{ source: 'pack' }],
      listCards: async () =>
        rows.cards ?? [
          {
            name: 'Meowth',
            set: 'ME02',
            grader: 'PSA',
            grade: '10',
            market_value: 100,
            market_multiplier: 1.2,
            image: 'https://cdn.example/m.png',
            slab_image: null,
          },
        ],
      listPacks: async () => rows.packs ?? [{ title: 'Starter Pack' }],
      listFxRates: async () => [],
      disabledCustomerIds: async () => new Set(rows.disabled ?? []),
    };
  },
});

const EVENT = {
  pull_id: 'pull_1',
  pack_id: 'starter-pack',
  card_id: 'meowth',
  customer_id: 'cus_1',
};

describe('postApexPull', () => {
  let sent: unknown[];
  const realFetch = global.fetch;

  beforeEach(() => {
    sent = [];
    global.fetch = (async (url: string, init: { body: string }) => {
      sent.push({ url, body: JSON.parse(init.body) });
      return { json: async () => ({ ok: true }) };
    }) as unknown as typeof fetch;
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    process.env.TELEGRAM_CHAT_ID = '-100123';
    delete process.env.TELEGRAM_MIN_RARITY;
    warned = [];
    resetTelegramWarnings();
  });

  afterEach(() => {
    global.fetch = realFetch;
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    delete process.env.TELEGRAM_MIN_RARITY;
  });

  it('posts a Legendary pull as a photo', async () => {
    await postApexPull(fakeContainer({}), EVENT);
    expect(sent).toHaveLength(1);
    const [call] = sent as { url: string; body: { caption: string } }[];
    expect(call.url).toContain('/sendPhoto');
    expect(call.body.caption).toContain('LEGENDARY PULL');
    // Name = first_name, handle = link target only. Regression: the handle is
    // a slug of the name at SIGNUP and is never re-derived, so posting it as
    // the display name announces a renamed customer under their old name.
    expect(call.body.caption).toContain(
      '<a href="https://polycards.gg/profile/old-name-1a2b">Elston</a>',
    );
  });

  // Telegram composites transparency onto WHITE and offers no way to change
  // that when it fetches a URL itself, so the art has to be flattened here and
  // uploaded as bytes. A baked slab is ~1/3 semi-transparent glass — sending
  // the URL puts every apex pull in a white box on a dark channel.
  it('uploads the art flattened onto black rather than letting Telegram fetch it', async () => {
    const transparentArt = await sharp({
      create: {
        width: 8,
        height: 8,
        channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 0 },
      },
    })
      .png()
      .toBuffer();
    let uploaded: Buffer | null = null;
    global.fetch = (async (url: string, init?: { body?: unknown }) => {
      if (String(url).startsWith('https://cdn.example/')) {
        return { ok: true, arrayBuffer: async () => transparentArt };
      }
      const form = init?.body as FormData;
      uploaded = Buffer.from(await (form.get('photo') as Blob).arrayBuffer());
      sent.push({ url, body: { caption: form.get('caption') } });
      return { json: async () => ({ ok: true, result: { message_id: 7 } }) };
    }) as unknown as typeof fetch;

    await postApexPull(fakeContainer({}), EVENT);

    const [call] = sent as { url: string; body: { caption: string } }[];
    expect(call.url).toContain('/sendPhoto');
    expect(call.body.caption).toContain('LEGENDARY PULL');
    expect(uploaded).not.toBeNull();
    const meta = await sharp(uploaded!).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.hasAlpha).toBe(false);
    // The fully transparent source pixel must land on black, not Telegram's
    // white. JPEG is lossy, hence a threshold rather than an exact 0.
    const { data } = await sharp(uploaded!)
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(Math.max(data[0], data[1], data[2])).toBeLessThan(16);
  });

  // The flatten is a nicety; the post is not. Anything that stops us producing
  // our own bytes has to degrade to the old URL send, not to text.
  it('falls back to the URL photo when the art cannot be fetched', async () => {
    global.fetch = (async (url: string, init: { body: string }) => {
      if (String(url).startsWith('https://cdn.example/')) return { ok: false };
      sent.push({ url, body: JSON.parse(init.body) });
      return { json: async () => ({ ok: true }) };
    }) as unknown as typeof fetch;

    await postApexPull(fakeContainer({}), EVENT);

    const [call] = sent as { url: string; body: { photo: string } }[];
    expect(call.url).toContain('/sendPhoto');
    expect(call.body.photo).toBe('https://cdn.example/m.png');
  });

  it('falls back to the anonymous Collector name when first_name is blank', async () => {
    const container = fakeContainer({});
    const anon = {
      resolve: (key: string) =>
        key === 'customer'
          ? { retrieveCustomer: async () => ({ first_name: '', metadata: {} }) }
          : container.resolve(key),
    };
    await postApexPull(anon, EVENT);
    const [call] = sent as { body: { caption: string } }[];
    expect(call.body.caption).toMatch(/Collector \d{1,4}/);
    expect(call.body.caption).not.toContain('/profile/');
  });

  // The id is what lets the pre-flight take its own test post back down.
  it("returns Telegram's message id so the post can be deleted again", async () => {
    global.fetch = (async (url: string, init: { body: string }) => {
      sent.push({ url, body: JSON.parse(init.body) });
      return { json: async () => ({ ok: true, result: { message_id: 4321 } }) };
    }) as unknown as typeof fetch;
    await expect(postApexPull(fakeContainer({}), EVENT)).resolves.toMatchObject(
      {
        messageId: 4321,
      },
    );
  });

  it('reports a null message id when the send is rejected', async () => {
    global.fetch = (async () => ({
      json: async () => ({ ok: false, description: 'CHAT_WRITE_FORBIDDEN' }),
    })) as unknown as typeof fetch;
    const posted = await postApexPull(fakeContainer({}), EVENT);
    expect(posted?.messageId).toBeNull();
    expect(posted?.caption).toContain('LEGENDARY PULL');
  });

  it('posts an Immortal pull (above the bar)', async () => {
    await postApexPull(
      fakeContainer({ odds: [{ rarity: 'Immortal' }] }),
      EVENT,
    );
    expect(sent).toHaveLength(1);
  });

  // RARITY_ORDER puts Mythical BELOW Legendary — the counterintuitive one.
  it.each(['Mythical', 'Rare', 'Uncommon', 'Common'])(
    'stays silent for %s',
    async (rarity) => {
      await postApexPull(fakeContainer({ odds: [{ rarity }] }), EVENT);
      expect(sent).toHaveLength(0);
    },
  );

  it('honours TELEGRAM_MIN_RARITY when it is widened', async () => {
    process.env.TELEGRAM_MIN_RARITY = 'Mythical';
    await postApexPull(
      fakeContainer({ odds: [{ rarity: 'Mythical' }] }),
      EVENT,
    );
    expect(sent).toHaveLength(1);
  });

  // An unknown tier ranks BELOW Common, so a naive `<=` gate would treat a
  // typo'd bar as "post everything" — every open, to a public channel.
  it.each(['legendary', 'Legendary ', 'Mythic', ''])(
    'falls back to Legendary when TELEGRAM_MIN_RARITY is %p, not to posting everything',
    async (bar) => {
      process.env.TELEGRAM_MIN_RARITY = bar;
      await postApexPull(
        fakeContainer({ odds: [{ rarity: 'Common' }] }),
        EVENT,
      );
      expect(sent).toHaveLength(0);
      await postApexPull(
        fakeContainer({ odds: [{ rarity: 'Legendary' }] }),
        EVENT,
      );
      expect(sent).toHaveLength(1);
    },
  );

  it('stays silent when the odds row is missing (unknown tier)', async () => {
    await postApexPull(fakeContainer({ odds: [] }), EVENT);
    expect(sent).toHaveLength(0);
  });

  it('stays silent for a reward pull, but posts a free-pack pull', async () => {
    await postApexPull(fakeContainer({ pulls: [{ source: 'reward' }] }), EVENT);
    expect(sent).toHaveLength(0);
    await postApexPull(fakeContainer({ pulls: [{ source: 'free' }] }), EVENT);
    expect(sent).toHaveLength(1);
  });

  it('stays silent for a disabled player', async () => {
    await postApexPull(fakeContainer({ disabled: ['cus_1'] }), EVENT);
    expect(sent).toHaveLength(0);
  });

  it('is a no-op when the bot is not configured', async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    await postApexPull(fakeContainer({}), EVENT);
    expect(sent).toHaveLength(0);
  });

  // The card can be deleted between the roll and this subscriber running.
  it('stays silent when the card was removed since the roll', async () => {
    await expect(
      postApexPull(fakeContainer({ cards: [] }), EVENT),
    ).resolves.toBeNull();
    expect(sent).toHaveLength(0);
  });

  // The fallback is invisible from outside — a typo'd bar looks exactly like a
  // quiet week of no apex pulls, so it has to say so in the log.
  it('warns ONCE about an invalid TELEGRAM_MIN_RARITY, not once per open', async () => {
    process.env.TELEGRAM_MIN_RARITY = 'Mythic';
    await postApexPull(fakeContainer({ odds: [{ rarity: 'Common' }] }), EVENT);
    await postApexPull(fakeContainer({ odds: [{ rarity: 'Common' }] }), EVENT);
    expect(
      warned.filter((m) => m.includes('TELEGRAM_MIN_RARITY')),
    ).toHaveLength(1);
    expect(warned[0]).toContain('Mythic');
    expect(warned[0]).toContain('Legendary');
  });

  it('says nothing when TELEGRAM_MIN_RARITY is valid or unset', async () => {
    process.env.TELEGRAM_MIN_RARITY = 'Mythical';
    await postApexPull(fakeContainer({ odds: [{ rarity: 'Common' }] }), EVENT);
    delete process.env.TELEGRAM_MIN_RARITY;
    await postApexPull(fakeContainer({ odds: [{ rarity: 'Common' }] }), EVENT);
    expect(warned).toHaveLength(0);
  });

  // A throw would be re-delivered by the event bus, and Telegram has no
  // dedupe — a retry means a duplicate public post.
  it('never throws when a lookup fails', async () => {
    const broken = {
      resolve: (key: string) => {
        if (key === 'logger') return { warn: () => undefined };
        throw new Error('module down');
      },
    };
    await expect(postApexPull(broken, EVENT)).resolves.toBeNull();
    expect(sent).toHaveLength(0);
  });
});
