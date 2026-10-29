import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { MedusaContainer } from '@medusajs/framework/types';
import {
  ContainerRegistrationKeys,
  generateJwtToken,
} from '@medusajs/framework/utils';
import {
  adminPathError,
  blockedReason,
  capBody,
  redact,
} from '../../reports/admin/proxy';
import type { Access } from './access';

// How the assistant reads data: over loopback, through the same routes the
// desk bots use, so every figure matches what the desks and the dashboard
// show. Two doors:
//  - /reports/<desk>/* with ASSISTANT_REPORT_KEY, a key made fresh in this
//    process at boot that never leaves it (require-report-key.ts accepts it
//    as the caller `assistant`). Which reports a staff member may ask for is
//    decided by the tool layer (tools.ts) before a call is made.
//  - /admin/* as the asker: a 60-second token carrying THEIR user id and
//    roles, so the admin API's own RBAC answers exactly as it would for them
//    in the dashboard (unlike the desk bots' proxy, which reads as `*:read`).

export const ASSISTANT_REPORT_KEY = randomBytes(32).toString('hex');

/** Whether a request carries the assistant's key (constant-time). */
export function isAssistantKey(given: unknown): boolean {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(ASSISTANT_REPORT_KEY);
  return a.length === b.length && timingSafeEqual(a, b);
}

// At most 2 reads at a time per process (review 2026-10-29): every report
// and admin screen runs its queries on the same small DB pool customers
// use, and several staff asking at once must not starve it.
const MAX_READS = 2;
let reading = 0;
const queued: (() => void)[] = [];
async function slot<T>(read: () => Promise<T>): Promise<T> {
  while (reading >= MAX_READS) {
    await new Promise<void>((go) => queued.push(go));
  }
  reading++;
  try {
    return await read();
  } finally {
    reading--;
    queued.shift()?.();
  }
}

export type ReportImage = {
  buffer: Buffer;
  mime: string;
  headers: Record<string, string>;
};

type Params = Record<string, string | number | boolean | null | undefined>;

const query = (params: Params) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') q.append(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
};

async function failure(answer: Response): Promise<Error> {
  const body = (await answer.json().catch(() => null)) as {
    message?: string;
  } | null;
  return new Error(body?.message ?? `The report answered ${answer.status}.`);
}

/** One desk report as JSON, or a poster as image bytes. */
export async function callReport(opts: {
  port: number;
  desk: 'finance' | 'growth' | 'store' | 'support' | 'admin';
  path: string;
  params?: Params;
  post?: unknown;
  image?: boolean;
  timeoutMs?: number;
  /** The turn: when the asker leaves, the read stops too. */
  signal?: AbortSignal;
  /** Who asked: their own report rate-limit budget (rate-limit.ts). */
  userId?: string;
  fetchImpl?: typeof fetch;
}): Promise<unknown | ReportImage> {
  const f = opts.fetchImpl ?? fetch;
  return slot(async () => {
  const answer = await f(
    `http://127.0.0.1:${opts.port}/reports/${opts.desk}/${opts.path}${query(opts.params ?? {})}`,
    {
      method: opts.post === undefined ? 'GET' : 'POST',
      headers: {
        'x-report-key': ASSISTANT_REPORT_KEY,
        'x-assistant-user': opts.userId ?? '',
        accept: opts.image ? 'image/*' : 'application/json',
        ...(opts.post === undefined
          ? {}
          : { 'content-type': 'application/json' }),
      },
      body: opts.post === undefined ? undefined : JSON.stringify(opts.post),
      redirect: 'manual',
      signal: AbortSignal.any([
        AbortSignal.timeout(opts.timeoutMs ?? (opts.image ? 60_000 : 45_000)),
        ...(opts.signal ? [opts.signal] : []),
      ]),
    },
  );
  if (!answer.ok) throw await failure(answer);
  if (opts.image) {
    const headers: Record<string, string> = {};
    answer.headers.forEach((v, k) => {
      if (k.startsWith('x-poster-')) headers[k] = v;
    });
    return {
      buffer: Buffer.from(await answer.arrayBuffer()),
      mime: answer.headers.get('content-type') ?? 'image/jpeg',
      headers,
    };
  }
  return answer.json();
  });
}

/** An admin screen's answer, read as the asker. */
export async function adminReadAs(opts: {
  container: MedusaContainer;
  port: number;
  access: Access;
  path: unknown;
  params?: Params;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<unknown> {
  const bad = adminPathError(opts.path);
  if (bad) throw new Error(bad);
  const path = opts.path as string;
  const blocked = blockedReason(path);
  if (blocked) throw new Error(`That screen (${blocked}) is not open here.`);

  const { http } = opts.container.resolve(
    ContainerRegistrationKeys.CONFIG_MODULE,
  ).projectConfig;
  return slot(async () => {
  // Minted once the slot is ours: a read queued behind others keeps its 60 s.
  const token = generateJwtToken(
    {
      actor_id: opts.access.userId,
      actor_type: 'user',
      auth_identity_id: opts.access.authIdentityId,
      app_metadata: {
        user_id: opts.access.userId,
        roles: opts.access.roles,
      },
    },
    { secret: http.jwtSecret, expiresIn: 60, jwtOptions: http.jwtOptions },
  );
  const answer = await (opts.fetchImpl ?? fetch)(
    `http://127.0.0.1:${opts.port}${path}${query(opts.params ?? {})}`,
    {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.any([
        AbortSignal.timeout(30_000),
        ...(opts.signal ? [opts.signal] : []),
      ]),
    },
  );
  if (answer.status === 403) {
    throw new Error(`No access: your admin role cannot open ${path} (403).`);
  }
  if (answer.status === 401) {
    throw new Error('The admin API refused the sign-in for this read (401).');
  }
  if (
    !(answer.headers.get('content-type') ?? '').includes('application/json')
  ) {
    throw new Error('That admin path does not answer JSON (a file or a page).');
  }
  if (!answer.ok) throw await failure(answer);
  return capBody(redact(await answer.json()));
  });
}
