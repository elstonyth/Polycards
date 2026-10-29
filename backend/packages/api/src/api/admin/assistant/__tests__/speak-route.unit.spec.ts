import { EventEmitter } from 'node:events';
import { fetchBytes } from '../../../utils/image-fetch';
import { storeImage } from '../images';
import { generationCost } from '../openrouter';
import { POST } from '../speak/route';
import { speak, type SpeechEvent } from '../voice';

// POST /admin/assistant/speak with the service, the voice model, the file
// store and the fetcher faked: the speech cache, the one-at-a-time slot and
// the cost row on every path.

jest.mock('../access', () => ({
  accessFor: (_scope: unknown, auth: { actor_id: string }) => ({
    userId: auth.actor_id,
  }),
}));
jest.mock('../agent-tools', () => ({ isOwnOrigin: () => true }));
jest.mock('../images', () => ({ storeImage: jest.fn() }));
jest.mock('../../../utils/image-fetch', () => ({ fetchBytes: jest.fn() }));
jest.mock('../openrouter', () => ({
  ...jest.requireActual('../openrouter'),
  generationCost: jest.fn(),
}));
jest.mock('../voice', () => ({
  ...jest.requireActual('../voice'),
  speak: jest.fn(),
}));
jest.mock('../../../../modules/assistant', () => ({
  ASSISTANT_MODULE: 'assistant',
}));
jest.mock('../../../../modules/assistant/key-vault', () => ({
  openKey: () => 'k',
}));

const speakMock = speak as jest.MockedFunction<typeof speak>;
const storeMock = storeImage as jest.MockedFunction<typeof storeImage>;
const fetchMock = fetchBytes as jest.MockedFunction<typeof fetchBytes>;
const costMock = generationCost as jest.MockedFunction<typeof generationCost>;

const answerRow = {
  id: 'aimsg_1',
  conversation_id: 'conv_1',
  content: 'Revenue today is RM 1,234.50.',
};
const cacheRow = (voice: string, url = 'https://cdn.example/a.pcm') => ({
  tools: {
    message_id: 'aimsg_1',
    voice_model: 'openai/gpt-audio-mini',
    voice,
    url,
  },
});
let voiceRows: { tools: unknown }[] = [];

const service = {
  listAssistantMessages: jest.fn(
    async (filter: { id?: string; role: string }) =>
      filter.role === 'voice'
        ? voiceRows
        : filter.id === answerRow.id
          ? [answerRow]
          : [],
  ),
  listAssistantConversations: jest.fn(async (filter: { user_id: string }) =>
    filter.user_id === 'user_1' ? [{ id: 'conv_1' }] : [],
  ),
  settings: jest.fn(async () => ({
    openrouter_key_sealed: 'sealed',
    daily_cap_usd: 5,
    voice_model: 'openai/gpt-audio-mini',
    voice: 'nova',
  })),
  spentToday: jest.fn(async () => 0),
  createAssistantMessages: jest.fn(async () => ({ id: 'aimsg_v' })),
  updateAssistantConversations: jest.fn(async () => ({})),
};
const logger = { info: jest.fn(), warn: jest.fn() };

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
    status: () => status,
    events: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

const b64 = (bytes: number[]) => Buffer.from(bytes).toString('base64');
async function* spoken(): AsyncGenerator<SpeechEvent> {
  yield { type: 'generation', id: 'gen-1' };
  yield { type: 'audio', data: b64([1, 2, 3, 4]) };
  yield { type: 'audio', data: b64([5, 6]) };
  yield { type: 'usage', cost: 0.003, tokensIn: 10, tokensOut: 20 };
}
const audioOf = (events: Record<string, unknown>[]) =>
  Buffer.concat(
    events
      .filter((e) => e.type === 'audio')
      .map((e) => Buffer.from(String(e.data), 'base64')),
  );

beforeEach(() => {
  jest.clearAllMocks();
  voiceRows = [];
  speakMock.mockImplementation(spoken);
  storeMock.mockResolvedValue('https://cdn.example/new.pcm');
  fetchMock.mockResolvedValue(null);
  costMock.mockResolvedValue(0);
});

it('speaks, stores the speech and records where it is with the cost', async () => {
  // Same answer in another voice: not a match.
  voiceRows = [cacheRow('alloy')];
  const p = post();
  await p.done;
  expect(speakMock).toHaveBeenCalledTimes(1);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(audioOf(p.events())).toEqual(Buffer.from([1, 2, 3, 4, 5, 6]));
  const [, bytes, name, mime] = storeMock.mock.calls[0];
  expect(bytes).toEqual(Buffer.from([1, 2, 3, 4, 5, 6]));
  expect(name).toMatch(/^assistant-voice-[0-9a-f-]{36}\.pcm$/);
  expect(mime).toBe('application/octet-stream');
  expect(service.createAssistantMessages).toHaveBeenCalledWith(
    expect.objectContaining({
      role: 'voice',
      cost_usd: 0.003,
      error: null,
      tools: {
        message_id: 'aimsg_1',
        voice_model: 'openai/gpt-audio-mini',
        voice: 'nova',
        url: 'https://cdn.example/new.pcm',
      },
    }),
  );
  expect(p.events().at(-1)).toEqual({ type: 'done', cost_usd: 0.003 });
});

