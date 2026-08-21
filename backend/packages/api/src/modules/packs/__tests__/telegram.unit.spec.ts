import {
  buildApexCaption,
  escapeHtml,
  postApexPull,
  type ApexCaptionInput,
} from '../telegram';

const caption = (over: Partial<ApexCaptionInput> = {}): string =>
  buildApexCaption({
    who: 'Headshot001',
    profileUrl: 'https://polycards.gg/profile/Headshot001',
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
      '<a href="https://polycards.gg/profile/Headshot001">Headshot001</a>',
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
        retrieveCustomer: async () => ({
          first_name: 'Elston',
          metadata: { handle: 'Headshot001' },
        }),
      };
    }
    if (key === 'logger') return { warn: () => undefined };
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
    expect(call.body.caption).toContain('Headshot001');
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
