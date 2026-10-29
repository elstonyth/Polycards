import { EventEmitter } from 'node:events';
import { POST } from '../chat/route';
import { runTurn, type TurnResult } from '../engine';
import { transcribe } from '../voice';

// POST /admin/assistant/chat with the engine and the assistant service
// faked: what budget an answer gets, and the one-answer-at-a-time lock.

jest.mock('../engine', () => ({ runTurn: jest.fn() }));
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
const answer: TurnResult = {
  text: 'ok',
  tools: [],
  cost: 0.01,
  tokensIn: 1,
  tokensOut: 1,
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
    done,
    events: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

beforeEach(() => {
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

it('asks a spoken question as it was heard, and charges the listening with the answer', async () => {
  const transcribeMock = transcribe as jest.MockedFunction<typeof transcribe>;
  transcribeMock.mockResolvedValueOnce({
    text: 'how many packs today?',
    cost: 0.001,
  });
  runTurnMock.mockResolvedValueOnce({ ...answer });
  service.createAssistantMessages.mockClear();
  const p = post({ audio: 'UklGRg==' });
  await p.done;
  expect(transcribeMock.mock.calls[0][0]).toMatchObject({
    model: 'google/gemini-3.5-flash-lite',
    wavBase64: 'UklGRg==',
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
  (transcribe as jest.MockedFunction<typeof transcribe>).mockResolvedValueOnce({
    text: '',
    cost: 0.0002,
  });
  service.createAssistantConversations.mockClear();
  service.createAssistantMessages.mockClear();
  service.softDeleteAssistantConversations.mockClear();
  const p = post({ audio: 'UklGRg==' });
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
  (transcribe as jest.MockedFunction<typeof transcribe>).mockResolvedValueOnce({
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
  await post({ audio: 'UklGRg==', conversation_id: 'conv_9' }).done;
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
