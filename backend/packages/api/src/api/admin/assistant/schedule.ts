import type { MedusaContainer } from '@medusajs/framework/types';
import {
  ContainerRegistrationKeys,
  generateJwtToken,
} from '@medusajs/framework/utils';
import { ASSISTANT_MODULE } from '../../../modules/assistant';
import type AssistantModuleService from '../../../modules/assistant/service';

// Scheduled assistant tasks (owner, 2026-10-29). A job ticks every minute
// (jobs/assistant-schedules.ts, on the worker), picks the due tasks and asks
// each one's question through the chat route AS the staff member who set it,
// with their roles as they are now — so access, the daily cap, limits and
// logging are exactly a normal chat's. The worker serves no HTTP, so it calls
// the web server on the app's own origin (PAYMENT_CALLBACK_BASE), never
// admin.polycards.gg: Cloudflare's Bot Fight Mode challenges machine calls
// there (2026-08-11). In one-process dev it calls itself.

const MYT_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
export const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
export const MAX_SCHEDULES = 10;
export const SCHEDULED_PREFIX = '⏰ Scheduled task';

type When = { every: 'day' | 'week'; at_time: string; weekday?: number | null };

/** The first run strictly after `after`: at_time Malaysia time, every day,
 *  or on `weekday` (1 = Monday … 7 = Sunday) every week. */
export function nextRun(when: When, after: Date): Date {
  const m = TIME_RE.exec(when.at_time);
  if (!m) throw new Error('time must be HH:MM (24-hour, Malaysia time).');
  const minutes = Number(m[1]) * 60 + Number(m[2]);
  // Midnight Malaysia time of the day containing `after`, as a UTC instant.
  const day0 =
    Math.floor((after.getTime() + MYT_MS) / DAY_MS) * DAY_MS - MYT_MS;
  let t = day0 + minutes * 60_000;
  if (when.every === 'week') {
    const wd = when.weekday ?? 1;
    if (!Number.isInteger(wd) || wd < 1 || wd > 7)
      throw new Error('weekday must be 1 (Mon) to 7 (Sun).');
    const today = ((new Date(day0 + MYT_MS).getUTCDay() + 6) % 7) + 1; // 1..7
    t += ((wd - today + 7) % 7) * DAY_MS;
    if (t <= after.getTime()) t += 7 * DAY_MS;
  } else if (t <= after.getTime()) {
    t += DAY_MS;
  }
  return new Date(t);
}

/** Where the worker reaches the web server. */
/** Where the worker sends the run, with a token carrying all the owner's
 *  roles: over https, or plain http only to this machine or an internal
 *  service name (no dot: the app's private network). Throws otherwise (a
 *  tunnel or http address in PAYMENT_CALLBACK_BASE must never get it). */
export const serverUrl = (): string => {
  const url = (
    process.env.ASSISTANT_SERVER_URL?.trim() ||
    process.env.PAYMENT_CALLBACK_BASE?.trim() ||
    `http://127.0.0.1:${process.env.PORT || 9000}`
  ).replace(/\/+$/, '');
  let safe = false;
  try {
    const { protocol, hostname } = new URL(url);
    safe =
      protocol === 'https:' ||
      (protocol === 'http:' &&
        (['127.0.0.1', 'localhost', '[::1]'].includes(hostname) ||
          /^[a-z][a-z0-9-]*$/i.test(hostname)));
  } catch {
    // not a URL at all
  }
  if (!safe) {
    throw new Error(
      'The scheduled task server address must be https (ASSISTANT_SERVER_URL or PAYMENT_CALLBACK_BASE).',
    );
  }
  return url;
};

// A failed chat call, with the chat it ran in (null = none yet) and how soon
// to try again (0 = wait for the next slot).
class RunFailed extends Error {
  constructor(
    message: string,
    readonly conversation: string | null,
    readonly retryMs = 0,
  ) {
    super(message);
  }
}
// The asker was mid-chat (one answer at a time each): try again shortly
// rather than skip a whole day.
const BUSY_RETRY_MS = 2 * 60_000;
// A network, server or model hiccup: try again, but only within 20 minutes
// of the slot, so a dead server can't keep it retrying.
const RETRY_MS = 5 * 60_000;
const RETRY_WINDOW_MS = 20 * 60_000;
// Kept at claim, so a run a restart cut off doesn't look like a success.
export const STARTED_NOTE =
  'Started, no result yet (a restart may have cut it off).';
// Runs in flight in this process, so a tick never starts one twice.
const running = new Set<string>();

type Row = {
  id: string;
  user_id: string;
  title: string;
  instruction: string;
  every: 'day' | 'week';
  at_time: string;
  weekday: number | null;
  next_run_at: Date | string;
  conversation_id: string | null;
};

/** Starts every due task once; gives how many started. A task is claimed by
 *  moving its next run forward first, so two workers never run it twice. The
 *  runs go on after it returns (the worker's only job slot must not wait out
 *  minutes of answers); `wait` awaits them, for tests. */
