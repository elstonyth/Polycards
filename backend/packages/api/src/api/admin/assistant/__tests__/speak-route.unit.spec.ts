import { EventEmitter } from 'node:events';
import { DELETE } from '../conversations/[id]/route';
import { generationCost, OpenRouterError, speechModels } from '../openrouter';
import { POST } from '../speak/route';
import { speak, speakable, type SpeechEvent } from '../voice';

// POST /admin/assistant/speak with the service, the speaking model, the file
// store and the fetcher faked: the speech cache, the one-at-a-time slot and
// the cost row on every path (an estimate at once, OpenRouter's figure
// after). And DELETE of a chat deleting its speech.

jest.mock('../access', () => ({
  accessFor: (_scope: unknown, auth: { actor_id: string }) => ({
    userId: auth.actor_id,
  }),
}));
jest.mock('../openrouter', () => ({
  ...jest.requireActual('../openrouter'),
  generationCost: jest.fn(),
  speechModels: jest.fn(),
}));
jest.mock('../voice', () => ({
  ...jest.requireActual('../voice'),
  speak: jest.fn(),
}));
jest.mock('../../../../modules/assistant', () => ({
  ASSISTANT_MODULE: 'assistant',
}));
jest.mock('../../../../modules/assistant/key-vault', () => ({
  openKey: () => 'sk-or-test',
}));

const speakMock = speak as jest.MockedFunction<typeof speak>;
const costMock = generationCost as jest.MockedFunction<typeof generationCost>;
const listMock = speechModels as jest.MockedFunction<typeof speechModels>;
const MODEL = 'google/gemini-3.8-flash-lite-tts';
const LIST = new Map([
  [MODEL, { voices: ['Kore', 'Puck'], prompt: 1e-5, completion: 0 }],
  [
    'elevenlabs/eleven-flash-v2.5',
    { voices: ['sarah'], prompt: 4e-5, completion: 0 },
  ],
]);
const settled = () => new Promise((r) => setImmediate(r));

const answerRow = {
  id: 'aimsg_1',
  conversation_id: 'conv_1',
  content: 'Revenue today is RM 1,234.50.',
};
// Priced per character only: a reading is estimated at once at its whole
// text's length x 0.00001, whatever was heard.
const TEXT_LEN = speakable(answerRow.content).length;
const EST = TEXT_LEN * 1e-5;
const conversations = [
  { id: 'conv_1', user_id: 'user_1' },
  { id: 'conv_2', user_id: 'user_2' },
];
type Row = {
  conversation_id: string;
  role: string;
  tools: unknown;
  cost_usd?: number;
};
const cacheRow = (
  over: Partial<{
    message_id: string;
    voice_model: string;
    voice: string;
    rate: number;
  }>,
  file_id = 'file_a',
): Row => ({
  conversation_id: 'conv_1',
  role: 'voice',
  tools: {
    message_id: 'aimsg_1',
    voice_model: MODEL,
    voice: 'Kore',
    file_id,
    ...over,
  },
});
// Voice rows: seeded per test, and every row the route saves.
let rows: Row[] = [];
let stored: Record<string, Buffer> = {};
let settings: Record<string, unknown> = {};

const service = {
  listAssistantMessages: jest.fn(
    async (filter: { id?: string; role: string; conversation_id?: string }) =>
      filter.role === 'voice'
        ? rows.filter(
            (r) =>
              r.role === 'voice' &&
              r.conversation_id === filter.conversation_id,
          )
        : filter.id === answerRow.id
          ? [answerRow]
          : [],
  ),
  listAssistantConversations: jest.fn(
    async (filter: { id: string; user_id: string }) =>
      conversations.filter(
        (c) => c.id === filter.id && c.user_id === filter.user_id,
      ),
  ),
  settings: jest.fn(async () => settings),
  // What the saved rows cost, like the real one sums today's voice rows.
  spentToday: jest.fn(async () =>
    rows.reduce((sum, r) => sum + Number(r.cost_usd ?? 0), 0),
  ),
  createAssistantMessages: jest.fn(async (row: Row) => {
    rows.push(row);
    return { id: 'aimsg_v' };
  }),
  updateAssistantConversations: jest.fn(async () => ({})),
  updateAssistantMessages: jest.fn(async () => ({})),
  softDeleteAssistantConversations: jest.fn(async () => undefined),
};
const files = {
  getAsBuffer: jest.fn(async (id: string) => {
    if (!stored[id]) throw new Error('NoSuchKey');
    return stored[id];
  }),
  createFiles: jest.fn(async (_f: Record<string, unknown>) => ({
    id: 'file_new',
    url: 'https://cdn.example/private/file_new.pcm',
  })),
  deleteFiles: jest.fn(async (_ids: string[]) => undefined),
};
const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
const scope = {
  resolve: (name: string) =>
    name === 'assistant'
      ? service
      : name === 'file'
        ? files
        : name === 'configModule'
          ? { projectConfig: { http: { jwtSecret: 's' } } }
          : logger,
};

