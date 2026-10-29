import {
  forgetSpeechModels,
  generationCost,
  speechModels,
} from '../openrouter';
import {
  estimateSpeechCost,
  speak,
  speakable,
  speechChoiceProblem,
  speechPieces,
  transcribe,
  type SpeechEvent,
} from '../voice';

describe('speakable', () => {
  it('reads a table row by row with its headings, without symbols', () => {
    expect(
      speakable(
        '**Today** (default group):\n\n| Item | Amount |\n|---|---:|\n| Revenue | RM 0.00 |\n| Payouts | RM 1.50 |\n\nNothing opened yet.',
      ),
    ).toBe(
      'Today (default group):\nRevenue, Amount 0 ringgit.\nPayouts, Amount 1 ringgit 50 sen.\nNothing opened yet.',
    );
  });

  it('keeps link words and drops URLs, images and code', () => {
    expect(
      speakable(
        'See [the pack](https://polycards.gg/p/151) at https://polycards.gg.\n![poster](https://cdn/x.png)\n```sql\nselect 1\n```\n- one\n- two',
      ),
    ).toBe('See the pack at \none\ntwo');
  });

  it('cuts a long answer at a sentence and says the rest is on screen', () => {
    const long = 'This is one sentence. '.repeat(120);
    const out = speakable(long);
    expect(out.length).toBeLessThan(1600);
    expect(out.endsWith('sentence. The rest is on screen.')).toBe(true);
  });

  it('reads bold, dash and empty cells and dashes in prose without symbols', () => {
    expect(
      speakable(
        '| **Item** | **Amount** | Note |\n|---|---:|---|\n| **Revenue** | RM 1,234.50 | — |\n| Payouts | | a<br>b |\n\nTop-up — up ~~10~~ → 12, packs 10–20.',
      ),
    ).toBe(
      'Revenue, Amount 1,234 ringgit 50 sen.\nPayouts, Note a, b.\nTop-up, up 10, 12, packs 10–20.',
    );
    // One ~ means "about" and is kept; a Chinese —— is one pause.
    expect(speakable('Sold ~RM 50——不错')).toBe('Sold ~50 ringgit, 不错');
  });

  it('cuts Chinese at a full stop, sooner, and closes in Chinese', () => {
    const out = speakable('今天卖了很多卡。'.repeat(300));
    expect(out.endsWith('卡。其余内容请看屏幕。')).toBe(true);
    // A character takes ~3x a letter to say: ~500 of them, not 1,500.
    expect(out.length).toBeLessThan(560);
  });

  it('cuts at a question or exclamation mark, not inside a number', () => {
    expect(
      speakable('Was RM 1,234.50 sold? '.repeat(100)).endsWith(
        'sold? The rest is on screen.',
      ),
    ).toBe(true);
    expect(
      speakable('Sold out! '.repeat(200)).endsWith(
        'out! The rest is on screen.',
      ),
    ).toBe(true);
    expect(
      speakable('卖完了吗？'.repeat(200)).endsWith('吗？其余内容请看屏幕。'),
    ).toBe(true);
  });

  it('says < and > between numbers as words', () => {
    expect(speakable('Packs 5 > 3, top-ups 2<RM 10.\n> quoted 7')).toBe(
      'Packs 5 more than 3, top-ups 2 less than 10 ringgit.\n quoted 7',
    );
  });

  // A speech model reads "RM 12.50" in an English sentence as dollars
  // (tested 2026-10-29); "12 ringgit 50 sen" it reads right.
  it('says ringgit amounts as people say them', () => {
    expect(speakable('Paid RM12.50, RM 1,250, RM 0.05 and RM 7.5 in RM.')).toBe(
      'Paid 12 ringgit 50 sen, 1,250 ringgit, 5 sen and 7 ringgit 50 sen in ringgit.',
    );
    expect(speakable('Packs cost RM 10–RM 20, from RM 5 to RM 8.50.')).toBe(
      'Packs cost 10 to 20 ringgit, from 5 to 8.50 ringgit.',
    );
    // "to" only makes a range with a second amount in RM
    expect(speakable('RM 10 to 20 packs')).toBe('10 ringgit to 20 packs');
    expect(speakable('今天卖了 RM 3,480.20，退款 RM 0.50。')).toBe(
      '今天卖了 3,480令吉20仙，退款 50仙。',
    );
    expect(speakable('FORM 7 and RMB')).toBe('FORM 7 and RMB');
  });

  it('reads sums, scales, signs and stray decimals right', () => {
    // a spaced hyphen or an em dash is a sum or a pause, not a range
    expect(speakable('Net: RM 500 - RM 120 = RM 380.')).toBe(
      'Net: 500 ringgit - 120 ringgit = 380 ringgit.',
    );
    expect(speakable('RM 500 — 3 top-ups')).toBe('500 ringgit, 3 top-ups');
    expect(speakable('Packs RM 10-20 or RM 10 – RM 20')).toBe(
      'Packs 10 to 20 ringgit or 10 to 20 ringgit',
    );
    expect(
      speakable('Revenue RM 1.2k, RM 2.5 million, RM 3.5M, RM 1.2 juta.'),
    ).toBe(
      'Revenue 1.2 thousand ringgit, 2.5 million ringgit, 3.5 million ringgit, 1.2 juta ringgit.',
    );
    expect(speakable('Refund RM -12.50 and RM  7.')).toBe(
      'Refund minus 12 ringgit 50 sen and 7 ringgit.',
    );
    // more decimals than money has: left as written, never cut to 12.50
    expect(speakable('Rate RM 12.505 each')).toBe('Rate ringgit 12.505 each');
    expect(speakable('RM 5 bags')).toBe('5 ringgit bags');
  });

  it('keeps an English line English with a Chinese or Japanese name in it', () => {
    expect(speakable('Collector 小明 spent RM 50 today.')).toBe(
      'Collector 小明 spent 50 ringgit today.',
    );
    expect(speakable('Sold Pikachu ピカチュウ for RM 12.50')).toBe(
      'Sold Pikachu ピカチュウ for 12 ringgit 50 sen',
    );
    expect(
      speakable('最好的卡是 Charizard ex，价值 RM 89.90，价格 RM 10–RM 20。'),
    ).toBe('最好的卡是 Charizard ex，价值 89令吉90仙，价格 10至20令吉。');
    expect(speakable('今天收入 RM 3.5万')).toBe('今天收入 3.5万令吉');
  });

  it('cuts a long answer late, not at its first sentence', () => {
    const out = speakable(`Hi. ${'word '.repeat(400)}`);
    expect(out.length).toBeGreaterThan(1400);
    expect(out.endsWith('The rest is on screen.')).toBe(true);
  });
});

