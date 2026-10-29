import {
  CORE_READ_PREFIXES,
  CUSTOM_ADMIN_RESOURCES,
} from '../../../admin-rbac';
import { assistantPolicies } from '../../../../policies/assistant';
import type { Access } from '../access';
import { TOOLS, type ToolCtx } from '../tools';

// How each tool's arguments become the report request (the desks' own
// tools.test.mjs, for the backend copy): a new tool must add a row here.
const calls: Record<string, unknown>[] = [];
jest.mock('../bridge', () => ({
  callReport: jest.fn(async (o: Record<string, unknown>) => {
    calls.push(o);
    return o.image
      ? { buffer: Buffer.from('x'), mime: 'image/jpeg', headers: {} }
      : { ok: true };
  }),
  adminReadAs: jest.fn(async (o: Record<string, unknown>) => {
    calls.push({ desk: 'admin-as-user', path: o.path, params: o.params });
    return { ok: true };
  }),
}));
jest.mock('../images', () => ({
  generateImage: jest.fn(async () => ({ buffer: Buffer.from('x'), cost: 0 })),
  brandImage: jest.fn(async (b: Buffer) => b),
}));

const ctx: ToolCtx = {
  container: {} as never,
  port: 9000,
  access: { userId: 'u1', roles: [], superAdmin: true } as unknown as Access,
  openrouterKey: 'k',
  imageModel: 'm',
  attachments: [],
  showImage: async () => 'url',
  addCost: () => undefined,
  signal: new AbortController().signal,
};

const NOW_DAY = /^\d{4}-\d{2}-\d{2}T16:00:00\.000Z$/;

// tool → [args, expected request fields]
const ROWS: Record<string, [Record<string, unknown>, Record<string, unknown>]> =
  {
    economy: [
      { period: 'today', group: 'default' },
      { desk: 'finance', path: 'economy', params: { group: 'default' } },
    ],
    daily_economy: [{ period: 'today' }, { desk: 'finance', path: 'daily' }],
    payments: [{ period: 'today' }, { desk: 'finance', path: 'payments' }],
    pack_sales: [{ period: 'today' }, { desk: 'finance', path: 'pack-sales' }],
    groups: [{}, { desk: 'finance', path: 'groups', params: {} }],
    player: [
      { username: 'Ace' },
      { desk: 'finance', path: 'player', params: { username: 'Ace' } },
    ],
    account: [
      { username: 'Ace' },
      { desk: 'support', path: 'account', params: { username: 'Ace' } },
    ],
    order: [
      { number: '#A1B2C3' },
      { desk: 'support', path: 'order', params: { number: '#A1B2C3' } },
    ],
    challenge: [
      { week: 'next' },
      { desk: 'growth', path: 'challenge', params: { week: 'next' } },
    ],
    challenge_results: [{}, { desk: 'growth', path: 'challenge-results' }],
    signups: [
      { period: 'today', group: 'default' },
      { desk: 'growth', path: 'signups' },
    ],
    packs_opened: [
      { period: 'today', group: 'default' },
      { desk: 'growth', path: 'packs', params: { group: 'default' } },
    ],
    top_pulls: [
      { day: '2026-10-28', limit: '5' },
      {
        desk: 'growth',
        path: 'top-pulls',
        params: { day: '2026-10-28', limit: 5 },
      },
    ],
    tasks: [
      { week: 'next' },
      { desk: 'growth', path: 'tasks', params: { week: 'next' } },
    ],
    packs: [{}, { desk: 'store', path: 'packs' }],
    pack: [
      { slug: 'silver-pack' },
      { desk: 'store', path: 'pack', params: { slug: 'silver-pack' } },
    ],
    low_stock: [
      { max: '-1', limit: 20 },
      { desk: 'store', path: 'stock', params: { max: -1, limit: 20 } },
    ],
    admin_read: [
      { path: '/admin/inventory', params: { q: 'Pikachu' } },
      {
        desk: 'admin-as-user',
        path: '/admin/inventory',
        params: { q: 'Pikachu' },
      },
    ],
    db_query: [
      { sql: 'SELECT 1' },
      {
        desk: 'admin',
        path: 'sql',
        post: { sql: 'SELECT 1' },
        timeoutMs: 60_000,
      },
    ],
    challenge_poster: [
      { leaders: 'false', stage: '2' },
      {
        desk: 'growth',
        path: 'challenge-poster',
        image: true,
        params: { leaders: 0, stage: 2 },
      },
    ],
    challenge_stages_poster: [
      { week: 'next' },
      {
        desk: 'growth',
        path: 'challenge-stages-poster',
        image: true,
        params: { week: 'next' },
      },
    ],
    challenge_results_poster: [
      { part: 'rest' },
      {
        desk: 'growth',
        path: 'challenge-results-poster',
        image: true,
        params: { part: 'rest' },
      },
    ],
    challenge_standings_poster: [
      {},
      { desk: 'growth', path: 'challenge-standings-poster', image: true },
    ],
    brand_poster: [
      { headline: 'Collectors and counting.', metric: 'players', goal: 1000 },
      {
        desk: 'growth',
        path: 'brand-poster',
        image: true,
        params: expect.objectContaining({
          headline: 'Collectors and counting.',
          metric: 'players',
          goal: 1000,
        }),
      },
    ],
    achievements_poster: [
      { min_level: '60' },
      {
        desk: 'growth',
        path: 'achievements-poster',
        image: true,
        params: expect.objectContaining({ min_level: 60 }),
      },
    ],
    tasks_poster: [{}, { desk: 'growth', path: 'tasks-poster', image: true }],
    top_pulls_poster: [
      { limit: 3 },
      {
        desk: 'growth',
        path: 'top-pulls-poster',
        image: true,
        params: expect.objectContaining({ limit: 3 }),
      },
    ],
    brand_logo: [{}, {}],
    generate_image: [{ prompt: 'a pack' }, {}],
  };

describe('assistant tools', () => {
  it('has a mapping row for every tool', () => {
    expect(Object.keys(ROWS).sort()).toEqual(TOOLS.map((t) => t.name).sort());
  });

  it.each(Object.entries(ROWS))(
    '%s sends the right report request',
    async (name, [args, want]) => {
      calls.length = 0;
      await TOOLS.find((t) => t.name === name)!.run(args, ctx);
      if (!Object.keys(want).length) {
        expect(calls).toHaveLength(0);
        return;
      }
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject(want);
    },
  );

  it('resolves the period in Malaysia time and leaves group off where a report takes none', async () => {
    calls.length = 0;
    await TOOLS.find((t) => t.name === 'signups')!.run(
      { period: 'yesterday', group: 'default' },
      ctx,
    );
    const params = calls[0].params as Record<string, unknown>;
    expect(params.from).toMatch(NOW_DAY);
    expect(params).not.toHaveProperty('group');
  });

  it('names only declared RBAC resources in its needs (a typo would lock everyone out)', () => {
    const known = new Set<string>([
      ...Object.values(CUSTOM_ADMIN_RESOURCES),
      ...Object.values(CORE_READ_PREFIXES),
      ...assistantPolicies.policies.map((p) => p.resource),
    ]);
    for (const tool of TOOLS) {
      for (const need of tool.needs) {
        if (need === 'super_admin') continue;
        expect([tool.name, known.has(need.resource)]).toEqual([
          tool.name,
          true,
        ]);
      }
    }
  });
});
