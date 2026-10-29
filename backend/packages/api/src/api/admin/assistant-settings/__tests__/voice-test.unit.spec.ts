import { EventEmitter } from 'node:events';
import { accessFor } from '../../assistant/access';
import { speak } from '../../assistant/voice';
import { POST } from '../voice-test/route';

// POST /admin/assistant-settings/voice-test with the voice model faked.

jest.mock('../../assistant/access', () => ({ accessFor: jest.fn() }));
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
  const req = {
    body,
    auth_context: { actor_id: 'user_1' },
    scope: {
      resolve: (name: string) =>
        name === 'assistant'
          ? service
          : name === 'configModule'
            ? { projectConfig: { http: { jwtSecret: 's' } } }
            : { info: jest.fn() },
    },
  };
  return POST(req as never, res as never).then(() => ({
    code: res.code,
    events: lines.map((l) => JSON.parse(l) as Record<string, unknown>),
  }));
}

const asSuper = (superAdmin: boolean) =>
  accessMock.mockReturnValue({ userId: 'user_1', superAdmin } as never);

beforeEach(() => speakMock.mockReset());

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
  expect(speakMock).not.toHaveBeenCalled();
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
});