it('plays stored speech again for free, in ~24 KB chunks', async () => {
  voiceRows = [cacheRow('alloy'), cacheRow('nova')];
  const stored = Buffer.alloc(30_000, 7);
  fetchMock.mockResolvedValue(stored);
  const p = post();
  await p.done;
  expect(fetchMock.mock.calls[0][0]).toBe('https://cdn.example/a.pcm');
  const audio = p.events().filter((e) => e.type === 'audio');
  expect(audio).toHaveLength(2);
  expect(audioOf(p.events())).toEqual(stored);
  expect(p.events().at(-1)).toEqual({ type: 'done', cost_usd: 0 });
  expect(speakMock).not.toHaveBeenCalled();
  expect(service.spentToday).not.toHaveBeenCalled();
  expect(service.createAssistantMessages).not.toHaveBeenCalled();
});

it('speaks again when the stored speech cannot be read', async () => {
  voiceRows = [cacheRow('nova', 'https://cdn.example/gone.pcm')];
  const p = post();
  await p.done;
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(speakMock).toHaveBeenCalledTimes(1);
  expect(service.createAssistantMessages).toHaveBeenCalledWith(
    expect.objectContaining({
      cost_usd: 0.003,
      tools: expect.objectContaining({ url: 'https://cdn.example/new.pcm' }),
    }),
  );
  expect(p.events().at(-1)).toEqual({ type: 'done', cost_usd: 0.003 });
});

it("404s someone else's answer before looking at any stored speech", async () => {
  voiceRows = [cacheRow('nova')];
  const p = post('user_2');
  await p.done;
  expect(p.status()).toBe(404);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(service.listAssistantMessages).not.toHaveBeenCalledWith(
    expect.objectContaining({ role: 'voice' }),
    expect.anything(),
  );
  expect(speakMock).not.toHaveBeenCalled();
});

it('answers busy while the same person is already being read to', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  speakMock.mockImplementationOnce(async function* () {
    yield { type: 'generation', id: 'gen-1' };
    await gate;
    yield { type: 'usage', cost: 0.001, tokensIn: 1, tokensOut: 1 };
  });
  const first = post();
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
  release();
  await first.done;
  expect(first.events().at(-1)).toEqual({ type: 'done', cost_usd: 0.001 });
  // The slot is free again.
  const third = post();
  await third.done;
  expect(third.events().at(-1)).toEqual({ type: 'done', cost_usd: 0.003 });
});

it('waits for the slot while the last reading still saves its cost', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  service.createAssistantMessages.mockImplementationOnce(async () => {
    await gate;
    return { id: 'aimsg_v' };
  });
  const first = post();
  while (!service.createAssistantMessages.mock.calls.length) {
    await new Promise((r) => setImmediate(r));
  }
  const second = post();
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
  release();
  await first.done;
  await second.done;
  expect(speakMock).toHaveBeenCalledTimes(2);
  expect(second.events().at(-1)).toEqual({ type: 'done', cost_usd: 0.003 });
});

it('still saves the looked-up cost when the listener stops mid-stream', async () => {
  costMock.mockResolvedValue(0.0021);
  speakMock.mockImplementationOnce(async function* (opts) {
    yield { type: 'generation', id: 'gen-9' };
    yield { type: 'audio', data: b64([1, 2]) };
    lastRes.emit('close'); // the admin stops listening
    opts.signal?.throwIfAborted();
  });
  const p = post();
  await p.done;
  expect(costMock).toHaveBeenCalledWith('k', 'gen-9');
  expect(storeMock).not.toHaveBeenCalled();
  expect(service.createAssistantMessages).toHaveBeenCalledWith(
    expect.objectContaining({
      role: 'voice',
      cost_usd: 0.0021,
      tools: null,
      error: null,
    }),
  );
});

it('stores nothing when the stream ends before its bill', async () => {
  costMock.mockResolvedValue(0.0015);
  speakMock.mockImplementationOnce(async function* () {
    yield { type: 'generation', id: 'gen-5' };
    yield { type: 'audio', data: b64([1, 2]) };
  });
  const p = post();
  await p.done;
  expect(storeMock).not.toHaveBeenCalled();
  expect(costMock).toHaveBeenCalledWith('k', 'gen-5');
  expect(service.createAssistantMessages).toHaveBeenCalledWith(
    expect.objectContaining({ cost_usd: 0.0015, tools: null }),
  );
});

it('saves the cost but stores nothing when speaking fails', async () => {
  speakMock.mockImplementationOnce(async function* () {
    yield { type: 'generation', id: 'gen-3' };
    yield { type: 'audio', data: b64([1, 2]) };
    throw new Error('voice not available');
  });
  const p = post();
  await p.done;
  expect(storeMock).not.toHaveBeenCalled();
  expect(service.createAssistantMessages).toHaveBeenCalledWith(
    expect.objectContaining({ tools: null, error: 'voice not available' }),
  );
  expect(p.events().at(-1)).toMatchObject({
    type: 'error',
    code: 'speak_failed',
  });
});
