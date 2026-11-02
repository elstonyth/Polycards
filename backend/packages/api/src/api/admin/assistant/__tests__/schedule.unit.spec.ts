import type { MedusaContainer } from '@medusajs/framework/types';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
import { ASSISTANT_MODULE } from '../../../../modules/assistant';
import {
  nextRun,
  runDueSchedules,
  SCHEDULED_PREFIX,
  serverUrl,
  STARTED_NOTE,
} from '../schedule';

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

describe('serverUrl', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });
  const at = (base: string) => {
    delete process.env.ASSISTANT_SERVER_URL;
    process.env.PAYMENT_CALLBACK_BASE = base;
    return serverUrl();
  };

  it('sends the owner’s token only over https, to this machine or an internal name', () => {
    expect(at('https://polycards-backend-x.ondigitalocean.app/')).toBe(
      'https://polycards-backend-x.ondigitalocean.app',
    );
    expect(at('http://127.0.0.1:9000')).toBe('http://127.0.0.1:9000');
    expect(at('http://backend:8080')).toBe('http://backend:8080');
    // a tunnel or a plain public address never gets a super admin's token
    expect(() => at('http://abc.trycloudflare.com')).toThrow(/https/);
    expect(() => at('http://203.0.113.9')).toThrow(/https/);
    expect(() => at('not a url')).toThrow(/https/);
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
    now?: Date;
    fetchImpl?: jest.Mock;
  }) {
    // Every pg query: what it filtered on and what it wrote. [0] is the claim.
    type Query = {
      where?: Record<string, unknown>;
      whereNull?: string;
      update?: Record<string, unknown>;
    };
    const queries: Query[] = [];
    const pg = () => {
      const q: Query = {};
      queries.push(q);
      const chain = {
        where: (v: Record<string, unknown>) => ((q.where = v), chain),
        whereNull: (c: string) => ((q.whereNull = c), chain),
        update: (v: Record<string, unknown>) => ((q.update = v), chain),
        returning: async () => (opts.claimed === false ? [] : [{ id: 'x' }]),
      };
      return chain;
    };
    let done!: () => void;
    const finished = new Promise<void>((r) => (done = r));
    const logger = {
      info: jest.fn(() => done()),
      warn: jest.fn(() => done()),
      error: jest.fn(),
    };
    const list = jest.fn(async (_filter: unknown) => opts.tasks);
    const graph = jest.fn(async (_query: unknown) => ({
      data: [
        {
          id: 'user_1',
          rbac_roles: (opts.roles ?? ['support_viewer']).map((id) => ({
            id,
          })),
        },
      ],
    }));
    const deps: Record<string, unknown> = {
      [ASSISTANT_MODULE]: {
        listAssistantSchedules: list,
        // As Medusa does for a soft-deleted (cancelled) row: the job must not
        // write through it.
        updateAssistantSchedules: jest.fn(async () => {
          throw new Error('AssistantSchedule with id: aisch_1 was not found');
        }),
      },
      [ContainerRegistrationKeys.PG_CONNECTION]: pg,
      [ContainerRegistrationKeys.LOGGER]: logger,
      [ContainerRegistrationKeys.QUERY]: { graph },
      [ContainerRegistrationKeys.CONFIG_MODULE]: {
        projectConfig: { http: { jwtSecret: 'test-secret', jwtOptions: {} } },
      },
    };
    const container = {
      resolve: (k: string) => deps[k],
    } as unknown as MedusaContainer;
    let first = opts.first;
    const fetchImpl =
      opts.fetchImpl ??
      jest.fn(
        async () =>
          (first ? ((r) => ((first = undefined), r))(first) : null) ??
          new Response(
            opts.body ??
              '{"type":"conversation","id":"aiconv_9"}\n{"type":"text","delta":"hi"}\n{"type":"done"}\n',
            { status: opts.status ?? 200 },
          ),
      );
    const run = (extra: { wait?: boolean } = {}) =>
      runDueSchedules(container, {
        now: opts.now ?? NOW,
        base: 'http://srv',
        fetchImpl: fetchImpl as unknown as typeof fetch,
        wait: true,
        ...extra,
      });
    return { run, fetchImpl, queries, list, graph, logger, finished };
  }

  it('asks the chat as the staff member, with their current roles', async () => {
    const s = setup({ tasks: [task()] });
    expect(await s.run()).toBe(1);
    expect(s.list.mock.calls[0][0]).toEqual({
      enabled: true,
      next_run_at: { $lte: NOW },
    });
    // Claimed by moving the next run to tomorrow first, only if no one else
    // has, marked started until the result is in.
    expect(s.queries[0]).toEqual({
      where: { id: 'aisch_1', next_run_at: NOW },
      whereNull: 'deleted_at',
      update: {
        next_run_at: at('2026-10-30T01:00:00Z'),
        last_run_at: NOW,
        last_error: STARTED_NOTE,
      },
    });
    expect(s.graph.mock.calls[0][0]).toMatchObject({
      filters: { id: 'user_1' },
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
    // It carries every role the owner has, so it lives only a minute.
    expect(claims.exp - claims.iat).toBe(60);
    // The started note is cleared with the result.
    expect(s.queries[1]).toEqual({
      where: { id: 'aisch_1' },
      whereNull: 'deleted_at',
      update: { conversation_id: 'aiconv_9', last_error: null },
    });
  });

  it('skips a task another worker already claimed', async () => {
    const s = setup({ tasks: [task()], claimed: false });
    expect(await s.run()).toBe(0);
    expect(s.fetchImpl).not.toHaveBeenCalled();
  });

  it('returns without waiting for the answer, and never starts it twice', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const s = setup({
      tasks: [task({ id: 'aisch_slow' })],
      fetchImpl: jest.fn(async () => {
        await gate;
        return new Response('{"type":"conversation","id":"aiconv_9"}\n');
      }),
    });
    // As the job calls it: back at once, the answer still coming.
    expect(await s.run({ wait: undefined })).toBe(1);
    expect(s.queries).toHaveLength(1);
    // Still running here: the next tick leaves it alone, unclaimed.
    expect(await s.run({ wait: undefined })).toBe(0);
    expect(s.queries).toHaveLength(1);
    release();
    await s.finished;
    expect(s.fetchImpl).toHaveBeenCalledTimes(1);
    expect(s.queries[1].update).toEqual({
      conversation_id: 'aiconv_9',
      last_error: null,
    });
  });

  it('retries in two minutes when the person is mid-chat', async () => {
    const s = setup({
      tasks: [task({ conversation_id: 'aiconv_9' })],
      body: '{"type":"error","code":"busy","message":"Your previous question is still being answered."}\n',
    });
    await s.run();
    expect(s.queries[1].update).toEqual({
      last_error: 'Your previous question is still being answered.',
      conversation_id: 'aiconv_9',
      next_run_at: at('2026-10-29T01:02:00Z'),
    });
  });

  it('records why a run failed and keeps the schedule', async () => {
    const s = setup({
      tasks: [task()],
      body: '{"type":"error","code":"daily_cap","message":"Daily limit reached."}\n',
    });
    await s.run();
    expect(s.queries[1].update).toEqual({
      last_error: 'Daily limit reached.',
      conversation_id: null,
    });
  });

  it('keeps the chat a failed run made, and retries a hiccup in 5 minutes', async () => {
    const s = setup({
      tasks: [task()],
      body: '{"type":"conversation","id":"aiconv_9"}\n{"type":"error","message":"The assistant hit a problem. Try again in a moment."}\n',
    });
    await s.run();
    expect(s.queries[1].update).toEqual({
      last_error: 'The assistant hit a problem. Try again in a moment.',
      conversation_id: 'aiconv_9',
      next_run_at: at('2026-10-29T01:05:00Z'),
    });
  });

  it('retries a 5xx or 429 answer, not another 4xx', async () => {
    for (const [status, retried] of [
      [503, true],
      [429, true],
      [400, false],
    ] as const) {
      const s = setup({ tasks: [task()], status, body: '{"message":"no"}' });
      await s.run();
      expect(s.queries[1].update).toMatchObject({ last_error: 'no' });
      expect(Boolean(s.queries[1].update?.next_run_at)).toBe(retried);
    }
  });

  it('stops retrying 20 minutes after the slot', async () => {
    for (const fail of [
      {
        fetchImpl: jest.fn(async () => {
          throw new TypeError('fetch failed');
        }),
      },
      {
        body: '{"type":"error","code":"busy","message":"Still answering."}\n',
      },
    ]) {
      const s = setup({
        tasks: [task()],
        now: at('2026-10-29T01:20:00Z'),
        ...fail,
      });
      await s.run();
      expect(s.queries[1].update).toHaveProperty('last_error');
      expect(s.queries[1].update).not.toHaveProperty('next_run_at');
    }
  });

  it('writes nothing, and throws nothing, for a task cancelled mid-run', async () => {
    const s = setup({
      tasks: [task()],
      body: '{"type":"error","code":"daily_cap","message":"Daily limit reached."}\n',
    });
    await expect(s.run()).resolves.toBe(1);
    expect(s.queries[1].whereNull).toBe('deleted_at');
    expect(s.logger.error).not.toHaveBeenCalled();
  });

  it('refuses to run for someone who lost every role', async () => {
    const s = setup({ tasks: [task()], roles: [] });
    await s.run();
    expect(s.fetchImpl).not.toHaveBeenCalled();
    expect(s.queries[1].update).toEqual({
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
    expect(s.queries[1].update).toEqual({
      conversation_id: 'aiconv_9',
      last_error: null,
    });
  });

  it('forgets the deleted chat when the run in a new one fails', async () => {
    const s = setup({
      tasks: [task({ conversation_id: 'aiconv_gone' })],
      fetchImpl: jest
        .fn()
        .mockResolvedValueOnce(
          new Response('{"message":"That conversation was not found."}', {
            status: 404,
          }),
        )
        .mockRejectedValueOnce(new TypeError('fetch failed')),
    });
    await s.run();
    // A dropped connection: retried in 5 minutes, inside the slot's window.
    expect(s.queries[1].update).toEqual({
      last_error: 'fetch failed',
      conversation_id: null,
      next_run_at: at('2026-10-29T01:05:00Z'),
    });
  });
});