let lastRes: EventEmitter;
function post(user = 'user_1') {
  const lines: string[] = [];
  let status = 200;
  const res = Object.assign(new EventEmitter(), {
    writableEnded: false,
    writableFinished: false,
    status(code: number) {
      status = code;
      return this;
    },
    json(body: unknown) {
      lines.push(JSON.stringify(body));
    },
    setHeader: () => undefined,
    flushHeaders: () => undefined,
    write(chunk: string) {
      lines.push(chunk.trim());
      return true;
    },
    end() {
      this.writableEnded = true;
    },
  });
  lastRes = res;
  const req = {
    body: { message_id: 'aimsg_1' },
    auth_context: { actor_id: user },
    scope,
  };
  const done = POST(req as never, res as never);
  return {
    done,
    status: () => status,
    events: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

const b64 = (bytes: number[]) => Buffer.from(bytes).toString('base64');
async function* spoken(): AsyncGenerator<SpeechEvent> {
  yield { type: 'generation', id: 'gen-1' };
  yield { type: 'format', rate: 24000 };
  yield { type: 'audio', data: b64([1, 2, 3, 4]) };
  yield { type: 'audio', data: b64([5, 6]) };
}
const audioOf = (events: Record<string, unknown>[]) =>
  Buffer.concat(
    events
      .filter((e) => e.type === 'audio')
      .map((e) => Buffer.from(String(e.data), 'base64')),
  );
const savedRows = () =>
  service.createAssistantMessages.mock.calls.map(([r]) => r);

beforeEach(() => {
  jest.clearAllMocks();
  rows = [];
  stored = {};
  settings = {
    openrouter_key_sealed: 'sealed',
    daily_cap_usd: 5,
    voice_model: MODEL,
    voice: 'Kore',
  };
  speakMock.mockImplementation(spoken);
  costMock.mockResolvedValue(0);
  listMock.mockResolvedValue(LIST);
});
// A failed test must not leave fake timers behind for the next one.
afterEach(() => jest.useRealTimers());

it('speaks, stores the speech privately and records which file with the cost', async () => {
  // Same answer in another voice, another model or another answer: no match.
  rows = [
    cacheRow({ voice: 'Puck' }, 'file_alloy'),
    cacheRow({ voice_model: 'elevenlabs/eleven-flash-v2.5' }, 'file_model'),
    cacheRow({ message_id: 'aimsg_2' }, 'file_other'),
  ];
  stored = {
    file_alloy: Buffer.from([9]),
    file_model: Buffer.from([9]),
    file_other: Buffer.from([9]),
  };
  const p = post();
  await p.done;
  expect(service.listAssistantMessages).toHaveBeenCalledWith(
    { conversation_id: 'conv_1', role: 'voice' },
    expect.objectContaining({ select: ['tools'] }),
  );
  expect(files.getAsBuffer).not.toHaveBeenCalled();
  expect(speakMock).toHaveBeenCalledTimes(1);
  expect(audioOf(p.events())).toEqual(Buffer.from([1, 2, 3, 4, 5, 6]));
  expect(files.createFiles).toHaveBeenCalledWith({
    filename: 'assistant-voice-aimsg_1.pcm',
    mimeType: 'application/octet-stream',
    content: Buffer.from([1, 2, 3, 4, 5, 6]).toString('base64'),
    access: 'private',
  });
  expect(service.createAssistantMessages).toHaveBeenCalledWith(
    expect.objectContaining({
      role: 'voice',
      cost_usd: EST,
      error: null,
      tools: {
        message_id: 'aimsg_1',
        voice_model: MODEL,
        voice: 'Kore',
        file_id: 'file_new',
        rate: 24000,
      },
    }),
  );
  expect(p.events()[0]).toEqual({ type: 'format', rate: 24000 });
  expect(p.events().at(-1)).toEqual({ type: 'done', cost_usd: EST });
});

it("puts OpenRouter's figure in place of the estimate once it arrives", async () => {
  costMock.mockResolvedValueOnce(0.0012).mockResolvedValueOnce(0.0009);
  speakMock.mockImplementationOnce(async function* () {
    yield* spoken();
    yield { type: 'generation', id: 'gen-2' };
    yield { type: 'audio', data: b64([7, 8]) };
  });
  const p = post();
  await p.done;
  // counted at once, before the figure: the whole text
  expect(savedRows()[0]).toMatchObject({ cost_usd: EST });
  await settled();
  expect(costMock).toHaveBeenCalledWith('sk-or-test', 'gen-1', undefined, 12);
  expect(costMock).toHaveBeenCalledWith('sk-or-test', 'gen-2', undefined, 12);
  expect(service.updateAssistantMessages).toHaveBeenCalledWith({
    id: 'aimsg_v',
    cost_usd: 0.0021,
  });
});

it('keeps the estimate when a piece’s figure cannot be found', async () => {
  costMock.mockResolvedValueOnce(0.0012).mockResolvedValueOnce(0);
  speakMock.mockImplementationOnce(async function* () {
    yield* spoken();
    yield { type: 'generation', id: 'gen-2' };
  });
  await post().done;
  await settled();
  expect(service.updateAssistantMessages).not.toHaveBeenCalled();
  expect(logger.warn).toHaveBeenCalledWith(
    expect.stringContaining('estimate kept'),
  );
});

it('estimates at the dearest per-character price when the model’s price is unknown', async () => {
  listMock.mockResolvedValue(null); // OpenRouter's list out of reach
  await post().done;
  expect(savedRows()[0]).toMatchObject({ cost_usd: TEXT_LEN * 0.00004 });
});

it('bumps last_message_at before speaking, so the cost counts today', async () => {
  const p = post();
  await p.done;
  expect(service.updateAssistantConversations).toHaveBeenCalledWith({
    id: 'conv_1',
    last_message_at: expect.any(Date),
  });
  expect(
    service.updateAssistantConversations.mock.invocationCallOrder[0],
  ).toBeLessThan(speakMock.mock.invocationCallOrder[0]);
});

it('plays stored speech again for free, read through the file module, in ~24 KB chunks', async () => {
  rows = [cacheRow({ voice: 'Puck' }, 'file_alloy'), cacheRow({})];
  stored = { file_a: Buffer.alloc(30_000, 7) };
  const p = post();
  await p.done;
  expect(files.getAsBuffer).toHaveBeenCalledWith('file_a');
  // stored before the rate was kept: 24 kHz
  expect(p.events()[0]).toEqual({ type: 'format', rate: 24000 });
  const audio = p.events().filter((e) => e.type === 'audio');
  expect(audio).toHaveLength(2);
  expect(audioOf(p.events())).toEqual(stored.file_a);
  expect(p.events().at(-1)).toEqual({ type: 'done', cost_usd: 0 });
  expect(speakMock).not.toHaveBeenCalled();
  expect(service.spentToday).not.toHaveBeenCalled();
  expect(service.createAssistantMessages).not.toHaveBeenCalled();
});

it('speaks again when the stored speech cannot be read', async () => {
  rows = [cacheRow({}, 'file_gone')];
  const p = post();
  await p.done;
  expect(files.getAsBuffer).toHaveBeenCalledWith('file_gone');
  expect(speakMock).toHaveBeenCalledTimes(1);
  expect(service.createAssistantMessages).toHaveBeenCalledWith(
    expect.objectContaining({
      cost_usd: EST,
      tools: expect.objectContaining({ file_id: 'file_new' }),
    }),
  );
  expect(p.events().at(-1)).toEqual({ type: 'done', cost_usd: EST });
});

it("404s someone else's answer before looking at any stored speech", async () => {
  rows = [cacheRow({})];
  stored = { file_a: Buffer.from([1]) };
  // user_2 has chats of their own, just not this one.
  const p = post('user_2');
  await p.done;
  expect(service.listAssistantConversations).toHaveBeenCalledWith(
    { id: 'conv_1', user_id: 'user_2' },
    { take: 1 },
  );
  expect(p.status()).toBe(404);
  expect(files.getAsBuffer).not.toHaveBeenCalled();
  expect(service.listAssistantMessages).not.toHaveBeenCalledWith(
    expect.objectContaining({ role: 'voice' }),
    expect.anything(),
  );
  expect(speakMock).not.toHaveBeenCalled();
});

it('stops at the daily cap: no speech, no row, and the slot is free again', async () => {
  rows = [
    { conversation_id: 'conv_9', role: 'voice', tools: null, cost_usd: 5 },
  ];
  const p = post();
  await p.done;
  expect(p.events()).toEqual([
    expect.objectContaining({ type: 'error', code: 'daily_cap' }),
  ]);
  expect(speakMock).not.toHaveBeenCalled();
  expect(service.createAssistantMessages).not.toHaveBeenCalled();
  expect(service.updateAssistantConversations).not.toHaveBeenCalled();
  // The slot was let go: the next read does not wait or answer busy.
  rows = [];
  const next = post();
  await next.done;
  expect(next.events().at(-1)).toEqual({ type: 'done', cost_usd: EST });
});

it("counts the last reading's cost toward the cap of the next", async () => {
  settings.daily_cap_usd = EST;
  const first = post();
  await first.done;
  expect(first.events().at(-1)).toEqual({ type: 'done', cost_usd: EST });
  // Its stored speech can't be read back (nothing is stored): it would have
  // to speak again.
  const second = post();
  await second.done;
  expect(second.events()).toEqual([
    expect.objectContaining({ type: 'error', code: 'daily_cap' }),
  ]);
  expect(speakMock).toHaveBeenCalledTimes(1);
});

it('answers busy while the same person is already being read to', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  speakMock.mockImplementationOnce(async function* () {
    yield { type: 'generation', id: 'gen-1' };
    yield { type: 'format', rate: 24000 };
    yield { type: 'audio', data: b64([1]) };
    await gate;
  });
  const first = post();
  try {
    while (!speakMock.mock.calls.length) {
      await new Promise((r) => setImmediate(r));
    }
    // The first reading holds the slot past the ~10 s wait.
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    const second = post();
    await jest.advanceTimersByTimeAsync(10_200);
    await second.done;
    jest.useRealTimers();
    expect(second.events()).toEqual([
      expect.objectContaining({ type: 'error', code: 'busy' }),
    ]);
  } finally {
    release(); // never leave the module's slot taken for the next test
    await first.done;
  }
  expect(first.events().at(-1)).toEqual({ type: 'done', cost_usd: EST });
  // The slot is free again: the first one's speech can't be read back
  // (nothing is stored), so the third speaks without waiting.
  const third = post();
  await third.done;
  expect(third.events().at(-1)).toEqual({ type: 'done', cost_usd: EST });
});

it('waits for the slot while the last reading still saves its cost', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  service.createAssistantMessages.mockImplementationOnce(async (row: Row) => {
    await gate;
    rows.push({ ...row, tools: null }); // stored nothing to replay
    return { id: 'aimsg_v' };
  });
  const first = post();
  let second: ReturnType<typeof post> | undefined;
  try {
    while (!service.createAssistantMessages.mock.calls.length) {
      await new Promise((r) => setImmediate(r));
    }
    second = post();
    await new Promise((r) => setTimeout(r, 300));
    // Still waiting: not busy, not speaking yet.
    expect(second.events()).toEqual([]);
    expect(speakMock).toHaveBeenCalledTimes(1);
    // One who leaves while waiting stops waiting.
    const third = post();
    const thirdRes = lastRes;
    await new Promise((r) => setTimeout(r, 50)); // now waiting for the slot
    thirdRes.emit('close');
    await third.done;
    expect(third.events()).toEqual([]);
  } finally {
    release();
    await first.done;
    await second?.done;
  }
  expect(speakMock).toHaveBeenCalledTimes(2);
  expect(second?.events().at(-1)).toEqual({ type: 'done', cost_usd: EST });
});

