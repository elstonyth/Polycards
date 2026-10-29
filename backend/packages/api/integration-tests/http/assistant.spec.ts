// integration-tests/http/assistant.spec.ts
// The admin AI assistant (spec 2026-10-29) against a fake OpenRouter: the
// key stays write-only, the chat streams and saves both sides, and a limited
// role is offered only its own tools — its money question gets no figure.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import type { MedusaContainer } from '@medusajs/framework/types';
import {
  ContainerRegistrationKeys,
  generateJwtToken,
  Modules,
} from '@medusajs/framework/utils';
import { ASSISTANT_MODULE } from '../../src/modules/assistant';
import type AssistantModuleService from '../../src/modules/assistant/service';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { runDueSchedules } from '../../src/api/admin/assistant/schedule';
import { mintSuperAdmin } from './utils';

jest.setTimeout(240 * 1000);
// Several chats a test from the same people: lift the per-person chat limit
// (6 per 10 s) for this suite. Read when the app boots, below.
process.env.ASSISTANT_CHAT_RATE_BURST_LIMIT = '1000';
process.env.ASSISTANT_CHAT_RATE_LIMIT = '1000';
// Reading aloud has its own limit: lift it the same way.
process.env.ASSISTANT_SPEAK_RATE_BURST_LIMIT = '1000';
process.env.ASSISTANT_SPEAK_RATE_LIMIT = '1000';

// A made-up key for the fake OpenRouter, not a credential.
const KEY = 'sk-or-v1-test-0123456789abcdef-WXYZ'; // gitleaks:allow

type FakeBody = {
  model: string;
  messages: { role: string; content: unknown; tool_calls?: unknown }[];
  tools?: { function: { name: string } }[];
};

// What the fake model does next, given the request it received.
let script: (body: FakeBody) => object[] = () => [];
const received: FakeBody[] = [];

const say = (content: string) => ({ choices: [{ delta: { content } }] });
const call = (name: string, args: object) => ({
  choices: [
    {
      delta: {
        tool_calls: [
          {
            index: 0,
            id: `call_${name}`,
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      },
    },
  ],
});
const usage = {
  choices: [],
  usage: { cost: 0.001, prompt_tokens: 50, completion_tokens: 5 },
};

// A real recording as the browser sends it: 16 kHz mono 16-bit WAV of
// silence, base64.
const wav16k = (ms: number) => {
  const n = 32 * ms;
  const b = Buffer.alloc(44 + n);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + n, 4);
  b.write('WAVE', 8);
  b.write('fmt ', 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); // PCM
  b.writeUInt16LE(1, 22); // mono
  b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(n, 40);
  return b.toString('base64');
};

// Voice: what the listening model "hears", and every voice request.
let heardText = '';
let generationLookups = 0;
const voiceCalls: (FakeBody & {
  model?: string;
  input?: string;
  voice?: string;
  response_format?: string;
})[] = [];

const fake = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    // OpenRouter's other models, for the Settings dropdowns.
    if (/\/models(\?output_modalities=image)?$/.test(req.url ?? '')) {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          data: [
            {
              id: 'anthropic/claude-sonnet-5.5',
              supported_parameters: ['tools'],
              architecture: { output_modalities: ['text'] },
            },
            {
              id: 'google/gemini-3.5-flash-lite',
              supported_parameters: ['tools'],
              architecture: {
                input_modalities: ['text', 'audio'],
                output_modalities: ['text'],
              },
            },
            {
              id: 'google/gemini-3.1-flash-image',
              architecture: { output_modalities: ['image', 'text'] },
            },
          ],
        }),
      );
      return;
    }
    // OpenRouter's speaking models: priced per character only, so a
    // reading's estimate is its length x 0.00001.
    if (req.url?.includes('/models?output_modalities=speech')) {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          data: [
            {
              id: 'google/gemini-3.8-flash-lite-tts',
              supported_voices: ['Kore', 'Puck'],
              pricing: { prompt: '0.00001', completion: '0' },
            },
          ],
        }),
      );
      return;
    }
    // A reading's own figure, looked up after it: like OpenRouter, not
    // found for the first moments.
    if (req.url?.includes('/generation?id=gen-voice')) {
      if (++generationLookups <= 2) {
        res.statusCode = 404;
        res.end('{"error":{"message":"Generation not found"}}');
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: { total_cost: 0.002 } }));
      return;
    }
    if (req.url?.endsWith('/audio/speech')) {
      voiceCalls.push(JSON.parse(raw));
      // as OpenRouter documents it: no rate on the type (24 kHz)
      res.setHeader('content-type', 'audio/pcm');
      res.setHeader('x-generation-id', 'gen-voice');
      res.write(Buffer.from('AAAA', 'base64'));
      res.end(Buffer.from('BBBB', 'base64'));
      return;
    }
    if (req.url?.endsWith('/key')) {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          data: { label: 'test', usage: 1.5, limit_remaining: 8.5 },
        }),
      );
      return;
    }
    const body = JSON.parse(raw) as FakeBody;
    if (JSON.stringify(body.messages).includes('"input_audio"')) {
      voiceCalls.push(body);
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          usage: { cost: 0.0003 },
          choices: [{ message: { content: heardText } }],
        }),
      );
      return;
    }
    received.push(body);
    res.setHeader('content-type', 'text/event-stream');
    for (const chunk of [...script(body), usage]) {
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    }
    res.end('data: [DONE]\n\n');
  });
});

