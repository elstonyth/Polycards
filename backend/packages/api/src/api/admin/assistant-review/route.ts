import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
import { accessFor } from '../assistant/access';

type Rows = { rows: Record<string, unknown>[] };
type Pg = { raw: (sql: string, bindings?: unknown[]) => Promise<Rows> };
type Conversation = {
  id: string;
  title: string;
  user_id: string;
  last_message_at: Date;
  deleted_at: Date | null;
};

/** The review's filter on assistant_conversation `c`, with its bindings:
 *  always the one account's own chats. Its deleted chats and messages match
 *  too. */
export function reviewFilter(
  q: string,
  userId: string,
): { sql: string; bindings: string[] } {
  const where = ['c.user_id = ?'];
  const bindings = [userId];
  if (q) {
    // Same escape as agent-tools: % and _ in the words match themselves.
    const pattern = `%${q.replace(/[%_\\]/g, '\\$&')}%`;
    where.push(
      '(c.title ilike ? or exists (select 1 from assistant_message m where m.conversation_id = c.id and m.content ilike ?))',
    );
    bindings.push(pattern, pattern);
  }
  return { sql: `where ${where.join(' and ')}`, bindings };
}

// An answer read aloud: a voice row that worked and isn't a question heard
// (tools.kind 'listen'). Failed and heard rows still count in the total cost.
const READ_ALOUD = `role = 'voice' and coalesce(error, '') = '' and tools->>'kind' is distinct from 'listen'`;

// GET /admin/assistant-review: the signed-in account's own chats, deleted
// ones too, newest first, with what each cost. Each account sees only its
// own conversations (2026-10-29, replacing the owner's review of everyone's).
// Super admins only: checked here, because RBAC's assistant_review:read also
// passes `*:read` (the desk bots).
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const access = accessFor(req.scope, req.auth_context);
  if (!access.superAdmin) {
    res.status(403).json({ message: 'Only super admins review chats.' });
    return;
  }
  // Whole numbers: a fraction would reach the SQL.
  const limit = Math.min(
    Math.max(Math.trunc(Number(req.query.limit)) || 50, 1),
    200,
  );
  const offset = Math.max(Math.trunc(Number(req.query.offset)) || 0, 0);
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const q = str(req.query.q);
  const pg = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION) as Pg;
  // One letter matches nearly every chat and scans every message: ignored.
  const filter = reviewFilter(q.length >= 2 ? q : '', access.userId);
  const counted = await pg.raw(
    `select count(*)::int as n from assistant_conversation c ${filter.sql}`,
    filter.bindings,
  );
  const page = await pg.raw(
    `select c.id, c.title, c.user_id, c.last_message_at, c.deleted_at
     from assistant_conversation c ${filter.sql}
     order by c.last_message_at desc, c.id desc
     limit ? offset ?`,
    [...filter.bindings, limit, offset],
  );
  const conversations = page.rows as Conversation[];
  const ids = conversations.map((c) => c.id);
  // Each chat's numbers in one pass, deleted messages included. numeric keeps
  // the stored reals as written (0.1, not float8's 0.10000000149).
  const stats = ids.length
    ? (
        await pg.raw(
          `select conversation_id,
             count(*) filter (where role = 'user')::int as questions,
             count(*) filter (where role = 'assistant' and coalesce(error, '') <> '')::int as failed,
             coalesce(sum(cost_usd::numeric), 0) as cost_usd,
             count(*) filter (where ${READ_ALOUD})::int as read_aloud,
             coalesce(sum(cost_usd::numeric) filter (where ${READ_ALOUD}), 0) as voice_cost_usd
           from assistant_message
           where conversation_id = any(?)
           group by conversation_id`,
          [ids],
        )
      ).rows
    : [];
  const byId = new Map(stats.map((s) => [s.conversation_id as string, s]));
  res.json({
    count: Number(counted.rows[0]?.n ?? 0),
    limit,
    offset,
    conversations: conversations.map((c) => {
      const s = byId.get(c.id);
      return {
        id: c.id,
        title: c.title,
        user_id: c.user_id,
        questions: Number(s?.questions ?? 0),
        failed: Number(s?.failed ?? 0),
        cost_usd: Number(s?.cost_usd ?? 0),
        read_aloud: Number(s?.read_aloud ?? 0),
        voice_cost_usd: Number(s?.voice_cost_usd ?? 0),
        last_message_at: c.last_message_at,
        deleted: !!c.deleted_at,
      };
    }),
  });
}