it('replays what the reading it waited for stored, instead of paying again', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  speakMock.mockImplementationOnce(async function* () {
    yield* spoken();
    await gate;
  });
  stored = { file_new: Buffer.from([1, 2, 3, 4, 5, 6]) };
  const first = post();
  let second: ReturnType<typeof post> | undefined;
  try {
    while (!speakMock.mock.calls.length) {
      await new Promise((r) => setImmediate(r));
    }
    second = post(); // same answer, same voice: waits for the slot
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    release();
    await first.done;
    await second?.done;
  }
  expect(speakMock).toHaveBeenCalledTimes(1);
  expect(service.createAssistantMessages).toHaveBeenCalledTimes(1);
  expect(audioOf(second?.events() ?? [])).toEqual(stored.file_new);
  expect(second?.events().at(-1)).toEqual({ type: 'done', cost_usd: 0 });
});

it('still charges what was sent when the listener stops mid-stream, and stores nothing', async () => {
  costMock.mockResolvedValue(0.0018);
  speakMock.mockImplementationOnce(async function* (opts) {
    yield { type: 'generation', id: 'gen-9' };
    yield { type: 'format', rate: 24000 };
    yield { type: 'audio', data: b64([1, 2]) };
    lastRes.emit('close'); // the admin stops listening
    opts.signal?.throwIfAborted();
  });
  const p = post();
  await p.done;
  expect(files.createFiles).not.toHaveBeenCalled();
  expect(service.createAssistantMessages).toHaveBeenCalledWith(
    expect.objectContaining({
      role: 'voice',
      cost_usd: EST,
      tools: null,
      error: null,
    }),
  );
  await settled();
  expect(service.updateAssistantMessages).toHaveBeenCalledWith({
    id: 'aimsg_v',
    cost_usd: 0.0018,
  });
});