const toolNames = (b: FakeBody) => (b.tools ?? []).map((t) => t.function.name);
const lastIsTool = (b: FakeBody) => b.messages.at(-1)?.role === 'tool';

/** A role holding exactly these policy keys, for a limited-role token. */
async function roleWith(
  container: MedusaContainer,
  name: string,
  keys: string[],
): Promise<string> {
  const rbac = container.resolve(Modules.RBAC);
  const policies = await rbac.listRbacPolicies({ key: keys });
  expect(policies.map((p) => p.key).sort()).toEqual([...keys].sort());
  const role = await rbac.createRbacRoles({ name });
  await rbac.createRbacRolePolicies(
    policies.map((p) => ({ role_id: role.id, policy_id: p.id })),
  );
  return role.id;
}

function tokenFor(container: MedusaContainer, userId: string, roles: string[]) {
  const { http: cfg } = container.resolve(
    ContainerRegistrationKeys.CONFIG_MODULE,
  ).projectConfig;
  return generateJwtToken(
    {
      actor_id: userId,
      actor_type: 'user',
      auth_identity_id: '',
      app_metadata: { user_id: userId, roles },
    },
    { secret: cfg.jwtSecret, expiresIn: 600, jwtOptions: cfg.jwtOptions },
  );
}

// Anson's three roles as policies (memory: admin-limited-role-sidebar), plus
// the assistant grant with browse.
const ANSON = [
  'store:read',
  'automation:read',
  'delivery_order:read',
  'pull:read',
  'inventory:read',
  'procurement:read',
  'goods_receive_note:read',
  'purchase_invoice:read',
  'assistant:read',
  'assistant:update',
  'assistant:delete',
  'assistant_browse:read',
];

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('admin assistant', () => {
      let admin: { headers: Record<string, string> };
      let anson: { headers: Record<string, string> };

      beforeAll(async () => {
        await new Promise<void>((ok) => fake.listen(0, '127.0.0.1', ok));
        process.env.ASSISTANT_OPENROUTER_BASE = `http://127.0.0.1:${(fake.address() as AddressInfo).port}/api/v1`;
      });
      afterAll(async () => {
        delete process.env.ASSISTANT_OPENROUTER_BASE;
        await new Promise((ok) => fake.close(ok));
      });

      beforeEach(async () => {
        const container = getContainer();
        received.length = 0;
        const token = await mintSuperAdmin(
          container,
          api,
          'ai-admin@test.dev',
          'ai-admin-pw-1',
        );
        admin = { headers: { authorization: `Bearer ${token}` } };
        const ansonRole = await roleWith(container, 'Anson test', ANSON);
        anson = {
          headers: {
            authorization: `Bearer ${tokenFor(container, 'user_anson_test', [ansonRole])}`,
          },
        };
      });

      const chat = async (
        who: { headers: Record<string, string> },
        message: string,
        extra: object = {},
      ) => {
        const res = await api.post(
          '/admin/assistant/chat',
          { message, ...extra },
          { ...who, responseType: 'text', transformResponse: (d: string) => d },
        );
        expect(res.status).toBe(200);
        return (res.data as string)
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as Record<string, unknown>)
          .filter((e) => e.type !== 'ping');
      };
      const saveKey = () =>
        api.post('/admin/assistant-settings', { openrouter_key: KEY }, admin);

      it('keeps the key write-only and tells a chat with no key where to add it', async () => {
        const before = await chat(admin, 'hello');
        expect(before).toEqual([
          expect.objectContaining({ type: 'error', code: 'no_key' }),
        ]);

        const saved = await saveKey();
        expect(JSON.stringify(saved.data)).not.toContain('0123456789abcdef');
        expect(saved.data.settings.openrouter_key).toEqual({
          set: true,
          readable: true,
          last4: 'WXYZ',
        });
        const got = await api.get('/admin/assistant-settings', admin);
        expect(JSON.stringify(got.data)).not.toContain('0123456789abcdef');

        const test = await api.post(
          '/admin/assistant-settings/test',
          {},
          admin,
        );
        expect(test.data).toEqual({
          ok: true,
          account: { label: 'test', usage: 1.5, limit_remaining: 8.5 },
        });
      });

      it('refuses settings and the review to a limited role', async () => {
        for (const [method, path] of [
          ['get', '/admin/assistant-settings'],
          ['post', '/admin/assistant-settings'],
          ['get', '/admin/assistant-review'],
          // Any id: admin-rbac.ts refuses on the path before the lookup.
          ['get', '/admin/assistant-review/conv_does_not_matter'],
          ['post', '/admin/assistant-settings/test'],
          ['post', '/admin/assistant-settings/voice-test'],
        ] as const) {
          const res = await api[method](
            path,
            ...(method === 'post'
              ? [{}, { ...anson, validateStatus: () => true }]
              : [{ ...anson, validateStatus: () => true }]),
          );
          expect([path, res.status]).toEqual([path, 403]);
        }
        // Holding the review and settings policies (as the desk bots' *:read
        // does) is not enough: these screens are for super admins only.
        const container = getContainer();
        const reviewerRole = await roleWith(container, 'Reviewer test', [
          'assistant_review:read',
          'assistant_setting:read',
          'assistant_setting:update',
        ]);
        const reviewer = {
          headers: {
            authorization: `Bearer ${tokenFor(container, 'user_reviewer_test', [reviewerRole])}`,
          },
        };
        for (const path of [
          '/admin/assistant-settings',
          '/admin/assistant-review',
          '/admin/assistant-review/conv_does_not_matter',
        ]) {
          const res = await api.get(path, {
            ...reviewer,
            validateStatus: () => true,
          });
          expect([path, res.status]).toEqual([path, 403]);
        }
        // A valid body, so only the super-admin check can refuse it.
        for (const [path, body] of [
          ['/admin/assistant-settings', { voice: 'Puck' }],
          ['/admin/assistant-settings/voice-test', {}],
        ] as const) {
          const res = await api.post(path, body, {
            ...reviewer,
            validateStatus: () => true,
          });
          expect([path, res.status]).toEqual([path, 403]);
        }
      });

      it('answers an admin from a real report and saves the question and answer', async () => {
        await saveKey();
        script = (b) =>
          lastIsTool(b)
            ? [say('There are '), say('groups.')]
            : [call('groups', {})];
        const events = await chat(admin, 'how many player groups?');
        expect(
          events.map((e) =>
            e.type === 'tool' ? `tool:${e.name}:${e.status}` : e.type,
          ),
        ).toEqual([
          'conversation',
          'tool:groups:start',
          'tool:groups:done',
          'text',
          'text',
          'done',
        ]);
        // The second request carried the real /reports/finance/groups answer, fenced.
        const toolMsg = received[1].messages.at(-1)!;
        expect(String(toolMsg.content)).toMatch(
          /^<tool_result name="groups">\n\{/,
        );
        expect(String(toolMsg.content)).toContain('default_players');

        const conv = events[0] as { id: string };
        const thread = await api.get(
          `/admin/assistant/conversations/${conv.id}`,
          admin,
        );
        expect(
          thread.data.messages.map((m: { role: string; content: string }) => [
            m.role,
            m.content,
          ]),
        ).toEqual([
          ['user', 'how many player groups?'],
          ['assistant', 'There are groups.'],
        ]);
        expect(thread.data.messages[1].tools).toEqual([
          expect.objectContaining({ name: 'groups', ok: true }),
        ]);
      });

      it('offers a limited role only its tools, and its money question gets no figure', async () => {
        await saveKey();
        script = (b) => {
          if (lastIsTool(b)) return [say('No access.')];
          return toolNames(b).includes('economy')
            ? [call('economy', { period: 'today' })]
            : [call('admin_read', { path: '/admin/economy' })];
        };
        const events = await chat(anson, 'how much did we sell today?');
        expect(toolNames(received[0])).toEqual([
          'order',
          'low_stock',
          'admin_read',
          'remember',
          'recall',
          'forget',
          'search_chats',
          'schedule_task',
          'list_schedules',
          'cancel_schedule',
        ]);
        // Even asked through admin_read, the economy screen answers as Anson: 403.
        const toolMsg = String(received[1].messages.at(-1)!.content);
        expect(toolMsg).toContain(
          'No access: your admin role cannot open /admin/economy',
        );
        expect(events.at(-1)).toMatchObject({ type: 'done' });
        expect(events.find((e) => e.type === 'tool')).toMatchObject({
          name: 'admin_read',
        });
      });

      it("keeps each person's chats to themselves, the review included", async () => {
        await saveKey();
        script = () => [say('ok')];
        const mine = (await chat(admin, 'admin question'))[0] as { id: string };
        const his = (await chat(anson, 'anson question'))[0] as { id: string };

        const list = await api.get('/admin/assistant/conversations', anson);
        expect(
          list.data.conversations.map((c: { id: string }) => c.id),
        ).toEqual([his.id]);
        const peek = await api.get(
          `/admin/assistant/conversations/${mine.id}`,
          {
            ...anson,
            validateStatus: () => true,
          },
        );
        expect(peek.status).toBe(404);
        const del = await api.delete(
          `/admin/assistant/conversations/${mine.id}`,
          { ...anson, validateStatus: () => true },
        );
        expect(del.status).toBe(404);
        const still = await api.get(
          `/admin/assistant/conversations/${mine.id}`,
          admin,
        );
        expect(still.status).toBe(200);
        const other = await chat(anson, 'follow up', {
          conversation_id: mine.id,
        }).catch((e) => e);
        expect(other.response?.status ?? other.status).toBe(404);

        // The super admin's review is their own chats too, asked for
        // someone else's or not.
        for (const path of [
          '/admin/assistant-review',
          `/admin/assistant-review?user_id=${his.id}`,
        ]) {
          const review = await api.get(path, admin);
          expect(
            review.data.conversations.map((c: { id: string }) => c.id),
          ).toEqual([mine.id]);
          expect(review.data.staff).toBeUndefined();
        }
        const theirs = await api.get(`/admin/assistant-review/${his.id}`, {
          ...admin,
          validateStatus: () => true,
        });
        expect(theirs.status).toBe(404);
        const own = await api.get(`/admin/assistant-review/${mine.id}`, admin);
        expect(own.data.conversation.id).toBe(mine.id);
      });

      it('adds up the day’s spend, and deleting a chat does not reset it', async () => {
        await saveKey();
        await api.post(
          '/admin/assistant-settings',
          { daily_cap_usd: 0.5 },
          admin,
        );
        script = () => [say('ok')];
        const first = (await chat(admin, 'first'))[0] as { id: string };
        // What the first answer cost, as if it had been an expensive one.
        const assistant =
          getContainer().resolve<AssistantModuleService>(ASSISTANT_MODULE);
        const [answer] = await assistant.listAssistantMessages({
          conversation_id: first.id,
          role: 'assistant',
        });
        await assistant.updateAssistantMessages({
          id: answer.id,
          cost_usd: 0.6,
        });

        expect(await chat(admin, 'second')).toEqual([
          expect.objectContaining({ type: 'error', code: 'daily_cap' }),
        ]);
        await api.delete(`/admin/assistant/conversations/${first.id}`, admin);
        expect(await chat(admin, 'third')).toEqual([
          expect.objectContaining({ type: 'error', code: 'daily_cap' }),
        ]);
        // The admin still sees their own deleted chat in the review.
        const review = await api.get('/admin/assistant-review', admin);
        expect(review.data.conversations).toEqual([
          expect.objectContaining({ id: first.id, deleted: true }),
        ]);
      });

      it('keeps an image style and reference posts, and goes back to the defaults', async () => {
        const before = (await api.get('/admin/assistant-settings', admin)).data
          .settings;
        expect(before.image_style).toBeNull();
        expect(before.image_style_default).toContain('champagne gold');
        expect(before.style_refs).toEqual([]);
        expect(before.style_refs_default).toHaveLength(3);

        const saved = await api.post(
          '/admin/assistant-settings',
          {
            image_style: 'Neon blue only.',
            // Our own file store: other hosts are refused.
            style_refs: ['http://localhost:9000/static/a.jpg'],
          },
          admin,
        );
        expect(saved.data.settings).toMatchObject({
          image_style: 'Neon blue only.',
          style_refs: ['http://localhost:9000/static/a.jpg'],
        });

        for (const bad of [
          { style_refs: ['http://169.254.169.254/x.jpg'] },
          { style_refs: ['https://cdn.example.com/a.jpg'] },
          { chat_model: 'openai/gpt-5:online' },
          {
            style_refs: Array.from(
              { length: 7 },
              (_, i) => `https://cdn.example.com/${i}.jpg`,
            ),
          },
          { image_style: 'x'.repeat(4001) },
        ]) {
          const res = await api.post('/admin/assistant-settings', bad, {
            ...admin,
            validateStatus: () => true,
          });
          expect(res.status).toBe(400);
        }

        const reset = await api.post(
          '/admin/assistant-settings',
          { image_style: '', style_refs: [] },
          admin,
        );
        expect(reset.data.settings).toMatchObject({
          image_style: null,
          style_refs: [],
        });
      });

      it('refuses an empty or zero daily cap instead of stopping everyone', async () => {
        for (const cap of [null, '', 0]) {
          const res = await api.post(
            '/admin/assistant-settings',
            { daily_cap_usd: cap },
            { ...admin, validateStatus: () => true },
          );
          expect([cap, res.status]).toEqual([cap, 400]);
        }
      });

      it('refuses the chat to a role without the assistant grant', async () => {
        const container = getContainer();
        const plain = await roleWith(container, 'Store only', ['store:read']);
        const res = await api.post(
          '/admin/assistant/chat',
          { message: 'hi' },
          {
            headers: {
              authorization: `Bearer ${tokenFor(container, 'user_plain', [plain])}`,
            },
            validateStatus: () => true,
          },
        );
        expect(res.status).toBe(403);
      });

      it('checks the login before reading a chat body', async () => {
        // Signed out, with a body that would fail to parse: refused as signed
        // out (401), so nobody signed out makes the server read 10 MB.
        const res = await api.post('/admin/assistant/chat', '{"message": ', {
          headers: { 'content-type': 'application/json' },
          validateStatus: () => true,
        });
        expect(res.status).toBe(401);
      });

      it('hears a spoken question, answers it, and reads the answer aloud within the cap', async () => {
        await saveKey();
        const container = getContainer();
        const lines = (raw: string) =>
          raw
            .split('\n')
            .filter(Boolean)
            .map((l) => JSON.parse(l) as Record<string, unknown>)
            .filter((e) => e.type !== 'ping');

        // Settings: a voice of the speaking model, from OpenRouter's list; a
        // chat voice model (it answers what it should read) is not one.
        const bad = await api.post(
          '/admin/assistant-settings',
          { voice: 'robot' },
          { ...admin, validateStatus: () => true },
        );
        expect(bad.status).toBe(400);
        const noVoice = await api.post(
          '/admin/assistant-settings',
          { voice: null },
          { ...admin, validateStatus: () => true },
        );
        expect(noVoice.status).toBe(400);
        const chatVoice = await api.post(
          '/admin/assistant-settings',
          { voice_model: 'openai/gpt-audio-mini', voice: 'alloy' },
          { ...admin, validateStatus: () => true },
        );
        expect(chatVoice.status).toBe(400);
        const set = await api.post(
          '/admin/assistant-settings',
          { voice: 'Puck' },
          admin,
        );
        expect(set.data.settings).toMatchObject({
          stt_model: 'google/gemini-3.5-flash-lite',
          voice_model: 'google/gemini-3.8-flash-lite-tts',
          voice: 'Puck',
          // each dropdown: the models that can do that field's job
          chat_models: [
            'anthropic/claude-sonnet-5.5',
            'google/gemini-3.5-flash-lite',
          ],
          image_models: ['google/gemini-3.1-flash-image'],
          stt_models: ['google/gemini-3.5-flash-lite'],
          speech_models: [
            {
              id: 'google/gemini-3.8-flash-lite-tts',
              voices: ['Kore', 'Puck'],
            },
          ],
        });

        // "Hear it" takes no model that could fetch the web.
        const online = await api.post(
          '/admin/assistant-settings/voice-test',
          { voice_model: 'openai/gpt-5:online' },
          { ...admin, validateStatus: () => true },
        );
        expect(online.status).toBe(400);
        expect(online.data.message).toMatch(/voice_model/);

        // Anything but a 16 kHz mono 16-bit WAV is refused before listening.
        const notWav = await api.post(
          '/admin/assistant/chat',
          { message: '', audio: Buffer.from('hello').toString('base64') },
          { ...admin, validateStatus: () => true },
        );
        expect(notWav.status).toBe(400);
        expect(notWav.data.message).toMatch(/16 ?kHz/i);
        expect(notWav.data.message).toMatch(/wav/i);

        // A spoken question is written down, then asked like a typed one.
        heardText = 'how many player groups?';
        voiceCalls.length = 0;
        script = (b) =>
          lastIsTool(b) ? [say('There are 0 groups.')] : [call('groups', {})];
        const events = await chat(admin, '', { audio: wav16k(500) });
        expect(events[0]).toEqual({
          type: 'transcript',
          text: 'how many player groups?',
        });
        expect(voiceCalls[0].model).toBe('google/gemini-3.5-flash-lite');
        const done = events.at(-1) as { type: string; message_id: string };
        expect(done.type).toBe('done');

        // Read aloud in the set voice.
        const spoken = await api.post(
          '/admin/assistant/speak',
          { message_id: done.message_id },
          {
            ...admin,
            responseType: 'text',
            transformResponse: (d: string) => d,
          },
        );
        const heard = lines(spoken.data as string);
        expect(heard[0]).toEqual({ type: 'format', rate: 24000 });
        expect(heard.at(-1)?.type).toBe('done');
        expect(heard.slice(1, -1).every((e) => e.type === 'audio')).toBe(true);
        expect(voiceCalls[1]).toEqual({
          model: 'google/gemini-3.8-flash-lite-tts',
          input: 'There are 0 groups.',
          voice: 'Puck',
          response_format: 'pcm',
        });

        // The thread shows the question as heard, never the voice row.
        const conv = (events[1] as { id: string }).id;
        const thread = await api.get(
          `/admin/assistant/conversations/${conv}`,
          admin,
        );
        expect(
          thread.data.messages.map((m: { role: string; content: string }) => [
            m.role,
            m.content,
          ]),
        ).toEqual([
          ['user', 'how many player groups?'],
          ['assistant', 'There are 0 groups.'],
        ]);

        // Listening, both answer rounds and the reading all count today.
        const assistant =
          container.resolve<AssistantModuleService>(ASSISTANT_MODULE);
        const [row] = await assistant.listAssistantConversations({ id: conv });
        // The reading counts at once as an estimate, then as OpenRouter's
        // own figure once it is looked up.
        const expected = 0.001 * 2 + 0.0003 + 0.002;
        let spent = await assistant.spentToday(row.user_id);
        for (let i = 0; i < 150 && Math.abs(spent - expected) > 1e-9; i++) {
          await new Promise((r) => setTimeout(r, 100));
          spent = await assistant.spentToday(row.user_id);
        }
        expect(spent).toBeCloseTo(expected, 6);

        // Heard again in the same voice: the stored speech, free, no new call.
        const calls = voiceCalls.length;
        const again = lines(
          (
            await api.post(
              '/admin/assistant/speak',
              { message_id: done.message_id },
              {
                ...admin,
                responseType: 'text',
                transformResponse: (d: string) => d,
              },
            )
          ).data as string,
        );
        expect(again[0]).toEqual({ type: 'format', rate: 24000 });
        expect(again.slice(1, -1).every((e) => e.type === 'audio')).toBe(true);
        expect(again.at(-1)).toEqual({ type: 'done', cost_usd: 0 });
        expect(
          Buffer.concat(
            again
              .slice(1, -1)
              .map((e) => Buffer.from(e.data as string, 'base64')),
          ),
        ).toEqual(
          Buffer.concat([
            Buffer.from('AAAA', 'base64'),
            Buffer.from('BBBB', 'base64'),
          ]),
        );
        expect(voiceCalls.length).toBe(calls);
        expect(await assistant.spentToday(row.user_id)).toBeCloseTo(spent, 6);

        // Someone else cannot have it read to them, even with chats of his own.
        script = () => [say('ok')];
        await chat(anson, 'anson question');
        const other = await api.post(
          '/admin/assistant/speak',
          { message_id: done.message_id },
          { ...anson, validateStatus: () => true },
        );
        expect(other.status).toBe(404);
      });

      it('reads a stock screen as Anson, and takes a screenshot of about 1 MB', async () => {
        await saveKey();
        script = (b) =>
          lastIsTool(b)
            ? [say('Stock checked.')]
            : [
                call('admin_read', {
                  path: '/admin/inventory',
                  params: { limit: 5 },
                }),
              ];
        const shot = `data:image/jpeg;base64,${Buffer.alloc(1_000_000, 7).toString('base64')}`;
        const events = await chat(anson, 'what is in stock?', {
          images: [shot],
        });
        expect(events.at(-1)).toMatchObject({ type: 'done' });
        const toolMsg = String(received[1].messages.at(-1)!.content);
        expect(toolMsg).not.toContain('No access');
        // capBody's whole-page wrapper around the inventory route's { rows }.
        expect(toolMsg).toContain('"truncated":false,"data":{"rows":');
        // The screenshot reached the model with the question.
        const question = received[0].messages.at(-1)!.content as {
          type: string;
        }[];
        expect(question.map((p) => p.type)).toEqual(['text', 'image_url']);
      });

      // One tool call, then a short answer.
      const once = (name: string, args: object, reply = 'ok') => {
        script = (b) => (lastIsTool(b) ? [say(reply)] : [call(name, args)]);
      };
      const lastTool = () => String(received.at(-1)!.messages.at(-1)!.content);
      // Anthropic models get the system prompt as cached content parts.
      const system = () => {
        const c = received.at(-1)!.messages[0].content;
        return Array.isArray(c)
          ? (c as { text?: string }[]).map((p) => p.text ?? '').join('')
          : String(c);
      };

      // A note or task is only proposed in the stream; the person's tap
      // (POST /admin/assistant/confirm) saves it.
      const tokenOf = (events: Record<string, unknown>[]) =>
        String(events.find((e) => e.type === 'confirm')?.token ?? '');
      const tap = (who: typeof admin, token: string) =>
        api.post(
          '/admin/assistant/confirm',
          { token },
          { ...who, validateStatus: () => true },
        );

      it('keeps notes per person, shares one only for an admin, and searches past chats', async () => {
        await saveKey();
        once('remember', {
          note: 'Restock the 151 boxes on Fridays.',
          shared: true,
        });
        await chat(anson, 'remember for everyone: restock Fridays');
        expect(lastTool()).toContain(
          'Only an admin can save a note for everyone',
        );
        once('remember', { note: 'Restock the 151 boxes on Fridays.' });
        const asked = await chat(anson, 'remember: restock Fridays');
        expect(lastTool()).toContain('"saved":false');
        script = () => [say('ok')];
        await chat(anson, 'hello');
        // proposed only: not in his notes until he taps Save
        expect(system()).not.toContain('Restock the 151 boxes on Fridays.');
        // nobody else can save it for him
        expect((await tap(admin, tokenOf(asked))).status).toBe(400);
        const saved = await tap(anson, tokenOf(asked));
        expect(saved.status).toBe(200);
        expect(saved.data).toMatchObject({ saved: true, kind: 'note' });

        await chat(anson, 'hello');
        expect(system()).toContain('Restock the 151 boxes on Fridays.');
        await chat(admin, 'hello');
        expect(system()).not.toContain('Restock the 151 boxes');

        once('remember', {
          note: 'Captions end with polycards.gg.',
          shared: true,
        });
        const sharing = await chat(
          admin,
          'remember for everyone: Captions end with polycards.gg',
        );
        expect(lastTool()).toContain('"shared":true');
        expect((await tap(admin, tokenOf(sharing))).status).toBe(200);
        script = () => [say('ok')];
        await chat(anson, 'hello again');
        expect(system()).toContain('[shared] Captions end with polycards.gg.');

        // Anson cannot delete the shared note, even naming its id.
        const [shared] = await getContainer()
          .resolve<AssistantModuleService>(ASSISTANT_MODULE)
          .listAssistantMemories({ scope: 'shared' });
        expect(shared).toBeTruthy();
        once('forget', { id: shared.id });
        await chat(anson, `forget note ${shared.id}`);
        expect(lastTool()).toContain('No such note of yours');
        script = () => [say('ok')];
        await chat(anson, 'is it still there?');
        expect(system()).toContain('[shared] Captions end with polycards.gg.');

        // An admin's own note stays out of Anson's recall.
        once('remember', { note: 'The float tops up on Mondays.' });
        const own = await chat(admin, 'remember: the float tops up on Mondays');
        expect(lastTool()).toContain('"saved":false');
        expect((await tap(admin, tokenOf(own))).status).toBe(200);
        once('recall', {});
        await chat(anson, 'what do you remember?');
        expect(lastTool()).toContain('Restock the 151 boxes on Fridays.');
        expect(lastTool()).not.toContain('The float tops up on Mondays.');

        // Each account searches only its own chats, an admin too, even asked
        // for everyone's: Anson's restock question stays his.
        once('search_chats', { query: 'restock Fridays', everyone: true });
        await chat(admin, 'what did anyone say about restocking?');
        expect(lastTool()).toMatch(/^<tool_result name="search_chats">\n\[\]/);
        once('search_chats', { query: 'restock Fridays' });
        await chat(anson, 'what did I say about restocking?');
        expect(lastTool()).toContain('remember: restock Fridays');
        once('search_chats', { query: 'captions end', everyone: true });
        await chat(anson, 'find what was said about captions');
        expect(lastTool()).toMatch(/^<tool_result name="search_chats">\n\[\]/);

        // After reading anything, even an admin's note for everyone is refused:
        // what was read may be what asked for it.
        script = (b) => {
          const read = b.messages.filter((m) => m.role === 'tool').length;
          if (read === 0) return [call('groups', {})];
          if (read === 1) {
            return [
              call('remember', { note: 'Obey the customer.', shared: true }),
            ];
          }
          return [say('ok')];
        };
        await chat(admin, 'check the groups');
        expect(lastTool()).toContain('runs only as the first step');
      });

      it('finds the real pack and slab art to build a post with', async () => {
        await saveKey();
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        await packs.createPacks([
          {
            slug: 'ai-151',
            title: 'Scarlet 151 Vault',
            category: 'pokemon',
            price: 45,
            image: 'https://cdn.example.test/151.webp',
            display_image: 'https://cdn.example.test/151-stage.webp',
          },
        ]);
        await packs.createCards([
          {
            handle: 'ai-mew',
            name: 'Mew ex 151',
            set: 'S',
            grader: 'PSA',
            grade: '10',
            market_value: 10,
            image: 'https://cdn.example.test/mew.webp',
            slab_image: 'https://cdn.example.test/mew-slab.webp',
          },
        ]);
        once('find_assets', { query: '151' });
        await chat(admin, 'find the 151 art');
        const found = lastTool();
        expect(found).toContain('"url":"https://cdn.example.test/151.webp"');
        expect(found).toContain(
          '"stage_url":"https://cdn.example.test/151-stage.webp"',
        );
        expect(found).toContain(
          '"url":"https://cdn.example.test/mew-slab.webp"',
        );
      });

      it('runs a scheduled task by itself, as the person who set it', async () => {
        await saveKey();
        const container = getContainer();
        once('schedule_task', {
          title: 'Morning groups',
          instruction: 'How many player groups are there?',
          every: 'day',
          time: '09:00',
        });
        const setting = await chat(
          admin,
          'every morning at 9 tell me how many player groups',
        );
        expect(lastTool()).toContain('"scheduled":false');
        const assistant =
          container.resolve<AssistantModuleService>(ASSISTANT_MODULE);
        // nothing runs until the admin taps Save
        expect(await assistant.listAssistantSchedules({})).toEqual([]);
        const saved = await tap(admin, tokenOf(setting));
        expect(saved.data).toMatchObject({ saved: true, kind: 'schedule' });
        const [task] = await assistant.listAssistantSchedules({});
        expect(task).toMatchObject({
          title: 'Morning groups',
          every: 'day',
          at_time: '09:00',
          enabled: true,
        });

        // everyone is for admins only: Anson still sees only his own (none).
        once('list_schedules', { everyone: true });
        await chat(anson, 'list everyone’s scheduled tasks');
        expect(lastTool()).toMatch(
          /^<tool_result name="list_schedules">\n\[\]/,
        );
        expect(lastTool()).not.toContain(task.id);

        once('cancel_schedule', { id: task.id });
        await chat(anson, 'cancel that task');
        expect(lastTool()).toContain('No such scheduled task of yours');

        // Due now: the job asks the chat as the admin, in a chat of its own.
        await assistant.updateAssistantSchedules({
          id: task.id,
          next_run_at: new Date(Date.now() - 1000),
        });
        script = (b) =>
          lastIsTool(b) ? [say('There are 3 groups.')] : [call('groups', {})];
        expect(
          await runDueSchedules(container, {
            base: api.defaults.baseURL as string,
            wait: true,
          }),
        ).toBe(1);
        // Unwatched, the run cannot save notes or set or cancel tasks.
        const unattended = received.find((b) =>
          String(b.messages.at(-1)?.content).startsWith('⏰'),
        )!;
        expect(toolNames(unattended)).toContain('groups');
        expect(toolNames(unattended)).toContain('list_schedules');
        for (const name of [
          'remember',
          'forget',
          'schedule_task',
          'cancel_schedule',
        ]) {
          expect(toolNames(unattended)).not.toContain(name);
        }
        const [after] = await assistant.listAssistantSchedules({ id: task.id });
        expect(after.last_error).toBeNull();
        expect(after.conversation_id).toBeTruthy();
        expect(new Date(after.next_run_at).getTime()).toBeGreaterThan(
          Date.now(),
        );
        const thread = await api.get(
          `/admin/assistant/conversations/${after.conversation_id}`,
          admin,
        );
        expect(
          thread.data.messages.map((m: { role: string; content: string }) => [
            m.role,
            m.content,
          ]),
        ).toEqual([
          [
            'user',
            '⏰ Scheduled task “Morning groups”: How many player groups are there?',
          ],
          ['assistant', 'There are 3 groups.'],
        ]);
        // Nothing else is due.
        expect(await runDueSchedules(container)).toBe(0);
      });
    });
  },
});
