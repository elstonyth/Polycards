import { EventEmitter } from 'node:events';
import { accessFor } from '../../assistant/access';
import { generationCost } from '../../assistant/openrouter';
import { speak } from '../../assistant/voice';
import { POST } from '../voice-test/route';

// POST /admin/assistant-settings/voice-test with the voice model faked.

jest.mock('../../assistant/access', () => ({ accessFor: jest.fn() }));
jest.mock('../../assistant/openrouter', () => ({
  ...jest.requireActual('../../assistant/openrouter'),
  generationCost: jest.fn(),
}));
jest.mock('../../assistant/voice', () => ({
  VOICES: ['alloy', 'nova'],
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
const logger = { info: jest.fn() };
// The response of the request in flight, so a fake speak() can press Stop.
let lastRes: EventEmitter;
const service = {
  settings: jest.fn(async () => ({
    openrouter_key_sealed: 'sealed',
    voice_model: 'openai/gpt-audio-mini',
    voice: 'alloy',
  })),
};

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
  logger.info.mockReset();
});

it('refuses anyone but a super admin', async () => {
  asSuper(false);
  const r = await post({});
  expect(r.code).toBe(403);
  expect(speakMock).not.toHaveBeenCalled();
});

it('refuses a voice that is not on the list', async () => {
  asSuper(true);
  const r = await post({ voice: 'robot' });
  expect(r.code).toBe(400);
  expect(r.events[0]).toMatchObject({ code: 'bad_voice_model' });
  expect(speakMock).not.toHaveBeenCalled();
});

it('refuses a web-search model', async () => {
  asSuper(true);
  const r = await post({ voice_model: 'openai/gpt-5:online' });
  expect(r.code).toBe(400);
  expect(r.events[0]).toMatchObject({ code: 'bad_voice_model' });
  expect(speakMock).not.toHaveBeenCalled();
});

it('prices a stopped sample by its generation before logging it', async () => {
  asSuper(true);
  costMock.mockResolvedValue(0.0007);
  speakMock.mockImplementation(async function* (opts) {
    yield { type: 'generation', id: 'gen_9' };
    yield { type: 'audio', data: 'AAA=' };
    lastRes.emit('close'); // Stop, before the usage chunk
    opts.signal?.throwIfAborted();
  });
  await post({});
  expect(costMock).toHaveBeenCalledWith('k', 'gen_9');
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
  // One log line, whatever the provider's text holds.
  expect(logger.info.mock.calls[0][0]).not.toMatch(/\n/);

  speakMock.mockImplementation(async function* () {
    throw new DOMException('The operation timed out.', 'TimeoutError');
  });
  r = await post({});
  expect(r.events[0]).toMatchObject({ type: 'error', code: 'speak_failed' });

  speakMock.mockImplementation(async function* () {
    yield { type: 'usage', cost: 0.0001, tokensIn: 1, tokensOut: 1 };
  });
  r = await post({});
  expect(r.events[0]).toMatchObject({ type: 'error', code: 'no_audio' });
});

it('streams the sample in the unsaved model and voice', async () => {
  asSuper(true);
  speakMock.mockImplementation(async function* () {
    yield { type: 'generation', id: 'gen_1' };
    yield { type: 'audio', data: 'AAA=' };
    yield { type: 'audio', data: 'BBB=' };
    yield { type: 'usage', cost: 0.0004, tokensIn: 1, tokensOut: 1 };
  });
  const r = await post({
    voice_model: 'openai/gpt-audio',
    voice: 'nova',
    lang: 'zh',
  });
  expect(r.code).toBe(200);
  expect(speakMock.mock.calls[0][0]).toMatchObject({
    key: 'k',
    model: 'openai/gpt-audio',
    voice: 'nova',
    text: expect.stringContaining('128'),
  });
  expect(speakMock.mock.calls[0][0].text).toMatch(/助手/);
  expect(r.events).toEqual([
    { type: 'audio', data: 'AAA=' },
    { type: 'audio', data: 'BBB=' },
    { type: 'done', cost_usd: 0.0004 },
  ]);
  expect(costMock).not.toHaveBeenCalled();
});