it('counts the whole text even when OpenRouter names no generation', async () => {
  speakMock.mockImplementationOnce(async function* () {
    yield { type: 'format', rate: 24000 };
    yield { type: 'audio', data: b64([1, 2]) };
  });
  await post().done;
  expect(savedRows()[0]).toMatchObject({ cost_usd: EST });
  await settled();
  expect(costMock).not.toHaveBeenCalled();
});

it('charges nothing only for a reading OpenRouter refused outright', async () => {
  speakMock.mockImplementationOnce(async function* () {
    yield* [];
    throw new OpenRouterError('voice not available', 400);
  });
  const p = post();
  await p.done;
  expect(savedRows()[0]).toMatchObject({
    cost_usd: 0,
    error: 'voice not available',
  });
  expect(p.events().at(-1)).toMatchObject({ code: 'speak_failed' });
});

it('still estimates a reading that timed out or was stopped before any sound', async () => {
  // a timeout: the request may have been generated and billed
  speakMock.mockImplementationOnce(async function* () {
    yield* [];
    throw new DOMException('The operation timed out.', 'TimeoutError');
  });
  await post().done;
  // a provider error with no answer status, then a stop before any audio
  speakMock.mockImplementationOnce(async function* () {
    yield* [];
    throw new OpenRouterError('upstream reset');
  });
  await post().done;
  speakMock.mockImplementationOnce(async function* (opts) {
    lastRes.emit('close');
    opts.signal?.throwIfAborted();
    yield* [];
  });
  await post().done;
  expect(savedRows().map((r) => r.cost_usd)).toEqual([EST, EST, EST]);
});

