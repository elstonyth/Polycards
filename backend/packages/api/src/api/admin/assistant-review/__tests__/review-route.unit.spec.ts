import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
import { GET, reviewFilter } from '../route';
import { accessFor } from '../../assistant/access';

// GET /admin/assistant-review with pg faked: always the signed-in account's
// own chats, the search, the per-chat numbers and the gate. The SQL itself is
// pinned by text here; what it counts was checked on Postgres.

jest.mock('../../assistant/access', () => ({ accessFor: jest.fn() }));

const accessMock = accessFor as jest.Mock;

function setup(stats: Record<string, unknown>[] = []) {
  // Answers by the query's shape: count, per-chat numbers, page.
  const raw = jest.fn(async (sql: string, _bindings?: unknown[]) => {
    if (sql.includes('as n from')) return { rows: [{ n: 1 }] };
    if (sql.includes('group by')) return { rows: stats };
    return {
      rows: [
        {
          id: 'c1',
          title: 'Top hits',
          user_id: 'u1',
          last_message_at: new Date(),
          deleted_at: null,
        },
        {
          id: 'c2',
          title: 'Empty',
          user_id: 'u1',
          last_message_at: new Date(),
          deleted_at: new Date(),
        },
      ],
    };
  });
  const call = (part: string) => {
    const c = raw.mock.calls.find(([sql]) => sql.includes(part));
    if (!c) throw new Error(`no query with ${part}`);
    return { sql: c[0], bindings: c[1] };
  };
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  const run = (query: Record<string, unknown>) =>
    GET(
      {
        query,
        scope: {
          resolve: (key: string) => {
            if (key !== ContainerRegistrationKeys.PG_CONNECTION) {
              throw new Error(`unexpected resolve ${key}`);
            }
            return { raw };
          },
        },
        auth_context: {},
      } as never,
      res as never,
    );
  return { raw, call, res, run };
}

beforeEach(() =>
  accessMock.mockReturnValue({ superAdmin: true, userId: 'u1' }),
);

describe('reviewFilter', () => {
  it('searches titles and every message, escaping % and _', () => {
    const f = reviewFilter('50%_off', 'u1');
    expect(f.sql).toBe(
      'where c.user_id = ? and (c.title ilike ? or exists (select 1 from assistant_message m where m.conversation_id = c.id and m.content ilike ?))',
    );
    expect(f.bindings).toEqual(['u1', '%50\\%\\_off%', '%50\\%\\_off%']);
    // The account's own deleted messages count too.
    expect(f.sql).not.toMatch(/deleted_at/);
  });

  it('is always one account, even with no search', () => {
    expect(reviewFilter('', 'u1')).toEqual({
      sql: 'where c.user_id = ?',
      bindings: ['u1'],
    });
    // No account: nobody's chats, never everyone's.
    expect(reviewFilter('', '')).toEqual({
      sql: 'where c.user_id = ?',
      bindings: [''],
    });
  });
});

describe('GET /admin/assistant-review', () => {
  it('counts and pages with the same filter, newest first with an id tiebreak', async () => {
    const { call, run } = setup();
    await run({ q: ' 50%_off ', limit: '20', offset: '40' });
    const filter = reviewFilter('50%_off', 'u1');
    const count = call('as n from');
    expect(count.sql).toContain(filter.sql);
    expect(count.bindings).toEqual(filter.bindings);
    const page = call('order by');
    expect(page.sql).toContain(filter.sql);
    expect(page.sql).toMatch(
      /order by c\.last_message_at desc, c\.id desc\s+limit \? offset \?/,
    );
    expect(page.bindings).toEqual([...filter.bindings, 20, 40]);
  });

  it("shows only the signed-in account's chats, whatever user_id asks for", async () => {
    const { raw, call, res, run } = setup();
    await run({ user_id: 'u2' });
    expect(call('as n from').bindings).toEqual(['u1']);
    expect(call('order by').bindings).toEqual(['u1', 50, 0]);
    // No list of who else ever asked.
    for (const [sql] of raw.mock.calls) {
      expect(sql).not.toMatch(/distinct user_id/);
    }
    const body = res.json.mock.calls[0][0];
    expect(body.staff).toBeUndefined();
    expect(body.conversations[0].user_email).toBeUndefined();
  });

  it('ignores a one-letter search', async () => {
    const { raw, run } = setup();
    await run({ q: ' a ' });
    for (const [sql] of raw.mock.calls) expect(sql).not.toMatch(/ilike/);
  });

  it("reads each page's numbers from one grouped query", async () => {
    const { call, res, run } = setup([
      // As node-pg gives them: ints, and numeric sums as strings.
      {
        conversation_id: 'c1',
        questions: 2,
        failed: 1,
        cost_usd: '0.13',
        read_aloud: 1,
        voice_cost_usd: '0.01',
      },
    ]);
    await run({});
    const grouped = call('group by');
    expect(grouped.bindings).toEqual([['c1', 'c2']]);
    expect(grouped.sql).toContain('where conversation_id = any(?)');
    // Read aloud: working voice rows only, not questions heard.
    expect(grouped.sql).toContain(
      `count(*) filter (where role = 'voice' and coalesce(error, '') = '' and tools->>'kind' is distinct from 'listen')::int as read_aloud`,
    );
    expect(grouped.sql).toContain(
      `sum(cost_usd::numeric) filter (where role = 'voice' and coalesce(error, '') = '' and tools->>'kind' is distinct from 'listen')`,
    );
    // The total keeps every row, failed and heard ones too.
    expect(grouped.sql).toContain(
      'coalesce(sum(cost_usd::numeric), 0) as cost_usd',
    );
    const body = res.json.mock.calls[0][0];
    expect(body.count).toBe(1);
    expect(body.conversations[0]).toMatchObject({
      id: 'c1',
      questions: 2,
      failed: 1,
      cost_usd: 0.13,
      read_aloud: 1,
      voice_cost_usd: 0.01,
      deleted: false,
    });
    // A chat with no messages: zeros.
    expect(body.conversations[1]).toMatchObject({
      id: 'c2',
      questions: 0,
      failed: 0,
      cost_usd: 0,
      read_aloud: 0,
      voice_cost_usd: 0,
      deleted: true,
    });
  });

  it('refuses anyone but a super admin', async () => {
    accessMock.mockReturnValue({ superAdmin: false, userId: 'u1' });
    const { raw, res, run } = setup();
    await run({});
    expect(res.status).toHaveBeenCalledWith(403);
    expect(raw).not.toHaveBeenCalled();
  });
});
