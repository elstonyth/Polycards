'use server';

/**
 * Notifications server actions — feed read, mark-read, unread count.
 *
 * Backend routes:
 *   GET  /store/notifications          — feed list + unread_count
 *   POST /store/notifications/:id/read — mark one notification read
 *
 * Wire shape for GET:
 *   { notifications: [{ id, template, data, created_at, read_at: string|Date|null }],
 *     unread_count: number }
 *
 * Wire shape for POST /:id/read:
 *   { id: string, read_at: string|Date }
 *
 * `getUnreadCount()` returns 0 when the user is logged out (used in nav badge)
 * so it never throws and never requires auth.
 *
 * Every call goes through the `Store` port (src/lib/store.ts), which owns the
 * cookie read, the bearer, the schema check and the failure log. What stays
 * here is each action's logged-out answer and its copy (`notifFailure`, over
 * NOTIF_RULES).
 */
import { store, type Failure } from '@/lib/store';
import { sanePage } from '@/lib/page-param';
import { friendlyError, type ErrorRule } from '@/lib/errors';
import {
  NotificationsEnvelopeSchema,
  NotificationsPageSchema,
  MarkReadSchema,
  MarkAllReadSchema,
} from '@/lib/data/schemas';

export type Notification = {
  id: string;
  template: string;
  data: Record<string, unknown> | null;
  createdAt: string;
  readAt: string | null;
};

export type NotificationsResult =
  | {
      ok: true;
      notifications: Notification[];
      unreadCount: number;
      page: number;
      hasMore: boolean;
    }
  | { ok: false; error: string; needsAuth?: boolean };

// Feed page size — matches the backend default (PAGE_SIZE in the route).
// Not exported: 'use server' modules may only export async functions.
const PAGE_SIZE = 20;

export type MarkReadResult =
  | { ok: true; id: string; readAt: string }
  | { ok: false; error: string; needsAuth?: boolean };

export type MarkAllReadResult =
  | { ok: true; marked: number; readAt: string }
  | { ok: false; error: string; needsAuth?: boolean };

const NOTIF_RULES: ErrorRule[] = [
  [
    /too many|rate.?limit|429/i,
    'Too many requests — give it a moment and try again.',
  ],
  [/not found|404/i, 'Notification not found.'],
  [/unauthorized|not authenticated|401/i, 'Please log in first.'],
];
const NOTIF_FALLBACK = 'Something went wrong. Please try again.';
const LOGIN_FIRST = 'Please log in first.';
const LOGIN_TO_VIEW = 'Please log in to view your notifications.';
const UNEXPECTED_RESPONSE = 'Got an unexpected response. Please try again.';

/** A port `Failure` in this file's vocabulary: no cookie at all (the call
 *  never left — `status` is undefined) gives the action's own logged-out copy;
 *  a 2xx that failed its schema gives the "unexpected response" copy; anything
 *  the backend actually said goes through NOTIF_RULES, with `needsAuth` when
 *  it was a 401. */
function notifFailure(
  f: Failure,
  loggedOut: string,
): { ok: false; error: string; needsAuth?: boolean } {
  if (f.kind === 'invalid_shape') {
    return { ok: false, error: UNEXPECTED_RESPONSE };
  }
  if (f.kind === 'unauthenticated' && f.status === undefined) {
    return { ok: false, error: loggedOut, needsAuth: true };
  }
  return {
    ok: false,
    error: friendlyError(f.text, NOTIF_RULES, NOTIF_FALLBACK),
    needsAuth: f.kind === 'unauthenticated',
  };
}

/** Coerce a backend read_at (string | Date | null) to string | null. */
function coerceReadAt(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return value;
}

export async function getNotifications(
  page: number = 1,
): Promise<NotificationsResult> {
  // Validate at the boundary — server actions are public endpoints.
  const safePage = sanePage(page);

  const r = await store.get('/store/notifications', NotificationsPageSchema, {
    query: { limit: PAGE_SIZE, offset: (safePage - 1) * PAGE_SIZE },
  });
  if (!r.ok) return notifFailure(r, LOGIN_TO_VIEW);
  const { envelope, rows } = r.data;

  return {
    ok: true,
    notifications: rows.map((n) => ({
      id: n.id,
      template: n.template,
      data: (n.data as Record<string, unknown> | null | undefined) ?? null,
      createdAt: n.created_at,
      readAt: coerceReadAt(n.read_at),
    })),
    unreadCount:
      envelope?.unread_count ?? rows.filter((n) => !n.read_at).length,
    page: safePage,
    hasMore: envelope?.has_more ?? false,
  };
}

export async function markRead(id: string): Promise<MarkReadResult> {
  // Validate at the boundary — server actions are public endpoints.
  if (typeof id !== 'string' || id.trim() === '') {
    return { ok: false, error: 'Invalid notification id.' };
  }

  const r = await store.post(
    `/store/notifications/${encodeURIComponent(id)}/read`,
    MarkReadSchema,
    {},
  );
  if (!r.ok) return notifFailure(r, LOGIN_FIRST);

  return {
    ok: true,
    id: r.data.id,
    readAt: coerceReadAt(r.data.read_at) ?? new Date().toISOString(),
  };
}

/**
 * Returns the unread notification count. Returns 0 when logged out — safe to
 * call unconditionally in nav badges without an auth gate.
 */
export async function getUnreadCount(): Promise<number> {
  const r = await store.get(
    '/store/notifications',
    NotificationsEnvelopeSchema,
    // unread_count is a TRUE total (not page-scoped), so the badge only needs
    // the envelope — fetch the smallest legal page.
    { query: { limit: 1 } },
  );
  // Logged out, a failed read, or an envelope that did not parse: no badge
  // rather than a wrong one — exactly what the three old branches did.
  return r.ok ? r.data.unread_count : 0;
}

/**
 * Marks every unread feed notification read in one request.
 *
 * The per-id endpoint is rate-limited at 20/10s, so clearing a 50-row feed
 * client-side would 429 — this is the only viable way to zero the badge.
 */
export async function markAllRead(): Promise<MarkAllReadResult> {
  const r = await store.post(
    '/store/notifications/read-all',
    MarkAllReadSchema,
    {},
  );
  if (!r.ok) return notifFailure(r, LOGIN_FIRST);

  return {
    ok: true,
    marked: r.data.marked,
    readAt: coerceReadAt(r.data.read_at) ?? new Date().toISOString(),
  };
}
