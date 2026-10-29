import { speak, speakable, transcribe, type SpeechEvent } from '../voice';

const sse = (...chunks: object[]) =>
  new Response(
    new ReadableStream({
      start(c) {
        const enc = new TextEncoder();
        for (const ch of chunks) {
          c.enqueue(enc.encode(`data: ${JSON.stringify(ch)}\n\n`));
        }
        c.enqueue(enc.encode('data: [DONE]\n\n'));
        c.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );

describe('speakable', () => {
  it('reads a table row by row with its headings, without symbols', () => {
    expect(
      speakable(
        '**Today** (default group):\n\n| Item | Amount |\n|---|---:|\n| Revenue | RM 0.00 |\n| Payouts | RM 1.50 |\n\nNothing opened yet.',
      ),
    ).toBe(
      'Today (default group):\nRevenue, Amount RM 0.00.\nPayouts, Amount RM 1.50.\nNothing opened yet.',
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
      'Revenue, Amount RM 1,234.50.\nPayouts, Note a, b.\nTop-up, up 10, 12, packs 10–20.',
    );
    // One ~ means "about" and is kept; a Chinese —— is one pause.
    expect(speakable('Sold ~RM 50——不错')).toBe('Sold ~RM 50, 不错');
  });

  it('cuts Chinese at a full stop', () => {
    const out = speakable('今天卖了很多卡。'.repeat(300));
    expect(out.endsWith('。 The rest is on screen.')).toBe(true);
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

describe('speak', () => {
  it('asks for pcm16 audio in the set voice and streams the chunks and cost', async () => {
    let sent: Record<string, unknown> = {};
    const fetchImpl = jest.fn(async (_url: unknown, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body));
      return sse(
        { id: 'gen-1', choices: [{ delta: { audio: { data: 'AAA=' } } }] },
        { choices: [{ delta: { audio: { transcript: 'Hi' } } }] },
        { choices: [{ delta: { audio: { data: 'BBB=' } } }] },
        {
          choices: [],
          usage: { cost: 0.002, prompt_tokens: 40, completion_tokens: 300 },
        },
      );
    }) as unknown as typeof fetch;
    const events: SpeechEvent[] = [];
    for await (const e of speak({
      key: 'k',
      model: 'openai/gpt-audio-mini',
      voice: 'nova',
      text: 'Hi',
      fetchImpl,
    })) {
      events.push(e);
    }
    expect(sent).toMatchObject({
      model: 'openai/gpt-audio-mini',
      modalities: ['text', 'audio'],
      audio: { voice: 'nova', format: 'pcm16' },
      stream: true,
    });
    expect(events).toEqual([
      { type: 'generation', id: 'gen-1' },
      { type: 'audio', data: 'AAA=' },
      { type: 'audio', data: 'BBB=' },
      { type: 'usage', cost: 0.002, tokensIn: 40, tokensOut: 300 },
    ]);
  });

  it('throws an error chunk', async () => {
    const fetchImpl = jest.fn(async () =>
      sse({ error: { message: 'voice not available', code: 400 } }),
    ) as unknown as typeof fetch;
    const run = async () => {
      for await (const e of speak({
        key: 'k',
        model: 'm/x',
        voice: 'alloy',
        text: 'Hi',
        fetchImpl,
      })) {
        void e;
      }
    };
    await expect(run()).rejects.toThrow('voice not available');
    // Audio may already have played: an error mid-stream is never retried.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('tries once more when the provider is busy before any audio', async () => {
    const fetchImpl = jest
      .fn()
      .mockImplementationOnce(async () => new Response('{}', { status: 429 }))
      .mockImplementationOnce(async () =>
        sse({ choices: [{ delta: { audio: { data: 'AAA=' } } }] }),
      ) as unknown as typeof fetch;
    const events: SpeechEvent[] = [];
    for await (const e of speak({
      key: 'k',
      model: 'm/x',
      voice: 'alloy',
      text: 'Hi',
      fetchImpl,
    })) {
      events.push(e);
    }
    expect(events).toEqual([{ type: 'audio', data: 'AAA=' }]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
