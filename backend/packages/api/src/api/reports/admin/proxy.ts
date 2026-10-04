import type { MedusaContainer } from '@medusajs/framework/types';
import { Modules } from '@medusajs/framework/utils';

// The desk bots' read-only admin proxy (GET /reports/admin/read): the owner's
// call on 2026-10-04 was "full access", read-only, for every desk bot. Any
// desk key reads any admin dashboard screen except the blocked ones below.
// The proxy itself only ever issues GET, and the token it mints carries one
// role, DESK_BOT_ROLE, whose only policy is read on everything, so Medusa's
// own RBAC refuses a write even if a GET route tried one.

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

// Screens no desk bot reads, with the reason it is told.
const BLOCKED: [RegExp, string][] = [
  [/^\/admin\/(users|invites)(\/|$)/, 'staff logins and invites'],
  [/^\/admin\/api-keys(\/|$)/, 'API keys'],
  [/^\/admin\/workflows-executions(\/|$)/, 'workflow internals'],
  [/^\/admin\/notifications(\/|$)/, 'notification contents (reset links)'],
  [/^\/admin\/uploads(\/|$)/, 'uploads'],
  // Bank numbers stay masked, as on the dashboard's lists: the one-row
  // reveal is an audited staff action, and payout-details holds them whole.
  [
    /^\/admin\/payments\/withdrawals\/[^/]+\/account$/,
    'the full bank number reveal',
  ],
  [/\/payout-details$/, "customers' full bank numbers"],
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

// Secrets no desk bot sees, on whatever screen carries them. Core screens
// return customer.metadata whole, and it holds partner account passwords
// (partner_credential) and saved payout banks (bank_accounts): any password,
// secret, token, credential or API key is hidden, and a bank account number
// keeps only its last 4 digits, as the dashboard's lists show it.
const HIDDEN = /password|secret|token|credential|api_?key/i;
const ACCOUNT_NUMBER = /account_?number/i;

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, v]) => [
      key,
      HIDDEN.test(key)
        ? '[hidden]'
        : ACCOUNT_NUMBER.test(key) && typeof v === 'string'
          ? `••••${v.replace(/\D/g, '').slice(-4)}`
          : redact(v),
    ]),
  );
}

// Hermes spills a tool result over 50K characters to a file the bot cannot
// read, so an answer is cut well below that, with a way to narrow it.
const MAX_CHARS = 40_000;

export function capBody(data: unknown, max = MAX_CHARS) {
  const text = JSON.stringify(data);
  if (text.length <= max) return { truncated: false, data };
  return {
    truncated: true,
    data_preview: text.slice(0, max),
    note: `The answer is ${text.length.toLocaleString('en-MY')} characters, too long to show whole. Ask again narrower: limit (rows per page), offset (to page on), fields (only the columns you need) or q (a search).`,
  };
}

/** The id of DESK_BOT_ROLE, created on first use with its one policy
 *  (read on every resource), the way Medusa seeds its own super-admin role.
 *  Looked up on every read, never cached: a token naming a role that has
 *  since been deleted is refused by RBAC on every core screen. */
export async function deskBotRoleId(scope: MedusaContainer): Promise<string> {
  const rbac = scope.resolve(Modules.RBAC);
  const [existing] = await rbac.listRbacRoles(
    { name: DESK_BOT_ROLE },
    { order: { created_at: 'ASC' }, take: 1 },
  );
  if (existing) return existing.id as string;
  const [readAll] = await rbac.listRbacPolicies({ key: '*:read' }, { take: 1 });
  const policy =
    readAll ??
    (await rbac.createRbacPolicies({
      key: '*:read',
      resource: '*',
      operation: 'read',
      name: 'Read everything',
      description: 'Read on every resource, nothing else.',
    }));
  const role = await rbac.createRbacRoles({
    name: DESK_BOT_ROLE,
    description:
      'The staff Discord desk bots: read-only access to the admin API through /reports/admin/read.',
  });
  await rbac.createRbacRolePolicies({ role_id: role.id, policy_id: policy.id });
  return role.id as string;
}
