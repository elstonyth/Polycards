import type { MedusaContainer } from '@medusajs/framework/types';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
import { ASSISTANT_MODULE } from '../../../../modules/assistant';
import { nextRun, runDueSchedules, SCHEDULED_PREFIX } from '../schedule';

// 2026-10-29 is a Thursday; Malaysia time is UTC+8.
const at = (iso: string) => new Date(iso);

describe('nextRun', () => {
  it('runs daily at the Malaysia time, strictly after now', () => {
    // 08:00 MYT → 09:00 MYT the same day.
    expect(
      nextRun({ every: 'day', at_time: '09:00' }, at('2026-10-29T00:00:00Z')),
    ).toEqual(at('2026-10-29T01:00:00Z'));
    // Exactly 09:00 MYT → tomorrow.
    expect(
      nextRun({ every: 'day', at_time: '09:00' }, at('2026-10-29T01:00:00Z')),
    ).toEqual(at('2026-10-30T01:00:00Z'));
    // Just after midnight MYT (16:00 UTC the day before).
    expect(
      nextRun({ every: 'day', at_time: '00:30' }, at('2026-10-29T16:00:00Z')),
    ).toEqual(at('2026-10-29T16:30:00Z'));
  });

  it('runs weekly on the Malaysia weekday', () => {
    // Thursday 08:00 MYT → Monday 10:00 MYT.
    expect(
      nextRun(
        { every: 'week', at_time: '10:00', weekday: 1 },
        at('2026-10-29T00:00:00Z'),
      ),
    ).toEqual(at('2026-11-02T02:00:00Z'));
    // Thursday 07:00 MYT has passed → next Thursday.
    expect(
      nextRun(
        { every: 'week', at_time: '07:00', weekday: 4 },
        at('2026-10-29T00:00:00Z'),
      ),
    ).toEqual(at('2026-11-04T23:00:00Z'));
    // Wednesday 23:30 UTC is already Thursday in Malaysia.
    expect(
      nextRun(
        { every: 'week', at_time: '09:00', weekday: 4 },
        at('2026-10-28T23:30:00Z'),
      ),
    ).toEqual(at('2026-10-29T01:00:00Z'));
  });

  it('refuses a bad time or weekday', () => {
    const now = at('2026-10-29T00:00:00Z');
    expect(() => nextRun({ every: 'day', at_time: '24:00' }, now)).toThrow(
      'HH:MM',
    );
    expect(() => nextRun({ every: 'day', at_time: '9am' }, now)).toThrow();
    expect(() =>
      nextRun({ every: 'week', at_time: '09:00', weekday: 8 }, now),
    ).toThrow('weekday');
  });
});

