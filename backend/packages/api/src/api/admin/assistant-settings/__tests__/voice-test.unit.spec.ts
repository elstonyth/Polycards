import { EventEmitter } from 'node:events';
import { accessFor } from '../../assistant/access';
import { generationCost, speechModels } from '../../assistant/openrouter';
import { speak } from '../../assistant/voice';
import { POST } from '../voice-test/route';

// POST /admin/assistant-settings/voice-test with the speaking model faked.

jest.mock('../../assistant/access', () => ({ accessFor: jest.fn() }));
jest.mock('../../assistant/openrouter', () => ({
  ...jest.requireActual('../../assistant/openrouter'),
  generationCost: jest.fn(),
  speechModels: jest.fn(),
}));
jest.mock('../../assistant/voice', () => ({
  ...jest.requireActual('../../assistant/voice'),
  speak: jest.fn(),
}));
jest.mock('../../../../modules/assistant', () => ({
  ASSISTANT_MODULE: 'assistant',
}));
jest.mock('../../../../modules/assistant/key-vault', () => ({
  openKey: () => 'k',
}));

const accessMock = accessFor as jest.MockedFunction<typeof accessFor>;
const speakMock = speak as jest.MockedFunction<typeof speak>;
const costMock = generationCost as jest.MockedFunction<typeof generationCost>;
const listMock = speechModels as jest.MockedFunction<typeof speechModels>;
const logger = { info: jest.fn() };
// The response of the request in flight, so a fake speak() can press Stop.
let lastRes: EventEmitter;
const service = {
  settings: jest.fn(async () => ({
    openrouter_key_sealed: 'sealed',
    voice_model: 'google/gemini-3.8-flash-lite-tts',
    voice: 'Kore',
  })),
};
const LIST = new Map([
  [
    'google/gemini-3.8-flash-lite-tts',
    { voices: ['Kore', 'Puck'], prompt: 5e-7, completion: 6e-6 },
  ],
  [
    'elevenlabs/eleven-flash-v2.5',
    { voices: ['sarah'], prompt: 4e-5, completion: 0 },
  ],
]);
const settled = () => new Promise((r) => setImmediate(r));