it("saves the cost and passes on OpenRouter's reason when speaking fails", async () => {
  speakMock.mockImplementationOnce(async function* () {
    yield { type: 'generation', id: 'gen-3' };
    yield { type: 'format', rate: 24000 };
    yield { type: 'audio', data: b64([1, 2]) };
    // A timeout inside speak() fails the same way; the key never shows.
    throw new Error('voice not available for key sk-or-test');
  });
  const p = post();
  await p.done;
  expect(files.createFiles).not.toHaveBeenCalled();
  expect(savedRows()).toEqual([
    expect.objectContaining({
      cost_usd: EST,
      tools: null,
      error: 'voice not available for key [key]',
    }),
  ]);
  expect(p.events().at(-1)).toEqual({
    type: 'error',
    code: 'speak_failed',
    message: 'Could not read it aloud: voice not available for key [key]',
    reason: 'voice not available for key [key]',
  });
});

it('answers no_audio when the voice sent no sound, keeps the cost and stores nothing', async () => {
  speakMock.mockImplementationOnce(async function* () {
    yield { type: 'generation', id: 'gen-4' };
    yield { type: 'format', rate: 24000 };
  });
  const p = post();
  await p.done;
  expect(files.createFiles).not.toHaveBeenCalled();
  expect(savedRows()).toEqual([
    expect.objectContaining({ cost_usd: EST, tools: null, error: null }),
  ]);
  expect(p.events().at(-1)).toMatchObject({ type: 'error', code: 'no_audio' });
});

