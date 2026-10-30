import { EventEmitter } from 'node:events';
import { POST } from '../chat/route';
import { openProposal } from '../confirm';
import { runTurn, type TurnResult } from '../engine';
import { generationCost } from '../openrouter';
import { transcribe } from '../voice';

// POST /admin/assistant/chat with the engine and the assistant service
// faked: what budget an answer gets, and the one-answer-at-a-time lock.

jest.mock('../engine', () => ({ runTurn: jest.fn() }));
jest.mock('../openrouter', () => ({
  ...jest.requireActual('../openrouter'),
  generationCost: jest.fn(),
}));
jest.mock('../access', () => ({
  accessFor: () => ({ userId: 'user_1' }),
  allowedTools: async () => [],
  LASTING_WRITES: new Set(),
}));
jest.mock('../agent-tools', () => ({ memoryFor: async () => [] }));
jest.mock('../tools', () => ({ TOOLS: [] }));
jest.mock('../brand-style', () => ({
  DEFAULT_IMAGE_STYLE: '',
  styleRefs: async () => [],
}));
jest.mock('../images', () => ({ storeImage: jest.fn() }));
jest.mock('../voice', () => ({
  MAX_AUDIO_BYTES: 2.5 * 1024 * 1024,
  transcribe: jest.fn(),
}));
jest.mock('../schedule', () => ({ SCHEDULED_PREFIX: 'Scheduled' }));
jest.mock('../../../../modules/assistant', () => ({
  ASSISTANT_MODULE: 'assistant',
}));
jest.mock('../../../../modules/assistant/key-vault', () => ({
  openKey: () => 'k',
}));
// Redis as the other web instance sees it: one shared map of locks.
jest.mock('../../../utils/rate-limit', () => {
  const locks = new Map<string, string>();
  return {
    locks,
    throttledWarn: () => () => undefined,
    connectRedis: () => ({
      set: async (key: string, token: string) => {
        if (locks.has(key)) return null;
        locks.set(key, token);
        return 'OK';
      },
      eval: async (_lua: string, _n: number, key: string, token: string) => {
        if (locks.get(key) !== token) return 0;
        locks.delete(key);
        return 1;
      },
    }),
  };
});

