import { accessFor } from '../access';
import {
  openProposal,
  saveProposal,
  sealProposal,
  type Proposal,
} from '../confirm';
import { POST } from '../confirm/route';

// Notes and scheduled tasks are saved only by the person's tap: the signed
// proposal (who, what, until when), saving it, and the route.

jest.mock('../access', () => ({ accessFor: jest.fn() }));
jest.mock('../../../../modules/assistant', () => ({
  ASSISTANT_MODULE: 'assistant',
}));

const SECRET = 's'.repeat(32);
const NOTE: Proposal = {
  kind: 'note',
  note: 'Likes short captions.',
  shared: false,
};
const TASK: Proposal = {
  kind: 'schedule',
  title: 'Top hits',
  instruction: 'Send me yesterday’s top hits.',
  every: 'day',
  at_time: '09:00',
  weekday: null,
};

type Row = Record<string, unknown>;
let memories: Row[] = [];
let schedules: Row[] = [];
const matches = (f: Row) => (r: Row) =>
  Object.entries(f).every(([k, v]) => r[k] === v);
const service = {
  listAssistantMemories: jest.fn(async (f: Row) => memories.filter(matches(f))),
  createAssistantMemories: jest.fn(async (v: Row) => {
    const row = { id: `aimem_${memories.length + 1}`, ...v };
    memories.push(row);
    return row;
  }),
  listAssistantSchedules: jest.fn(async (f: Row) =>
    schedules.filter(matches(f)),
  ),
  listAndCountAssistantSchedules: jest.fn(async (f: Row) => {
    const rows = schedules.filter(matches(f));
    return [rows, rows.length];
  }),
  createAssistantSchedules: jest.fn(async (v: Row) => {
    const row = { id: `aisch_${schedules.length + 1}`, ...v };
    schedules.push(row);
    return row;
  }),
};
const logger = { info: jest.fn() };
const container = {
  resolve: (k: string) =>
    k === 'assistant'
      ? service
      : k === 'configModule'
        ? { projectConfig: { http: { jwtSecret: SECRET } } }
        : logger,
} as never;

beforeEach(() => {
  jest.clearAllMocks();
  memories = [];
  schedules = [];
});

describe('sealProposal / openProposal', () => {
  const now = Date.parse('2026-10-29T15:00:00Z');

  it('opens for the person it was made for, within 30 minutes', () => {
    const token = sealProposal(NOTE, 'user_1', SECRET, now);
    expect(openProposal(token, 'user_1', SECRET, now + 29 * 60_000)).toEqual(
      NOTE,
    );
    expect(openProposal(token, 'user_1', SECRET, now + 31 * 60_000)).toBeNull();
    expect(openProposal(token, 'user_2', SECRET, now)).toBeNull();
    expect(openProposal(token, 'user_1', 'x'.repeat(32), now)).toBeNull();
  });

  it('refuses anything changed or malformed', () => {
    const token = sealProposal(NOTE, 'user_1', SECRET, now);
    const [body, mac] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({
        p: { ...NOTE, shared: true },
        u: 'user_1',
        exp: now + 60_000,
      }),
    ).toString('base64url');
    for (const bad of [
      `${forged}.${mac}`,
      `${body}.${mac.slice(0, -2)}AA`,
      `${body}.`,
      `${body}.${mac}.x`,
      'not-a-token',
      '',
      42,
      null,
      'a'.repeat(9000),
    ]) {
      expect(openProposal(bad, 'user_1', SECRET, now)).toBeNull();
    }
  });
});

describe('saveProposal', () => {
  const staff = { userId: 'user_1', superAdmin: false };

  it('saves a note once, however often it is tapped', async () => {
    const first = await saveProposal(NOTE, staff, container);
    const again = await saveProposal(NOTE, staff, container);
    expect(again.id).toBe(first.id);
    expect(memories).toEqual([
      expect.objectContaining({
        scope: 'user',
        user_id: 'user_1',
        content: 'Likes short captions.',
      }),
    ]);
  });

  it('saves a note for everyone only for an admin, as things stand now', async () => {
    const shared: Proposal = { ...NOTE, shared: true } as Proposal;
    await expect(saveProposal(shared, staff, container)).rejects.toThrow(
      /Only an admin/,
    );
    await saveProposal(
      shared,
      { userId: 'user_1', superAdmin: true },
      container,
    );
    expect(memories).toEqual([expect.objectContaining({ scope: 'shared' })]);
  });

  it('schedules a task from when it is tapped, once, within the limit', async () => {
    const tapped = new Date('2026-10-29T03:00:00Z'); // 11:00 Malaysia time
    const out = await saveProposal(TASK, staff, container, tapped);
    expect(out.next_run_at?.toISOString()).toBe('2026-10-30T01:00:00.000Z');
    await saveProposal(TASK, staff, container, tapped);
    expect(schedules).toHaveLength(1);
    schedules.push(
      ...Array.from({ length: 9 }, (_, i) => ({
        id: `x${i}`,
        user_id: 'user_1',
      })),
    );
    await expect(
      saveProposal({ ...TASK, title: 'Another' } as Proposal, staff, container),
    ).rejects.toThrow(/already have 10/);
  });
});

describe('POST /admin/assistant/confirm', () => {
  const post = async (body: unknown) => {
    let status = 200;
    let json: unknown;
    const res = {
      status(code: number) {
        status = code;
        return this;
      },
      json(b: unknown) {
        json = b;
      },
    };
    await POST(
      { body, scope: container, auth_context: {} } as never,
      res as never,
    );
    return { status, json: json as Record<string, unknown> };
  };
  const as = (userId: string, superAdmin = false) =>
    (accessFor as jest.Mock).mockReturnValue({ userId, superAdmin });

  it('saves what the person tapped', async () => {
    as('user_1');
    const r = await post({ token: sealProposal(TASK, 'user_1', SECRET) });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ saved: true, kind: 'schedule' });
    expect(schedules).toHaveLength(1);
  });

  it("refuses someone else's, or an old one, and saves nothing", async () => {
    as('user_2');
    let r = await post({ token: sealProposal(NOTE, 'user_1', SECRET) });
    expect(r).toMatchObject({ status: 400, json: { code: 'confirm_expired' } });
    as('user_1');
    r = await post({
      token: sealProposal(NOTE, 'user_1', SECRET, Date.now() - 31 * 60_000),
    });
    expect(r.status).toBe(400);
    r = await post({});
    expect(r.status).toBe(400);
    expect(memories).toEqual([]);
  });

  it('says why when it cannot be saved now', async () => {
    as('user_1'); // no longer an admin
    const r = await post({
      token: sealProposal(
        { ...NOTE, shared: true } as Proposal,
        'user_1',
        SECRET,
      ),
    });
    expect(r).toMatchObject({ status: 400, json: { code: 'confirm_refused' } });
  });
});