describe('runDueSchedules', () => {
  const NOW = at('2026-10-29T01:00:00Z');
  const task = (over: Record<string, unknown> = {}) => ({
    id: 'aisch_1',
    user_id: 'user_1',
    title: 'Top hits',
    instruction: "Send yesterday's top 5 pulls.",
    every: 'day',
    at_time: '09:00',
    weekday: null,
    next_run_at: NOW,
    conversation_id: null,
    ...over,
  });

  function setup(opts: {
    tasks: ReturnType<typeof task>[];
    claimed?: boolean;
    roles?: string[];
    body?: string;
    status?: number;
    first?: Response;
  }) {
    const claims: Record<string, unknown>[] = [];
    const chain = {
      where: () => chain,
      whereNull: () => chain,
      update: (v: Record<string, unknown>) => {
        claims.push(v);
        return chain;
      },
      returning: async () => (opts.claimed === false ? [] : [{ id: 'x' }]),
    };
    const updates: Record<string, unknown>[] = [];
    const deps: Record<string, unknown> = {
      [ASSISTANT_MODULE]: {
        listAssistantSchedules: jest.fn(async () => opts.tasks),
        updateAssistantSchedules: jest.fn(async (v) => updates.push(v)),
      },
      [ContainerRegistrationKeys.PG_CONNECTION]: () => chain,
      [ContainerRegistrationKeys.LOGGER]: { info: jest.fn(), warn: jest.fn() },
      [ContainerRegistrationKeys.QUERY]: {
        graph: jest.fn(async () => ({
          data: [
            {
              id: 'user_1',
              rbac_roles: (opts.roles ?? ['support_viewer']).map((id) => ({
                id,
              })),
            },
          ],
        })),
      },
      [ContainerRegistrationKeys.CONFIG_MODULE]: {
        projectConfig: { http: { jwtSecret: 'test-secret', jwtOptions: {} } },
      },
    };
    const container = {
      resolve: (k: string) => deps[k],
    } as unknown as MedusaContainer;
    let first = opts.first;
    const fetchImpl = jest.fn(
      async () =>
        (first ? ((r) => ((first = undefined), r))(first) : null) ??
        new Response(
          opts.body ??
            '{"type":"conversation","id":"aiconv_9"}\n{"type":"text","delta":"hi"}\n{"type":"done"}\n',
          { status: opts.status ?? 200 },
        ),
    );
    const run = () =>
      runDueSchedules(container, {
        now: NOW,
        base: 'http://srv',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
    return { run, fetchImpl, claims, updates };
  }

  it('asks the chat as the staff member, with their current roles', async () => {
    const s = setup({ tasks: [task()] });
    expect(await s.run()).toBe(1);
    // Claimed by moving the next run to tomorrow first.
    expect(s.claims[0]).toEqual({
      next_run_at: at('2026-10-30T01:00:00Z'),
      last_run_at: NOW,
    });
    const [url, init] = s.fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe('http://srv/admin/assistant/chat');
    const body = JSON.parse(init.body as string);
    expect(body.message).toBe(
      `${SCHEDULED_PREFIX} “Top hits”: Send yesterday's top 5 pulls.`,
    );
    expect(body.conversation_id).toBeUndefined();
    const token = (init.headers as Record<string, string>).authorization;
    const claims = JSON.parse(
      Buffer.from(token.split('.')[1], 'base64url').toString(),
    );
    expect(claims).toMatchObject({
      actor_id: 'user_1',
      actor_type: 'user',
      app_metadata: { user_id: 'user_1', roles: ['support_viewer'] },
    });
    expect(s.updates).toEqual([
      { id: 'aisch_1', conversation_id: 'aiconv_9', last_error: null },
    ]);
  });

  it('skips a task another worker already claimed', async () => {
    const s = setup({ tasks: [task()], claimed: false });
    expect(await s.run()).toBe(0);
    expect(s.fetchImpl).not.toHaveBeenCalled();
  });

  it('retries in two minutes when the person is mid-chat', async () => {
    const s = setup({
      tasks: [task({ conversation_id: 'aiconv_9' })],
      body: '{"type":"error","code":"busy","message":"Your previous question is still being answered."}\n',
    });
    await s.run();
    expect(s.updates).toEqual([
      {
        id: 'aisch_1',
        last_error: 'Your previous question is still being answered.',
        next_run_at: at('2026-10-29T01:02:00Z'),
      },
    ]);
  });

  it('records why a run failed and keeps the schedule', async () => {
    const s = setup({
      tasks: [task()],
      body: '{"type":"error","code":"daily_cap","message":"Daily limit reached."}\n',
    });
    await s.run();
    expect(s.updates).toEqual([
      { id: 'aisch_1', last_error: 'Daily limit reached.' },
    ]);
  });

  it('refuses to run for someone who lost every role', async () => {
    const s = setup({ tasks: [task()], roles: [] });
    await s.run();
    expect(s.fetchImpl).not.toHaveBeenCalled();
    expect(s.updates[0]).toMatchObject({
      last_error: expect.stringContaining('no longer has an admin role'),
    });
  });

  it('runs in a new chat when the old one was deleted', async () => {
    const s = setup({
      tasks: [task({ conversation_id: 'aiconv_gone' })],
      first: new Response('{"message":"That conversation was not found."}', {
        status: 404,
      }),
    });
    await s.run();
    const bodies = s.fetchImpl.mock.calls.map((c) =>
      JSON.parse((c as unknown as [string, RequestInit])[1].body as string),
    );
    expect(bodies.map((b) => b.conversation_id)).toEqual([
      'aiconv_gone',
      undefined,
    ]);
    expect(s.updates).toEqual([
      { id: 'aisch_1', conversation_id: 'aiconv_9', last_error: null },
    ]);
  });
});
