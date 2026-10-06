import type {
  IRbacModuleService,
  MedusaContainer,
} from '@medusajs/framework/types';
import { Modules } from '@medusajs/framework/utils';

// The desk bots' read-only admin proxy (GET /reports/admin/read): the owner's
// call on 2026-10-04 was "full access", read-only, for every desk bot. Any
// desk key reads any admin dashboard screen except the blocked ones below.
// The proxy itself only ever issues GET, and the token it mints carries one
// role, DESK_BOT_ROLE, whose only policy is read on everything, so Medusa's
// own RBAC refuses every write route. A GET handler can still record that it
// was read: a payout-details reveal writes its audit row (actor
// DESK_BOT_ACTOR), which is that audit doing its job.

/** The actor id the proxy's tokens carry: shows up wherever an admin route
 *  records who asked. */
export const DESK_BOT_ACTOR = 'desk-bots-readonly';
export const DESK_BOT_ROLE = 'Desk bots (read-only)';

const MAX_PATH = 300;

/** Why `path` is not a plain admin path, or null when it is. */
export function adminPathError(path: unknown): string | null {
  if (typeof path !== 'string' || path === '') {
    return 'path is required: the admin API path, like /admin/customers.';
  }
  if (path.length > MAX_PATH) return 'path is too long.';
  if (!path.startsWith('/admin/')) {
    return 'path must start with /admin/ (an admin dashboard API path).';
  }
  // Letters, digits and - _ . / only, no empty or dot segments: what the
  // proxy forwards is exactly the route Express would run.
  if (
    !/^\/admin(\/[A-Za-z0-9_.-]+)+$/.test(path) ||
    path.split('/').some((s) => s === '.' || s === '..')
  ) {
    return 'path is not a plain admin path: letters, digits, - _ . and / only; put filters in params.';
  }
  return null;
}

// Screens no desk bot reads, with the reason it is told. Since 2026-10-06
// (the owner: "just give it everything") the staff list and full bank
// numbers are open; what stays shut holds login secrets, costs money per
// call, or is a file rather than a screen.
const BLOCKED: [RegExp, string][] = [
  [/^\/admin\/invites(\/|$)/, 'staff invites (their links log in)'],
  [/^\/admin\/api-keys(\/|$)/, 'API keys'],
  [/^\/admin\/workflows-executions(\/|$)/, 'workflow internals'],
  [/^\/admin\/notifications(\/|$)/, 'notification contents (reset links)'],
  [/^\/admin\/uploads(\/|$)/, 'uploads'],
  [
    /^\/admin\/pricecharting(\/|$)/,
    'PriceCharting lookups (each one costs an API call)',
  ],
  [/\/export(\.[a-z]+)?$/, 'file exports'],
];

/** Why the desk bots may not read `path`, or null when they may. Judged in
 *  lowercase: Medusa matches routes case-insensitively, so /admin/USERS runs
 *  the /admin/users handler. */
export function blockedReason(path: string): string | null {
  const lower = path.toLowerCase();
  return BLOCKED.find(([re]) => re.test(lower))?.[1] ?? null;
}

// Secrets no desk bot sees, on whatever screen or query row carries them.
// Core screens return customer.metadata whole, and it holds partner account
// passwords (partner_credential): any password, secret, token, credential or
// API key field is hidden, also inside a string that holds JSON (a jsonb
// column a query cast to text). Bank account numbers come back whole
// (2026-10-06). Field names alone cannot catch a value a query renamed or
// cut out of its JSON: the SQL route masks the partner passwords themselves
// (db-query.ts).
const HIDDEN = /password|secret|token|credential|api_?key/i;

export function redact(value: unknown): unknown {
  if (typeof value === 'string') return redactJsonText(value);
  if (Array.isArray(value)) return value.map(redact);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, v]) => [
      key,
      HIDDEN.test(key) ? '[hidden]' : redact(v),
    ]),
  );
}

function redactJsonText(text: string): string {
  if (!/^\s*[[{]/.test(text)) return text;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object'
      ? JSON.stringify(redact(parsed))
      : text;
  } catch {
    return text;
  }
}

// Hermes spills a tool result over 50K characters to a file the bot cannot
// read, so an answer is cut well below that, with a way to narrow it.
const MAX_CHARS = 40_000;

export function capBody(data: unknown, max = MAX_CHARS) {
  // Measured as Hermes measures it: the tool's JSON text, escaped once more
  // as a string, so every quote and backslash counts again.
  const size = (value: unknown) =>
    JSON.stringify(JSON.stringify(value)).length;
  const whole = { truncated: false, data };
  if (size(whole) <= max) return whole;
  const text = JSON.stringify(data);
  const cut = (preview: string) => ({
    truncated: true,
    data_preview: preview,
    note: `The answer is ${text.length.toLocaleString('en-MY')} characters, too long to show whole. Ask again narrower: limit (rows per page), offset (to page on), fields (only the columns you need) or q (a search).`,
  });
  let preview = text.slice(0, max);
  while (preview && size(cut(preview)) > max) {
    preview = preview.slice(0, Math.floor(preview.length * 0.9));
  }
  return cut(preview);
}

/** The id of DESK_BOT_ROLE, with its one policy (read on every resource)
 *  made sure of on every read, never cached. The policy is declared in
 *  src/policies/desk-bots.ts so the boot-time policy sync keeps it; this
 *  also heals a role whose policy was deleted anyway (restored, never
 *  duplicated) or whose link is missing, so the bots cannot silently lose
 *  every core screen again. RBAC reads role policies from the database on
 *  each request, so a heal takes effect at once. */
export async function deskBotRoleId(scope: MedusaContainer): Promise<string> {
  const rbac = scope.resolve(Modules.RBAC);
  const policy = await readEverythingPolicy(rbac);
  const [existing] = await rbac.listRbacRoles(
    { name: DESK_BOT_ROLE },
    { order: { created_at: 'ASC' }, take: 1 },
  );
  const role =
    existing ??
    (await rbac.createRbacRoles({
      name: DESK_BOT_ROLE,
      description:
        'The staff Discord desk bots: read-only access to the admin API through /reports/admin/read.',
    }));
  const [link] = await rbac.listRbacRolePolicies(
    { role_id: role.id, policy_id: policy.id },
    { take: 1 },
  );
  if (!link) {
    await rbac.createRbacRolePolicies({
      role_id: role.id,
      policy_id: policy.id,
    });
  }
  return role.id as string;
}

/** The live `*:read` policy: restored if it was soft-deleted, created only
 *  when there has never been one. */
async function readEverythingPolicy(
  rbac: IRbacModuleService,
): Promise<{ id: string }> {
  const [live] = await rbac.listRbacPolicies(
    { key: READ_EVERYTHING },
    { take: 1 },
  );
  if (live) return live;
  const [deleted] = await rbac.listRbacPolicies(
    { key: READ_EVERYTHING },
    { take: 1, withDeleted: true },
  );
  if (deleted) {
    await rbac.restoreRbacPolicies([deleted.id]);
    return deleted;
  }
  return rbac.createRbacPolicies({
    key: READ_EVERYTHING,
    resource: '*',
    operation: 'read',
    name: 'DeskBotsReadEverything',
    description:
      'Read on every resource, nothing else: the staff Discord desk bots.',
  });
}

const READ_EVERYTHING = '*:read';
