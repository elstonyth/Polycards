import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
import { GET, reviewFilter } from '../route';
import { accessFor } from '../../assistant/access';

// GET /admin/assistant-review with pg and the user service faked: the search
// and staff filters, the per-chat numbers, the staff list and the gate. The
// SQL itself is pinned by text here; what it counts was checked on Postgres.

jest.mock('../../assistant/access', () => ({ accessFor: jest.fn() }));

const accessMock = accessFor as jest.Mock;

function setup(
  stats: Record<string, unknown>[] = [],
  staff: string[] = ['u1', 'u2'],
) {
  // Answers by the query's shape: count, per-chat numbers, staff, page.
  const raw = jest.fn(async (sql: string, _bindings?: unknown[]) => {
    if (sql.includes('as n from')) return { rows: [{ n: 1 }] };
    if (sql.includes('group by')) return { rows: stats };
    if (sql.includes('distinct user_id')) {
      return { rows: staff.map((user_id) => ({ user_id })) };
    }
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
          user_id: 'u2',
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
  // u2 was deleted as a user: no email.
  const users = {
    listUsers: jest.fn(async (_filter: unknown) => [
      { id: 'u1', email: 'a@x.com' },
    ]),
  };
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  const run = (query: Record<string, unknown>) =>
    GET(
      {
        query,
        scope: {
          resolve: (key: string) =>
            key === ContainerRegistrationKeys.PG_CONNECTION ? { raw } : users,
        },
        auth_context: {},
      } as never,
      res as never,
    );
  return { raw, call, users, res, run };
}

beforeEach(() => accessMock.mockReturnValue({ superAdmin: true }));

describe('reviewFilter', () => {
  it('searches titles and every message, escaping % and _', () => {
    const f = reviewFilter('50%_off', '');
    expect(f.sql).toBe(
      'where (c.title ilike ? or exists (select 1 from assistant_message m where m.conversation_id = c.id and m.content ilike ?))',
    );
    expect(f.bindings).toEqual(['%50\\%\\_off%', '%50\\%\\_off%']);
    // Deleted messages count for the owner's review.
    expect(f.sql).not.toMatch(/deleted_at/);
  });

  it('scopes to one staff member, alone or with a search', () => {
    expect(reviewFilter('', 'u1')).toEqual({
      sql: 'where c.user_id = ?',
      bindings: ['u1'],
    });
    const both = reviewFilter('mew', 'u1');
    expect(both.sql).toMatch(/^where c\.user_id = \? and \(c\.title ilike/);
    expect(both.bindings).toEqual(['u1', '%mew%', '%mew%']);
  });

  it('is empty with no filters', () => {
    expect(reviewFilter('', '')).toEqual({ sql: '', bindings: [] });
  });
});

describe('GET /admin/assistant-review', () => {
  it('counts and pages with the same filter, newest first with an id tiebreak', async () => {
    const { call, run } = setup();
    await run({ q: ' 50%_off ', user_id: 'u1', limit: '20', offset: '40' });
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

  it('ignores a one-letter search', async () => {
    const { raw, run } = setup();
    await run({ q: ' a ' });
    for (const [sql] of raw.mock.calls) expect(sql).not.toMatch(/ilike/);
  });

  it('lists every staff member who ever asked, whatever the filters', async () => {
    const { call, users, res, run } = setup();
    await run({ q: 'mew', user_id: 'u1' });
    const staff = call('distinct user_id');
    expect(staff.sql).toBe(
      'select distinct user_id from assistant_conversation',
    );
    expect(staff.bindings).toBeUndefined();
    expect(users.listUsers.mock.calls[0][0]).toEqual({ id: ['u1', 'u2'] });
    const body = res.json.mock.calls[0][0];
    expect(body.staff).toEqual([
      { id: 'u1', email: 'a@x.com' },
      { id: 'u2', email: null },
    ]);
    expect(body.conversations[0].user_email).toBe('a@x.com');
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
      user_email: null,
      questions: 0,
      failed: 0,
      cost_usd: 0,
      read_aloud: 0,
      voice_cost_usd: 0,
      deleted: true,
    });
  });

  it('refuses anyone but a super admin', async () => {
    accessMock.mockReturnValue({ superAdmin: false });
    const { raw, res, run } = setup();
    await run({});
    expect(res.status).toHaveBeenCalledWith(403);
    expect(raw).not.toHaveBeenCalled();
  });
});
