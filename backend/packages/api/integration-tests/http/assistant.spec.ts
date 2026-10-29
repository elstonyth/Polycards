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
import { mintSuperAdmin } from './utils';

jest.setTimeout(240 * 1000);

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

const fake = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
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
        ] as const) {
          const res = await api[method](
            path,
            ...(method === 'post'
              ? [{}, { ...anson, validateStatus: () => true }]
              : [{ ...anson, validateStatus: () => true }]),
          );
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

      it("keeps each person's chats to themselves; the review lists everyone's", async () => {
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
        const other = await chat(anson, 'follow up', {
          conversation_id: mine.id,
        }).catch((e) => e);
        expect(other.response?.status ?? other.status).toBe(404);

        const review = await api.get('/admin/assistant-review', admin);
        expect(
          review.data.conversations.map((c: { id: string }) => c.id).sort(),
        ).toEqual([mine.id, his.id].sort());
        expect(
          review.data.conversations.find(
            (c: { id: string }) => c.id === mine.id,
          ).user_email,
        ).toBe('ai-admin@test.dev');
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
        // The owner still sees the deleted chat in the review.
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
            style_refs: ['https://cdn.example.com/a.jpg'],
          },
          admin,
        );
        expect(saved.data.settings).toMatchObject({
          image_style: 'Neon blue only.',
          style_refs: ['https://cdn.example.com/a.jpg'],
        });

        for (const bad of [
          { style_refs: ['http://169.254.169.254/x.jpg'] },
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
        expect(toolMsg).toContain('truncated');
        // The screenshot reached the model with the question.
        const question = received[0].messages.at(-1)!.content as {
          type: string;
        }[];
        expect(question.map((p) => p.type)).toEqual(['text', 'image_url']);
      });
    });
  },
});
