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
      'Packs 5 more than 3, top-ups 2 less than RM 10.\n quoted 7',
    );
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
      voice: 'coral',
      text: 'Hi',
      fetchImpl,
    })) {
      events.push(e);
    }
    expect(sent).toMatchObject({
      model: 'openai/gpt-audio-mini',
      modalities: ['text', 'audio'],
      audio: { voice: 'coral', format: 'pcm16' },
      stream: true,
      // Bounded by what the text takes to say: 2 letters.
      max_tokens: 2 * 4 + 200,
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

  it('gives Chinese text a bigger token budget', async () => {
    let sent: Record<string, unknown> = {};
    const fetchImpl = jest.fn(async (_url: unknown, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body));
      return sse({ choices: [] });
    }) as unknown as typeof fetch;
    for await (const e of speak({
      key: 'k',
      model: 'm/x',
      voice: 'alloy',
      text: '你好。',
      fetchImpl,
    })) {
      void e;
    }
    expect(sent.max_tokens).toBe((3 + 3 + 1) * 4 + 200);
  });

  describe('time bounds', () => {
    const line = (ch: object) =>
      new TextEncoder().encode(`data: ${JSON.stringify(ch)}\n\n`);
    const audio = { choices: [{ delta: { audio: { data: 'AAA=' } } }] };
    // A stream that sends what it is given, then nothing, and fails the way
    // fetch does when its signal aborts.
    const stalled = (...chunks: object[]) =>
      jest.fn(async (_url: unknown, init?: RequestInit) => {
        const signal = init?.signal as AbortSignal;
        return new Response(
          new ReadableStream({
            start(c) {
              for (const ch of chunks) c.enqueue(line(ch));
              signal.addEventListener('abort', () => c.error(signal.reason));
            },
          }),
          { status: 200 },
        );
      }) as unknown as typeof fetch;
    const run = (fetchImpl: typeof fetch, signal?: AbortSignal) => {
      const events: SpeechEvent[] = [];
      const done = (async () => {
        for await (const e of speak({
          key: 'k',
          model: 'm/x',
          voice: 'alloy',
          text: 'Hi',
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
      const r = run(stalled(audio));
      await jest.advanceTimersByTimeAsync(29_000);
      expect(r.events).toEqual([{ type: 'audio', data: 'AAA=' }]);
      await jest.advanceTimersByTimeAsync(1_500);
      await expect(r.done).rejects.toThrow('no audio for 30 seconds');
    });

    it('stops a reading that runs past 3 minutes, even while chunks keep coming', async () => {
      const fetchImpl = jest.fn(async (_url: unknown, init?: RequestInit) => {
        const signal = init?.signal as AbortSignal;
        return new Response(
          new ReadableStream({
            start(c) {
              const tick = setInterval(() => c.enqueue(line(audio)), 10_000);
              signal.addEventListener('abort', () => {
                clearInterval(tick);
                c.error(signal.reason);
              });
            },
          }),
          { status: 200 },
        );
      }) as unknown as typeof fetch;
      const r = run(fetchImpl);
      await jest.advanceTimersByTimeAsync(170_000);
      expect(r.events.length).toBeGreaterThan(10);
      await jest.advanceTimersByTimeAsync(11_000);
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