it('ends the stream with speak_failed when the database throws, and frees the slot', async () => {
  service.spentToday.mockRejectedValueOnce(new Error('connection lost'));
  const p = post();
  await p.done;
  expect(p.events()).toEqual([
    {
      type: 'error',
      code: 'speak_failed',
      message: 'Could not read it aloud.',
    },
  ]);
  expect(speakMock).not.toHaveBeenCalled();
  const next = post();
  await next.done;
  expect(next.events().at(-1)).toEqual({ type: 'done', cost_usd: EST });
});

it('answers bad_voice_model for a voice the model lacks, or a chat voice model', async () => {
  settings.voice = 'robot';
  let p = post();
  await p.done;
  expect(p.events()).toEqual([
    expect.objectContaining({ type: 'error', code: 'bad_voice_model' }),
  ]);
  // answered what it was given to read, 2026-10-29: not a speaking model
  settings = {
    ...settings,
    voice_model: 'openai/gpt-audio-mini',
    voice: 'alloy',
  };
  p = post();
  await p.done;
  expect(p.events()).toEqual([
    expect.objectContaining({
      type: 'error',
      code: 'bad_voice_model',
      reason: expect.stringMatching(/not one of OpenRouter/),
    }),
  ]);
  expect(speakMock).not.toHaveBeenCalled();
});

it('plays a stored reading at the rate it was made at', async () => {
  rows = [cacheRow({ rate: 16000 })];
  stored = { file_a: Buffer.from([1, 2]) };
  const p = post();
  await p.done;
  expect(p.events()[0]).toEqual({ type: 'format', rate: 16000 });
});

describe('DELETE /admin/assistant/conversations/:id', () => {
  const del = async (user: string, id: string) => {
    let status = 200;
    let body: unknown;
    const res = {
      status(code: number) {
        status = code;
        return this;
      },
      json(b: unknown) {
        body = b;
      },
    };
    await DELETE(
      { params: { id }, auth_context: { actor_id: user }, scope } as never,
      res as never,
    );
    return { status, body };
  };

  it("deletes the chat's stored speech files", async () => {
    rows = [
      cacheRow({}, 'file_a'),
      cacheRow({ voice: 'Puck' }, 'file_b'),
      { conversation_id: 'conv_1', role: 'voice', tools: null },
      { ...cacheRow({}, 'file_x'), conversation_id: 'conv_2' },
    ];
    const out = await del('user_1', 'conv_1');
    expect(out).toEqual({ status: 200, body: { id: 'conv_1', deleted: true } });
    expect(service.softDeleteAssistantConversations).toHaveBeenCalledWith([
      'conv_1',
    ]);
    expect(files.deleteFiles).toHaveBeenCalledWith(['file_a', 'file_b']);
  });

  it('still deletes the chat when the files cannot be deleted', async () => {
    rows = [cacheRow({})];
    files.deleteFiles.mockRejectedValueOnce(new Error('S3 down'));
    const out = await del('user_1', 'conv_1');
    expect(out.body).toEqual({ id: 'conv_1', deleted: true });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('S3 down'),
    );
  });

  it("deletes nothing of someone else's chat", async () => {
    rows = [cacheRow({})];
    const out = await del('user_2', 'conv_1');
    expect(out.status).toBe(404);
    expect(service.softDeleteAssistantConversations).not.toHaveBeenCalled();
    expect(files.deleteFiles).not.toHaveBeenCalled();
  });
});