const locks: Map<string, string> = jest.requireMock(
  '../../../utils/rate-limit',
).locks;
const runTurnMock = runTurn as jest.MockedFunction<typeof runTurn>;
const transcribeMock = transcribe as jest.MockedFunction<typeof transcribe>;
// A header-only WAV as the admin records it (16 kHz mono 16-bit PCM).
function wav(rate = 16000, channels = 1): string {
  const b = Buffer.alloc(44);
  b.write('RIFF', 0);
  b.writeUInt32LE(36, 4);
  b.write('WAVE', 8);
  b.write('fmt ', 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(channels, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * channels * 2, 28);
  b.writeUInt16LE(channels * 2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  return b.toString('base64');
}
const answer: TurnResult = {
  text: 'ok',
  tools: [],
  cost: 0.01,
  tokensIn: 1,
  tokensOut: 1,
  pending: [],
};

const service = {
  listAssistantConversations: jest.fn(async () => []),
  settings: jest.fn(async () => ({
    openrouter_key_sealed: 'sealed',
    daily_cap_usd: 5,
    chat_model: 'anthropic/claude-sonnet-5.5',
    stt_model: 'google/gemini-3.5-flash-lite',
    image_model: 'i',
    image_style: '',
    style_refs: null,
  })),
  spentToday: jest.fn(async () => 1.25),
  createAssistantConversations: jest.fn(async (c: { title: string }) => ({
    id: 'conv_1',
    title: c.title,
  })),
  listAssistantMessages: jest.fn(async () => []),
  createAssistantMessages: jest.fn(async () => ({ id: 'msg_1' })),
  updateAssistantConversations: jest.fn(async () => ({})),
  updateAssistantMessages: jest.fn(async () => ({})),
  softDeleteAssistantConversations: jest.fn(async () => ({})),
};
const logger = { info: jest.fn(), warn: jest.fn() };

function post(body: Record<string, unknown> = { message: 'how many groups?' }) {
  const lines: string[] = [];
  const res = Object.assign(new EventEmitter(), {
    writableEnded: false,
    writableFinished: false,
    status() {
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
  const req = {
    body,
    auth_context: { actor_id: 'user_1' },
    socket: { localPort: 9000 },
    scope: {
      resolve: (name: string) =>
        name === 'assistant'
          ? service
          : name === 'configModule'
            ? { projectConfig: { http: { jwtSecret: 's' } } }
            : logger,
    },
  };
  const done = POST(req as never, res as never);
  return {
    res,
    done,
    events: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

beforeEach(() => {
  // Calls only: the service fakes keep their implementations.
  jest.clearAllMocks();
  transcribeMock.mockReset();
  runTurnMock.mockReset().mockResolvedValue(answer);
  locks.clear();
});

it('gives the answer what is left of today’s cap', async () => {
  const p = post();
  await p.done;
  expect(runTurnMock.mock.calls[0][0].budgetUsd).toBe(5 - 1.25);
  expect(runTurnMock.mock.calls[0][0].spoken).toBe(false);
  expect(p.events().at(-1)).toMatchObject({
    type: 'done',
    message_id: 'msg_1',
  });
  expect(locks.size).toBe(0);
});

it('never replays tool calls a model wrote as text into the next question', async () => {
  (service.listAssistantMessages as jest.Mock).mockResolvedValueOnce([
    {
      role: 'assistant',
      content: '\n\n<｜DSML｜ calls>SELECT 1</｜DSML｜ calls>',
    },
    { role: 'user', content: 'what happened?' },
    {
      role: 'assistant',
      content: 'RM 0: all bonus <｜DSML｜ calls>',
    },
    { role: 'user', content: 'why RM 0?' },
  ]);
  const p = post();
  await p.done;
  expect(runTurnMock.mock.calls[0][0].history).toEqual([
    { role: 'user', content: 'why RM 0?' },
    { role: 'assistant', content: 'RM 0: all bonus ' },
    { role: 'user', content: 'what happened?' },
  ]);
});

it('asks a spoken question as it was heard, and charges the listening with the answer', async () => {
  transcribeMock.mockResolvedValueOnce({
    text: 'how many packs today?',
    cost: 0.001,
  });
  runTurnMock.mockResolvedValueOnce({ ...answer });
  service.createAssistantMessages.mockClear();
  const p = post({ audio: wav() });
  await p.done;
  expect(transcribeMock.mock.calls[0][0]).toEqual({
    key: 'k',
    model: 'google/gemini-3.5-flash-lite',
    wavBase64: wav(),
  });
  expect(p.events()[0]).toEqual({
    type: 'transcript',
    text: 'how many packs today?',
  });
  expect(runTurnMock.mock.calls[0][0]).toMatchObject({
    userText: 'how many packs today?',
    budgetUsd: 5 - 1.25 - 0.001,
    spoken: true,
  });
  const calls = service.createAssistantMessages.mock.calls as unknown as [
    { role: string; content: string; cost_usd?: number },
  ][];
  expect(calls.map(([m]) => [m.role, m.content])).toEqual([
    ['user', 'how many packs today?'],
    ['assistant', 'ok'],
  ]);
  expect(calls[1][0].cost_usd).toBeCloseTo(0.011);
});

it('answers a typed Talk-mode follow-up for the ear only when spoken is true', async () => {
  await post({ message: 'and yesterday?', spoken: true }).done;
  await post({ message: 'and yesterday?', spoken: 'yes' }).done;
  expect(runTurnMock.mock.calls.map(([o]) => o.spoken)).toEqual([true, false]);
});

it('says it did not catch a recording with no speech, asks nothing, and still charges the listening', async () => {
  transcribeMock.mockResolvedValueOnce({
    text: '',
    cost: 0.0002,
  });
  service.createAssistantConversations.mockClear();
  service.createAssistantMessages.mockClear();
  service.softDeleteAssistantConversations.mockClear();
  const p = post({ audio: wav() });
  await p.done;
  expect(p.events()).toEqual([
    { type: 'transcript', text: '' },
    expect.objectContaining({ type: 'error', code: 'no_speech' }),
  ]);
  expect(runTurnMock).not.toHaveBeenCalled();
  expect(service.createAssistantConversations).toHaveBeenCalledWith(
    expect.objectContaining({ title: '(voice) nothing heard' }),
  );
  expect(service.createAssistantMessages.mock.calls).toEqual([
    [
      {
        conversation_id: 'conv_1',
        role: 'voice',
        content: '',
        tools: { kind: 'listen' },
        model: 'google/gemini-3.5-flash-lite',
        cost_usd: 0.0002,
      },
    ],
  ]);
  // Hidden from the staff list, still counted by spentToday (withDeleted).
  expect(service.softDeleteAssistantConversations).toHaveBeenCalledWith([
    'conv_1',
  ]);
  expect(locks.size).toBe(0);
});

it('charges hearing nothing to the chat it was asked in, and keeps that chat', async () => {
  transcribeMock.mockResolvedValueOnce({
    text: '',
    cost: 0.0003,
  });
  service.listAssistantConversations.mockResolvedValueOnce([
    { id: 'conv_9', title: 'old' },
  ] as never);
  service.createAssistantConversations.mockClear();
  service.createAssistantMessages.mockClear();
  service.updateAssistantConversations.mockClear();
  service.softDeleteAssistantConversations.mockClear();
  await post({ audio: wav(), conversation_id: 'conv_9' }).done;
  expect(service.createAssistantConversations).not.toHaveBeenCalled();
  expect(service.createAssistantMessages).toHaveBeenCalledWith(
    expect.objectContaining({
      conversation_id: 'conv_9',
      role: 'voice',
      cost_usd: 0.0003,
    }),
  );
  expect(service.updateAssistantConversations).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'conv_9' }),
  );
  // Bumped before the row, so a failed bump never leaves a row uncounted.
  expect(
    service.updateAssistantConversations.mock.invocationCallOrder[0],
  ).toBeLessThan(service.createAssistantMessages.mock.invocationCallOrder[0]);
  expect(service.softDeleteAssistantConversations).not.toHaveBeenCalled();
});

it('refuses a recording that is not base64', async () => {
  const p = post({ audio: 'not base64!' });
  await p.done;
  expect(p.events()).toEqual([
    { message: 'The recording must be a base64 WAV.' },
  ]);
});

it('refuses a web-search model saved before the settings check existed', async () => {
  service.settings.mockResolvedValueOnce({
    openrouter_key_sealed: 'sealed',
    daily_cap_usd: 5,
    chat_model: 'openai/gpt-5:online',
    stt_model: 'google/gemini-3.5-flash-lite',
    image_model: 'i',
    image_style: '',
    style_refs: null,
  });
  const p = post();
  await p.done;
  expect(p.events()).toEqual([
    expect.objectContaining({ type: 'error', code: 'bad_model' }),
  ]);
  expect(runTurnMock).not.toHaveBeenCalled();
});

it('answers busy while the same person’s answer runs, then lets the next in', async () => {
  let finish!: (r: TurnResult) => void;
  let started!: () => void;
  const running = new Promise<void>((r) => (started = r));
  runTurnMock.mockImplementationOnce(() => {
    started();
    return new Promise<TurnResult>((r) => (finish = r));
  });
  const first = post();
  await running;

  const second = post();
  await second.done;
  expect(second.events()).toEqual([
    expect.objectContaining({ type: 'error', code: 'busy' }),
  ]);

  finish(answer);
  await first.done;
  const third = post();
  await third.done;
  expect(third.events().at(-1)).toMatchObject({ type: 'done' });
  expect(runTurnMock).toHaveBeenCalledTimes(2);
});

it('still finishes with done when the chat was deleted mid-answer', async () => {
  service.updateAssistantConversations
    .mockResolvedValueOnce({})
    .mockRejectedValueOnce(new Error('deleted'));
  const p = post();
  await p.done;
  expect(p.events().at(-1)).toMatchObject({ type: 'done' });
  expect(logger.warn).toHaveBeenCalledWith(
    expect.stringContaining('conversation update failed'),
  );
});

it('answers busy while the other instance holds the lock, and leaves its lock', async () => {
  locks.set('assistant:busy:user_1', 'other-instance');
  const p = post();
  await p.done;
  expect(p.events()).toEqual([
    expect.objectContaining({ type: 'error', code: 'busy' }),
  ]);
  expect(runTurnMock).not.toHaveBeenCalled();
  expect(locks.get('assistant:busy:user_1')).toBe('other-instance');
});

it('refuses a recording that is not 16 kHz mono 16-bit WAV, before listening', async () => {
  for (const audio of [
    wav(44100),
    wav(16000, 2),
    Buffer.from('hello').toString('base64'),
  ]) {
    const p = post({ audio });
    await p.done;
    expect(p.events()).toEqual([
      { message: 'The recording must be 16 kHz mono 16-bit WAV.' },
    ]);
  }
  expect(transcribeMock).not.toHaveBeenCalled();
});

it('names a bad listening model apart from a bad chat model', async () => {
  service.settings.mockResolvedValueOnce({
    openrouter_key_sealed: 'sealed',
    daily_cap_usd: 5,
    chat_model: 'anthropic/claude-sonnet-5.5',
    stt_model: 'openai/gpt-5:online',
    image_model: 'i',
    image_style: '',
    style_refs: null,
  });
  const p = post({ audio: wav() });
  await p.done;
  expect(p.events()).toEqual([
    expect.objectContaining({ type: 'error', code: 'bad_stt_model' }),
  ]);
  expect(transcribeMock).not.toHaveBeenCalled();
});

it('reports a failed listen with its reason, logs it, asks nothing and frees the lock', async () => {
  transcribeMock.mockRejectedValueOnce(new Error('No endpoints found'));
  const p = post({ audio: wav() });
  await p.done;
  expect(p.events()).toEqual([
    expect.objectContaining({
      type: 'error',
      code: 'listen_failed',
      reason: 'No endpoints found',
    }),
  ]);
  expect(logger.warn).toHaveBeenCalledWith(
    expect.stringContaining('listen failed'),
  );
  expect(runTurnMock).not.toHaveBeenCalled();
  expect(service.createAssistantMessages).not.toHaveBeenCalled();
  expect(locks.size).toBe(0);
});

it('does not listen once today’s cap is spent', async () => {
  service.spentToday.mockResolvedValueOnce(5);
  const p = post({ audio: wav() });
  await p.done;
  expect(p.events()).toEqual([
    expect.objectContaining({ type: 'error', code: 'daily_cap' }),
  ]);
  expect(transcribeMock).not.toHaveBeenCalled();
});

it('keeps the listening cost when the turn fails', async () => {
  transcribeMock.mockResolvedValueOnce({
    text: 'how many packs?',
    cost: 0.003,
  });
  service.createAssistantMessages.mockRejectedValueOnce(new Error('db down'));
  const p = post({ audio: wav() });
  await p.done;
  expect(runTurnMock).not.toHaveBeenCalled();
  expect(service.createAssistantMessages).toHaveBeenLastCalledWith(
    expect.objectContaining({
      conversation_id: 'conv_1',
      role: 'voice',
      tools: { kind: 'listen' },
      cost_usd: 0.003,
    }),
  );
  expect(p.events().at(-1)).toMatchObject({ type: 'error' });
  expect(locks.size).toBe(0);
});

it('keeps what the answer cost when saving the answer fails', async () => {
  transcribeMock.mockResolvedValueOnce({
    text: 'how many packs?',
    cost: 0.002,
  });
  runTurnMock.mockResolvedValueOnce({ ...answer, cost: 0.01 });
  service.createAssistantMessages
    .mockImplementationOnce(async () => ({ id: 'msg_q' })) // the question
    .mockImplementationOnce(async () => {
      throw new Error('db down'); // the answer
    });
  const p = post({ audio: wav() });
  await p.done;
  const calls = service.createAssistantMessages.mock.calls as unknown as [
    { role: string; cost_usd?: number; model?: string },
  ][];
  const voice = calls.filter(([m]) => m.role === 'voice');
  // One row, holding the answer and the listening together, never twice.
  expect(voice).toHaveLength(1);
  expect(voice[0][0].cost_usd).toBeCloseTo(0.012);
  expect(voice[0][0].model).toBe('anthropic/claude-sonnet-5.5');
  expect(p.events().at(-1)).toMatchObject({ type: 'error' });
});

it('puts the listening cost in a hidden chat when its own chat cannot be bumped', async () => {
  transcribeMock.mockResolvedValueOnce({ text: '', cost: 0.0003 });
  service.listAssistantConversations.mockResolvedValueOnce([
    { id: 'conv_9', title: 'old' },
  ] as never);
  // The chat was deleted in another tab meanwhile.
  service.updateAssistantConversations.mockRejectedValueOnce(
    new Error('not found'),
  );
  await post({ audio: wav(), conversation_id: 'conv_9' }).done;
  expect(service.createAssistantConversations).toHaveBeenCalledTimes(1);
  expect(service.createAssistantMessages).toHaveBeenCalledWith(
    expect.objectContaining({
      conversation_id: 'conv_1',
      role: 'voice',
      cost_usd: 0.0003,
    }),
  );
  expect(service.softDeleteAssistantConversations).toHaveBeenCalledWith([
    'conv_1',
  ]);
});

it('still charges the listening of an asker who left while it was written down', async () => {
  let p!: ReturnType<typeof post>;
  transcribeMock.mockImplementationOnce(async () => {
    p.res.emit('close');
    return { text: 'how many packs?', cost: 0.002 };
  });
  p = post({ audio: wav() });
  await p.done;
  // Not cut off with the asker: only a finished request says its cost.
  expect(transcribeMock.mock.calls[0][0].signal).toBeUndefined();
  expect(runTurnMock).not.toHaveBeenCalled();
  expect(service.createAssistantMessages.mock.calls).toEqual([
    [
      expect.objectContaining({
        role: 'voice',
        tools: { kind: 'listen' },
        cost_usd: 0.002,
      }),
    ],
  ]);
  expect(service.softDeleteAssistantConversations).toHaveBeenCalledWith([
    'conv_1',
  ]);
  expect(locks.size).toBe(0);
});

it('does not start listening for an asker who already left', async () => {
  let p!: ReturnType<typeof post>;
  service.spentToday.mockImplementationOnce(async () => {
    p.res.emit('close');
    return 1.25;
  });
  p = post({ audio: wav() });
  await p.done;
  expect(transcribeMock).not.toHaveBeenCalled();
  expect(service.createAssistantMessages).not.toHaveBeenCalled();
  expect(locks.size).toBe(0);
});

it('shows a note to save with a tap, signed so only the asker can save it', async () => {
  runTurnMock.mockImplementationOnce(async (opts) => {
    opts.ctx.propose?.(
      { kind: 'note', note: 'Likes short captions.', shared: false },
      'Note: Likes short captions.',
    );
    return { ...answer };
  });
  const p = post();
  await p.done;
  const confirm = p.events().find((e) => e.type === 'confirm');
  expect(confirm).toMatchObject({
    kind: 'note',
    summary: 'Note: Likes short captions.',
  });
  expect(openProposal(confirm?.token, 'user_1', 's')).toEqual({
    kind: 'note',
    note: 'Likes short captions.',
    shared: false,
  });
  expect(openProposal(confirm?.token, 'user_2', 's')).toBeNull();
});

it('puts OpenRouter’s figure in place of a cut-off round’s estimate once it shows up', async () => {
  const costMock = generationCost as jest.MockedFunction<typeof generationCost>;
  costMock.mockResolvedValueOnce(0.05);
  runTurnMock.mockResolvedValueOnce({
    ...answer,
    cost: 0.25,
    pending: [{ id: 'gen-x', estimate: 0.2 }],
  });
  const p = post();
  await p.done;
  // saved at once with the estimate in it
  expect(service.createAssistantMessages).toHaveBeenCalledWith(
    expect.objectContaining({ cost_usd: 0.25 }),
  );
  await new Promise((r) => setImmediate(r));
  expect(costMock).toHaveBeenCalledWith(
    expect.any(String),
    'gen-x',
    undefined,
    12,
  );
  expect(service.updateAssistantMessages).toHaveBeenCalledWith({
    id: 'msg_1',
    cost_usd: expect.closeTo(0.1, 10),
  });
});

it('keeps the estimate when a cut-off round’s figure never shows up', async () => {
  const costMock = generationCost as jest.MockedFunction<typeof generationCost>;
  costMock.mockResolvedValueOnce(0);
  runTurnMock.mockResolvedValueOnce({
    ...answer,
    cost: 0.25,
    pending: [{ id: 'gen-x', estimate: 0.2 }],
  });
  await post().done;
  await new Promise((r) => setImmediate(r));
  expect(service.updateAssistantMessages).not.toHaveBeenCalled();
});