export async function runDueSchedules(
  container: MedusaContainer,
  opts: {
    now?: Date;
    base?: string;
    fetchImpl?: typeof fetch;
    wait?: boolean;
  } = {},
): Promise<number> {
  const now = opts.now ?? new Date();
  const assistant = container.resolve<AssistantModuleService>(ASSISTANT_MODULE);
  const pg = container.resolve(ContainerRegistrationKeys.PG_CONNECTION);
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const due = (await assistant.listAssistantSchedules(
    { enabled: true, next_run_at: { $lte: now } },
    { order: { next_run_at: 'ASC' }, take: 5 },
  )) as unknown as Row[];
  const started: Promise<void>[] = [];
  for (const task of due) {
    if (running.has(task.id)) continue;
    const claimed = await pg('assistant_schedule')
      .where({ id: task.id, next_run_at: new Date(task.next_run_at) })
      .whereNull('deleted_at')
      .update({
        next_run_at: nextRun(task, now),
        last_run_at: now,
        last_error: STARTED_NOTE,
      })
      .returning('id');
    if (!claimed.length) continue;
    running.add(task.id);
    // Live rows only: a task cancelled mid-run just gets nothing written.
    const save = (fields: Record<string, unknown>) =>
      pg('assistant_schedule')
        .where({ id: task.id })
        .whereNull('deleted_at')
        .update(fields);
    const run = (async () => {
      try {
        const conversation = await runOne(container, task, opts);
        await save({
          conversation_id: conversation ?? task.conversation_id,
          last_error: null,
        });
        logger.info(`[assistant] schedule ${task.id} ran for ${task.user_id}`);
      } catch (err) {
        const message = (err as Error)?.message ?? String(err);
        // The slot this run belongs to: the last scheduled time at or before now.
        const slot = nextRun(
          task,
          new Date(now.getTime() - (task.every === 'week' ? 7 : 1) * DAY_MS),
        );
        const failed = err instanceof RunFailed ? err : null;
        const retryMs =
          failed && now.getTime() - slot.getTime() < RETRY_WINDOW_MS
            ? failed.retryMs
            : 0;
        await save({
          last_error: message.slice(0, 500),
          ...(failed ? { conversation_id: failed.conversation } : {}),
          ...(retryMs
            ? { next_run_at: new Date(now.getTime() + retryMs) }
            : {}),
        });
        logger.warn(`[assistant] schedule ${task.id} failed: ${message}`);
      }
    })()
      .catch((err) =>
        logger.error(
          `[assistant] schedule ${task.id} bookkeeping failed: ${(err as Error)?.message}`,
        ),
      )
      .finally(() => running.delete(task.id));
    started.push(run);
  }
  if (opts.wait) await Promise.all(started);
  return started.length;
}

async function runOne(
  container: MedusaContainer,
  task: Row,
  opts: { base?: string; fetchImpl?: typeof fetch },
): Promise<string | null> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY);
  const { data } = await query.graph({
    entity: 'user',
    fields: ['id', 'rbac_roles.id'],
    filters: { id: task.user_id },
  });
  const roles = (
    (data[0] as { rbac_roles?: { id: string }[] } | undefined)?.rbac_roles ?? []
  ).map((r) => r.id);
  if (!data.length || !roles.length) {
    throw new Error(
      'The staff member who set this task no longer has an admin role.',
    );
  }
  const { http } = container.resolve(
    ContainerRegistrationKeys.CONFIG_MODULE,
  ).projectConfig;
  const token = generateJwtToken(
    {
      actor_id: task.user_id,
      actor_type: 'user',
      auth_identity_id: '',
      app_metadata: { user_id: task.user_id, roles },
    },
    {
      secret: http.jwtSecret as string,
      // Checked only as the request starts; it carries all the owner's roles.
      expiresIn: 60,
      jwtOptions: http.jwtOptions,
    },
  );
  // A dropped connection or timeout: until the chat names one, the run's chat
  // is the one it asked in.
  const dropped = (err: unknown) =>
    new RunFailed(
      (err as Error)?.message ?? String(err),
      task.conversation_id,
      RETRY_MS,
    );
  const answer = await (opts.fetchImpl ?? fetch)(
    `${opts.base ?? serverUrl()}/admin/assistant/chat`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        ...(task.conversation_id
          ? { conversation_id: task.conversation_id }
          : {}),
        message: `${SCHEDULED_PREFIX} “${task.title}”: ${task.instruction}`,
      }),
      // 5 min is ample: the engine itself cuts a whole answer off at 240 s.
      signal: AbortSignal.timeout(5 * 60_000),
    },
  ).catch((err) => {
    throw dropped(err);
  });
  if (answer.status === 404 && task.conversation_id) {
    // Its chat was deleted: run it in a new one.
    return runOne(container, { ...task, conversation_id: null }, opts);
  }
  if (!answer.ok) {
    const body = (await answer.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new RunFailed(
      body?.message ?? `The chat answered ${answer.status}.`,
      task.conversation_id,
      answer.status >= 500 || answer.status === 429 ? RETRY_MS : 0,
    );
  }
  let conversation: string | null = null;
  let failure: { code?: string; message: string } | null = null;
  const text = await answer.text().catch((err) => {
    throw dropped(err);
  });
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as {
        type: string;
        id?: string;
        code?: string;
        message?: string;
      };
      if (e.type === 'conversation' && e.id) conversation = e.id;
      if (e.type === 'error') {
        failure = {
          code: e.code,
          message: e.message ?? 'The assistant failed.',
        };
      }
    } catch {
      // not a JSON line
    }
  }
  if (failure) {
    throw new RunFailed(
      failure.message,
      conversation ?? task.conversation_id,
      failure.code === 'busy'
        ? BUSY_RETRY_MS
        : failure.code === 'daily_cap' || failure.code === 'no_key'
          ? 0
          : RETRY_MS,
    );
  }
  return conversation;
}