function post(body: Record<string, unknown>) {
  const lines: string[] = [];
  const res = Object.assign(new EventEmitter(), {
    code: 0,
    writableEnded: false,
    writableFinished: false,
    status(code: number) {
      this.code = code;
      return this;
    },
    json(b: unknown) {
      lines.push(JSON.stringify(b));
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
    body,
    auth_context: { actor_id: 'user_1' },
    scope: {
      resolve: (name: string) =>
        name === 'assistant'
          ? service
          : name === 'configModule'
            ? { projectConfig: { http: { jwtSecret: 's' } } }
            : logger,
    },
  };
  return POST(req as never, res as never).then(() => ({
    code: res.code,
    events: lines.map((l) => JSON.parse(l) as Record<string, unknown>),
  }));
}

const asSuper = (superAdmin: boolean) =>
  accessMock.mockReturnValue({ userId: 'user_1', superAdmin } as never);

beforeEach(() => {
  speakMock.mockReset();
  costMock.mockReset().mockResolvedValue(0);
  listMock.mockReset().mockResolvedValue(LIST);
  logger.info.mockReset();
});

it('refuses anyone but a super admin', async () => {
  asSuper(false);
  const r = await post({});
  expect(r.code).toBe(403);
  expect(speakMock).not.toHaveBeenCalled();
});

it('refuses a voice the model does not have', async () => {
  asSuper(true);
  const r = await post({ voice: 'sarah' });
  expect(r.code).toBe(400);
  expect(r.events[0]).toMatchObject({ code: 'bad_voice_model' });
  expect(String(r.events[0].message)).toMatch(/not a voice of/);
  expect(speakMock).not.toHaveBeenCalled();
});

it('refuses a chat voice model and a web-search model', async () => {
  asSuper(true);
  // reads aloud by answering what it reads (2026-10-29): not a speaking model
  let r = await post({ voice_model: 'openai/gpt-audio-mini', voice: 'alloy' });
  expect(r.code).toBe(400);
  expect(String(r.events[0].message)).toMatch(/not one of OpenRouter/);
  r = await post({ voice_model: 'openai/gpt-5:online' });
  expect(r.code).toBe(400);
  expect(r.events[0]).toMatchObject({ code: 'bad_voice_model' });
  expect(speakMock).not.toHaveBeenCalled();
});

it('takes any well-formed voice while OpenRouter’s list is out of reach', async () => {
  asSuper(true);
  listMock.mockResolvedValue(null);
  speakMock.mockImplementation(async function* () {
    yield { type: 'format', rate: 24000 };
    yield { type: 'audio', data: 'AAA=' };
  });
  const r = await post({ voice_model: 'vendor/new-tts', voice: 'Nova_2' });
  expect(r.code).toBe(200);
  expect(r.events.at(-1)).toEqual({ type: 'done' });
});

it('streams the sample in the unsaved model and voice, then logs its cost', async () => {
  asSuper(true);
  costMock.mockResolvedValueOnce(0.0004).mockResolvedValueOnce(0.0002);
  speakMock.mockImplementation(async function* () {
    yield { type: 'generation', id: 'gen_1' };
    yield { type: 'format', rate: 24000 };
    yield { type: 'audio', data: 'AAA=' };
    yield { type: 'generation', id: 'gen_2' };
    yield { type: 'audio', data: 'BBB=' };
  });
  const r = await post({
    voice_model: 'google/gemini-3.8-flash-lite-tts',
    voice: 'Puck',
    lang: 'zh',
  });
  expect(r.code).toBe(200);
  expect(speakMock.mock.calls[0][0]).toMatchObject({
    key: 'k',
    model: 'google/gemini-3.8-flash-lite-tts',
    voice: 'Puck',
    text: expect.stringContaining('128'),
  });
  expect(speakMock.mock.calls[0][0].text).toMatch(/助手/);
  expect(r.events).toEqual([
    { type: 'format', rate: 24000 },
    { type: 'audio', data: 'AAA=' },
    { type: 'audio', data: 'BBB=' },
    { type: 'done' },
  ]);
  // the figure arrives seconds later: looked up after the answer has gone
  await settled();
  expect(costMock).toHaveBeenCalledWith('k', 'gen_1', undefined, 12);
  expect(logger.info.mock.calls[0][0]).toContain('cost=0.0006');
});

it('logs a stopped sample with its pieces’ cost', async () => {
  asSuper(true);
  costMock.mockResolvedValue(0.0007);
  speakMock.mockImplementation(async function* (opts) {
    yield { type: 'generation', id: 'gen_9' };
    yield { type: 'audio', data: 'AAA=' };
    lastRes.emit('close'); // Stop
    opts.signal?.throwIfAborted();
  });
  await post({});
  await settled();
  expect(logger.info.mock.calls[0][0]).toContain('cost=0.0007');
  expect(logger.info.mock.calls[0][0]).not.toContain('error=');
});

it('sends error codes: speak_failed with the reason, and no_audio', async () => {
  asSuper(true);
  speakMock.mockImplementation(async function* () {
    yield { type: 'generation', id: 'gen_2' };
    throw new Error('Provider down\nretry later');
  });
  let r = await post({});
  expect(r.events).toEqual([
    {
      type: 'error',
      code: 'speak_failed',
      message: 'Could not play the sample: Provider down retry later',
      reason: 'Provider down retry later',
    },
  ]);
  await settled();
  // One log line, whatever the provider's text holds.
  expect(logger.info.mock.calls[0][0]).not.toMatch(/\n/);

  speakMock.mockImplementation(async function* () {
    throw new DOMException('The operation timed out.', 'TimeoutError');
  });
  r = await post({});
  expect(r.events[0]).toMatchObject({ type: 'error', code: 'speak_failed' });

  speakMock.mockImplementation(async function* () {
    yield { type: 'format', rate: 24000 };
  });
  r = await post({});
  expect(r.events.at(-1)).toMatchObject({ type: 'error', code: 'no_audio' });
});