describe('transcribe', () => {
  it('sends the WAV as input_audio and gives back the words and cost', async () => {
    let sent: Record<string, unknown> = {};
    const fetchImpl = jest.fn(async (_url: unknown, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          usage: { cost: 0.0004 },
          choices: [{ message: { content: '  how many packs today? ' } }],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const out = await transcribe({
      key: 'k',
      model: 'google/gemini-3.5-flash-lite',
      wavBase64: 'UklGRg==',
      fetchImpl,
    });
    expect(out).toEqual({ text: 'how many packs today?', cost: 0.0004 });
    expect(sent.model).toBe('google/gemini-3.5-flash-lite');
    const user = (sent.messages as { role: string; content: unknown }[])[1];
    expect(user.content).toEqual([
      {
        type: 'input_audio',
        input_audio: { data: 'UklGRg==', format: 'wav' },
      },
    ]);
  });

  it('throws the provider message on a refusal', async () => {
    const fetchImpl = jest.fn(
      async () =>
        new Response(
          JSON.stringify({ error: { message: 'audio format not supported' } }),
          { status: 400 },
        ),
    ) as unknown as typeof fetch;
    await expect(
      transcribe({ key: 'k', model: 'm/x', wavBase64: 'AA==', fetchImpl }),
    ).rejects.toThrow('audio format not supported');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('tries once more after a network error or a busy provider', async () => {
    const ok = () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: 'hi' } }] }),
        { status: 200 },
      );
    const fetchImpl = jest
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockImplementationOnce(async () => ok());
    await expect(
      transcribe({
        key: 'k',
        model: 'm/x',
        wavBase64: 'AA==',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).resolves.toEqual({ text: 'hi', cost: 0 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const twice = jest.fn(
      async () => new Response('{}', { status: 503 }),
    ) as unknown as typeof fetch;
    await expect(
      transcribe({
        key: 'k',
        model: 'm/x',
        wavBase64: 'AA==',
        fetchImpl: twice,
      }),
    ).rejects.toThrow('OpenRouter answered 503.');
    expect(twice).toHaveBeenCalledTimes(2);
  });

  it('does not try again once the asker stopped', async () => {
    const ctl = new AbortController();
    const fetchImpl = jest.fn(async () => {
      ctl.abort();
      throw new DOMException('aborted', 'AbortError');
    }) as unknown as typeof fetch;
    await expect(
      transcribe({
        key: 'k',
        model: 'm/x',
        wavBase64: 'AA==',
        signal: ctl.signal,
        fetchImpl,
      }),
    ).rejects.toThrow('aborted');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('asks with the house words and digits for numbers', async () => {
    let sent: { messages: { content: string }[] } = { messages: [] };
    const fetchImpl = jest.fn(async (_url: unknown, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ choices: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    await transcribe({ key: 'k', model: 'm/x', wavBase64: 'AA==', fetchImpl });
    const prompt = sent.messages[0].content;
    for (const word of ['Polycards', 'Pokémon', 'Maybank', 'buyback', 'sen']) {
      expect(prompt).toContain(word);
    }
    expect(prompt).toMatch(/numbers .* as digits/);
  });
});

describe('speechPieces', () => {
  it('keeps a short answer in one piece', () => {
    expect(speechPieces('Sold 12 packs today. All good.')).toEqual([
      'Sold 12 packs today. All good.',
    ]);
  });

  it('starts with a short piece, then longer ones, cut at sentence ends', () => {
    const text = Array.from(
      { length: 20 },
      (_, i) => `Pack ${i + 1} sold 1,234.50 ringgit today.`,
    ).join(' ');
    const pieces = speechPieces(text);
    expect(pieces.length).toBeGreaterThan(2);
    expect(pieces[0].length).toBeLessThanOrEqual(120);
    for (const p of pieces.slice(1)) expect(p.length).toBeLessThanOrEqual(360);
    // the later pieces are the longer ones
    expect(Math.max(...pieces.slice(1).map((p) => p.length))).toBeGreaterThan(
      120,
    );
    // every piece ends a sentence, and nothing is lost or split in a number
    for (const p of pieces) expect(p).toMatch(/today\.$/);
    expect(pieces.join(' ')).toBe(text);
  });

  it('weighs Chinese by how long it takes to say', () => {
    const pieces = speechPieces('今天卖了很多卡。'.repeat(40));
    // 8 characters at 3 each: 5 sentences fit in the first 120
    expect(pieces[0]).toBe('今天卖了很多卡。'.repeat(5));
    expect(pieces.join('')).toBe('今天卖了很多卡。'.repeat(40));
  });

  it('cuts text with no pause anywhere by length, and loses nothing', () => {
    const text = '今天卖了很多卡'.repeat(20);
    const pieces = speechPieces(text);
    expect(pieces.map((p) => p.length)).toEqual([40, 100]);
    expect(pieces.join('')).toBe(text);
    // a Chinese comma is a pause
    const commas = '今天卖了很多卡，'.repeat(10);
    expect(speechPieces(commas)[0].endsWith('，')).toBe(true);
  });

  it('never cuts inside a number or a time', () => {
    for (let n = 100; n <= 115; n++) {
      const text = `${'x'.repeat(n)} total 12,345 ringgit at 10:30 today.`;
      for (const p of speechPieces(text)) {
        expect(p).not.toMatch(/(^|\D)\d{1,3},$|^\d{3}\b|\d:$|^\d{2} today/);
      }
      expect(speechPieces(text).join(' ')).toBe(text);
    }
  });

  it('cuts a sentence longer than a piece at a comma', () => {
    const long = `${'one card, '.repeat(30)}done.`;
    const pieces = speechPieces(long);
    expect(pieces[0].endsWith(',')).toBe(true);
    expect(pieces[0].length).toBeLessThanOrEqual(120);
    expect(pieces.join(' ')).toBe(long.replace(/, $/, ','));
  });
});

describe('speechChoiceProblem', () => {
  const list = jest.fn(
    async () =>
      new Response(
        JSON.stringify({
          data: [
            {
              id: 'google/gemini-3.8-flash-lite-tts',
              supported_voices: ['Kore', 'Puck'],
              pricing: { prompt: '0.0000005', completion: '0.000006' },
            },
            { id: 'fish-audio/s2-pro', supported_voices: null, pricing: {} },
          ],
        }),
      ),
  ) as unknown as typeof fetch;
  beforeEach(() => forgetSpeechModels());

  it('takes a listed speaking model and one of its voices', async () => {
    expect(
      await speechChoiceProblem(
        'google/gemini-3.8-flash-lite-tts',
        'Kore',
        list,
      ),
    ).toBeNull();
    // a model that lists no voices takes any well-formed one
    expect(
      await speechChoiceProblem('fish-audio/s2-pro', 'narrator', list),
    ).toBeNull();
  });

  it('refuses a chat voice model, another model’s voice and a malformed id', async () => {
    expect(
      await speechChoiceProblem('openai/gpt-audio-mini', 'alloy', list),
    ).toMatch(/not one of OpenRouter's speaking models/);
    expect(
      await speechChoiceProblem(
        'google/gemini-3.8-flash-lite-tts',
        'sarah',
        list,
      ),
    ).toMatch(/not a voice of/);
    expect(await speechChoiceProblem('gpt-5:online', 'Kore', list)).toMatch(
      /voice_model must be/,
    );
    expect(
      await speechChoiceProblem(
        'google/gemini-3.8-flash-lite-tts',
        'a b',
        list,
      ),
    ).toMatch(/voice must be/);
  });

  it('checks only the form while the list is out of reach', async () => {
    const down = jest.fn(async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    expect(
      await speechChoiceProblem('vendor/new-tts', 'Nova_2', down),
    ).toBeNull();
  });
});

describe('estimateSpeechCost', () => {
  it('prices characters in and 25 audio tokens a second out', () => {
    const gemini = { voices: null, prompt: 5e-7, completion: 6e-6 };
    expect(estimateSpeechCost(gemini, 100, 10)).toBeCloseTo(
      100 * 5e-7 + 250 * 6e-6,
      10,
    );
    // per-character voices
    expect(
      estimateSpeechCost(
        { voices: null, prompt: 4e-5, completion: 0 },
        300,
        20,
      ),
    ).toBeCloseTo(0.012, 10);
    // unknown price, or listed with none: the dearest per-character rate
    expect(estimateSpeechCost(undefined, 300, 20)).toBeCloseTo(0.03, 10);
    expect(
      estimateSpeechCost({ voices: null, prompt: 0, completion: 0 }, 300, 20),
    ).toBeCloseTo(0.03, 10);
    // a negative price (OpenRouter's -1 for "varies") never lowers the cap
    expect(
      estimateSpeechCost({ voices: null, prompt: -1, completion: -1 }, 300, 20),
    ).toBeCloseTo(0.03, 10);
  });
});

describe('speak', () => {
  // OpenRouter's /audio/speech: raw PCM bytes, the rate on the content type,
  // the generation id in a header.
  const pcm = (
    chunks: number[][],
    {
      type = 'audio/pcm;rate=24000;channels=1',
      gen = 'gen-1',
    }: { type?: string; gen?: string | null } = {},
  ) =>
    new Response(
      new ReadableStream({
        start(c) {
          for (const ch of chunks) c.enqueue(new Uint8Array(ch));
          c.close();
        },
      }),
      {
        status: 200,
        headers: {
          'content-type': type,
          ...(gen ? { 'x-generation-id': gen } : {}),
        },
      },
    );
  const collect = async (opts: Partial<Parameters<typeof speak>[0]>) => {
    const events: SpeechEvent[] = [];
    for await (const e of speak({
      key: 'k',
      model: 'google/gemini-3.8-flash-lite-tts',
      voice: 'Kore',
      text: 'Hi.',
      ...opts,
    })) {
      events.push(e);
    }
    return events;
  };
  const b64 = (bytes: number[]) => Buffer.from(bytes).toString('base64');

  it('reads piece by piece from /audio/speech: the rate once, the audio, each piece’s id', async () => {
    const sent: { url: string; body: Record<string, unknown> }[] = [];
    let n = 0;
    const fetchImpl = jest.fn(async (url: unknown, init?: RequestInit) => {
      sent.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      n++;
      return pcm(
        [
          [n, 0],
          [n, 1],
        ],
        { gen: `gen-${n}` },
      );
    }) as unknown as typeof fetch;
    const text =
      `Hello there. ${'This is a longer sentence that keeps going. '.repeat(4)}`.trim();
    const events = await collect({ text, fetchImpl });
    const pieces = speechPieces(text);
    expect(pieces).toHaveLength(2);
    expect(sent.map((s) => s.url)).toEqual([
      expect.stringMatching(/\/audio\/speech$/),
      expect.stringMatching(/\/audio\/speech$/),
    ]);
    expect(sent.map((s) => s.body)).toEqual(
      pieces.map((input) => ({
        model: 'google/gemini-3.8-flash-lite-tts',
        input,
        voice: 'Kore',
        response_format: 'pcm',
      })),
    );
    expect(events).toEqual([
      { type: 'piece' },
      { type: 'generation', id: 'gen-1' },
      { type: 'format', rate: 24000 },
      { type: 'audio', data: b64([1, 0]) },
      { type: 'audio', data: b64([1, 1]) },
      { type: 'piece' },
      { type: 'generation', id: 'gen-2' },
      { type: 'audio', data: b64([2, 0]) },
      { type: 'audio', data: b64([2, 1]) },
    ]);
  });

  it('takes the rate from the content type, 24 kHz when it names none', async () => {
    let fetchImpl = jest.fn(async () =>
      pcm([[1, 2]], { type: 'audio/pcm; rate=16000', gen: null }),
    ) as unknown as typeof fetch;
    const format = (events: SpeechEvent[]) =>
      events.find((e) => e.type === 'format');
    expect(format(await collect({ fetchImpl }))).toEqual({
      type: 'format',
      rate: 16000,
    });
    fetchImpl = jest.fn(async () =>
      pcm([[1, 2]], { type: 'audio/pcm' }),
    ) as unknown as typeof fetch;
    expect(format(await collect({ fetchImpl }))).toEqual({
      type: 'format',
      rate: 24000,
    });
  });

  it('names the billed piece, then refuses MP3 or L16 and closes the connection', async () => {
    for (const type of ['audio/mpeg', 'audio/L16;rate=24000']) {
      const cancel = jest.fn();
      const fetchImpl = jest.fn(
        async () =>
          new Response(new ReadableStream({ cancel }), {
            status: 200,
            headers: { 'content-type': type, 'x-generation-id': 'gen-mp3' },
          }),
      ) as unknown as typeof fetch;
      const events: SpeechEvent[] = [];
      await expect(
        (async () => {
          for await (const e of speak({
            key: 'k',
            model: 'm/x',
            voice: 'Kore',
            text: 'Hi.',
            fetchImpl,
          }))
            events.push(e);
        })(),
      ).rejects.toThrow(/not PCM/);
      expect(events).toEqual([
        { type: 'piece' },
        { type: 'generation', id: 'gen-mp3' },
      ]);
      expect(cancel).toHaveBeenCalled();
    }
  });

  it('closes the connection when the reader stops early', async () => {
    const cancel = jest.fn();
    const fetchImpl = jest.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new Uint8Array([1, 2]));
            },
            cancel,
          }),
          { status: 200, headers: { 'content-type': 'audio/pcm' } },
        ),
    ) as unknown as typeof fetch;
    for await (const e of speak({
      key: 'k',
      model: 'm/x',
      voice: 'Kore',
      text: 'Hi.',
      fetchImpl,
    })) {
      if (e.type === 'audio') break;
    }
    expect(cancel).toHaveBeenCalled();
  });

  it('refuses a model that sends MP3, and a rate that changes mid-answer', async () => {
    let fetchImpl = jest.fn(async () =>
      pcm([[1]], { type: 'audio/mpeg' }),
    ) as unknown as typeof fetch;
    await expect(collect({ fetchImpl })).rejects.toThrow(/not PCM/);
    let n = 0;
    fetchImpl = jest.fn(async () =>
      pcm([[1, 2]], {
        type: `audio/pcm;rate=${n++ ? 16000 : 24000}`,
      }),
    ) as unknown as typeof fetch;
    await expect(
      collect({
        fetchImpl,
        text: `Hi. ${'More words to say in a second piece here. '.repeat(4)}`,
      }),
    ).rejects.toThrow(/changed its sample rate/);
  });

  it("throws OpenRouter's message on a refusal, without retrying it", async () => {
    const fetchImpl = jest.fn(
      async () =>
        new Response(
          JSON.stringify({ error: { message: 'voice not available' } }),
          { status: 400 },
        ),
    ) as unknown as typeof fetch;
    await expect(collect({ fetchImpl })).rejects.toThrow('voice not available');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('tries once more when the provider is busy', async () => {
    const fetchImpl = jest
      .fn()
      .mockImplementationOnce(async () => new Response('{}', { status: 429 }))
      .mockImplementationOnce(async () =>
        pcm([[1, 2]]),
      ) as unknown as typeof fetch;
    const events = await collect({ fetchImpl });
    expect(events.filter((e) => e.type === 'audio')).toEqual([
      { type: 'audio', data: b64([1, 2]) },
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  describe('time bounds', () => {
    // A stream that sends what it is given, then nothing, and fails the way
    // fetch does when its signal aborts.
    const stalled = (...chunks: number[][]) =>
      jest.fn(async (_url: unknown, init?: RequestInit) => {
        const signal = init?.signal as AbortSignal;
        return new Response(
          new ReadableStream({
            start(c) {
              for (const ch of chunks) c.enqueue(new Uint8Array(ch));
              signal.addEventListener('abort', () => c.error(signal.reason));
            },
          }),
          { status: 200, headers: { 'content-type': 'audio/pcm' } },
        );
      }) as unknown as typeof fetch;
    const run = (fetchImpl: typeof fetch, signal?: AbortSignal) => {
      const events: SpeechEvent[] = [];
      const done = (async () => {
        for await (const e of speak({
          key: 'k',
          model: 'm/x',
          voice: 'Kore',
          text: 'Hi.',
          signal,
          fetchImpl,
        })) {
          events.push(e);
        }
      })();
      done.catch(() => undefined); // checked by each test
      return { events, done };
    };

    // Only the clock is faked: streams and promises run as usual.
    beforeEach(() =>
      jest.useFakeTimers({
        doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
      }),
    );
    afterEach(() => jest.useRealTimers());

    it('stops when no chunk arrives for 30 s', async () => {
      const r = run(stalled([1, 2]));
      let over = false;
      void r.done.finally(() => (over = true)).catch(() => undefined);
      await jest.advanceTimersByTimeAsync(29_000);
      expect(over).toBe(false); // not sooner
      expect(r.events.filter((e) => e.type === 'audio')).toEqual([
        { type: 'audio', data: b64([1, 2]) },
      ]);
      await jest.advanceTimersByTimeAsync(1_500);
      await expect(r.done).rejects.toThrow('no audio for 30 seconds');
    });

    it('stops a reading that runs past 3 minutes, even while chunks keep coming', async () => {
      const fetchImpl = jest.fn(async (_url: unknown, init?: RequestInit) => {
        const signal = init?.signal as AbortSignal;
        return new Response(
          new ReadableStream({
            start(c) {
              const tick = setInterval(
                () => c.enqueue(new Uint8Array([1, 2])),
                10_000,
              );
              signal.addEventListener('abort', () => {
                clearInterval(tick);
                c.error(signal.reason);
              });
            },
          }),
          { status: 200, headers: { 'content-type': 'audio/pcm' } },
        );
      }) as unknown as typeof fetch;
      const r = run(fetchImpl);
      let over = false;
      void r.done.finally(() => (over = true)).catch(() => undefined);
      await jest.advanceTimersByTimeAsync(170_000);
      expect(r.events.length).toBeGreaterThan(10);
      await jest.advanceTimersByTimeAsync(9_000);
      expect(over).toBe(false); // not before 3 minutes
      await jest.advanceTimersByTimeAsync(2_000);
      await expect(r.done).rejects.toThrow('longer than 3 minutes');
    });

    it("still stops on the asker's own signal", async () => {
      const ctl = new AbortController();
      const r = run(stalled(), ctl.signal);
      await jest.advanceTimersByTimeAsync(1_000);
      ctl.abort();
      await expect(r.done).rejects.toThrow();
      expect(jest.getTimerCount()).toBe(0); // no timer left behind
    });
  });
});

describe('speechModels', () => {
  const list = (data: object[]) =>
    jest.fn(
      async () => new Response(JSON.stringify({ data })),
    ) as unknown as typeof fetch;
  const one = [
    { id: 'google/gemini-3.8-flash-lite-tts', supported_voices: ['Kore'] },
  ];
  beforeEach(() => {
    forgetSpeechModels();
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  });
  afterEach(() => jest.useRealTimers());

  it('keeps the list an hour', async () => {
    const fetchImpl = list(one);
    await speechModels(fetchImpl);
    jest.advanceTimersByTime(59 * 60_000);
    await speechModels(fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(2 * 60_000);
    await speechModels(fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('keeps a failed fetch a minute, then tries again', async () => {
    const down = jest.fn(async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    expect(await speechModels(down)).toBeNull();
    await speechModels(down);
    expect(down).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(61_000);
    await speechModels(down);
    expect(down).toHaveBeenCalledTimes(2);
  });

  it('keeps the last good list through a failure or an empty list, retrying each minute', async () => {
    await speechModels(list(one));
    jest.advanceTimersByTime(61 * 60_000);
    const empty = list([]);
    const kept = await speechModels(empty);
    expect(kept?.get('google/gemini-3.8-flash-lite-tts')?.voices).toEqual([
      'Kore',
    ]);
    // still refuses another model's voice from the kept list
    expect(
      await speechChoiceProblem('google/gemini-3.8-flash-lite-tts', 'sarah'),
    ).toMatch(/not a voice of/);
    jest.advanceTimersByTime(61_000);
    await speechModels(empty);
    expect(empty).toHaveBeenCalledTimes(2);
  });

  it('treats an empty first list as no list', async () => {
    expect(await speechModels(list([]))).toBeNull();
  });
});

describe('generationCost', () => {
  beforeEach(() =>
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] }),
  );
  afterEach(() => jest.useRealTimers());

  it('keeps looking while the generation is not found yet', async () => {
    const cancel = jest.fn();
    let n = 0;
    const fetchImpl = jest.fn(async () =>
      ++n <= 4
        ? new Response(new ReadableStream({ cancel }), { status: 404 })
        : new Response(JSON.stringify({ data: { total_cost: 0.002 } })),
    ) as unknown as typeof fetch;
    const found = generationCost('k', 'gen-1', fetchImpl, 12);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(await found).toBe(0.002);
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(cancel).toHaveBeenCalledTimes(4); // each 404 let go
    n = 0;
    const gaveUp = generationCost('k', 'gen-1', fetchImpl);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(await gaveUp).toBe(0); // the default 2 tries
  });

  it('never returns a negative cost', async () => {
    const fetchImpl = jest.fn(
      async () => new Response(JSON.stringify({ data: { total_cost: -1 } })),
    ) as unknown as typeof fetch;
    expect(await generationCost('k', 'gen-1', fetchImpl)).toBe(0);
  });
});
