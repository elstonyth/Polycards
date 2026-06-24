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
 */
import { sdk } from '@/lib/medusa';
import { logger } from '@/lib/logger';
import { getAuthToken } from '@/lib/data/customer';
import { friendlyError, isAuthError, type ErrorRule } from '@/lib/errors';
import {
  parseOne,
  parseList,
  NotificationSchema,
  NotificationsEnvelopeSchema,
  MarkReadSchema,
} from '@/lib/data/schemas';

export type Notification = {
  id: string;
  template: string;
  data: Record<string, unknown> | null;
  createdAt: string;
  readAt: string | null;
};

export type NotificationsResult =
  | { ok: true; notifications: Notification[]; unreadCount: number }
  | { ok: false; error: string; needsAuth?: boolean };

export type MarkReadResult =
  | { ok: true; id: string; readAt: string }
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

/** Coerce a backend read_at (string | Date | null) to string | null. */
function coerceReadAt(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return value;
}

export async function getNotifications(): Promise<NotificationsResult> {
  const token = await getAuthToken();
  if (!token) {
    return {
      ok: false,
      error: 'Please log in to view your notifications.',
      needsAuth: true,
    };
  }

  try {
    const raw = await sdk.client.fetch('/store/notifications', {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    });

    const envelope = parseOne(NotificationsEnvelopeSchema, raw);
    const rows = parseList(
      NotificationSchema,
      (raw as { notifications?: unknown }).notifications,
    );

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
    };
  } catch (error) {
    logger.error('[notifications] load failed:', error);
    return {
      ok: false,
      error: friendlyError(error, NOTIF_RULES, NOTIF_FALLBACK),
      needsAuth: isAuthError(error),
    };
  }
}

export async function markRead(id: string): Promise<MarkReadResult> {
  // Validate at the boundary — server actions are public endpoints.
  if (typeof id !== 'string' || id.trim() === '') {
    return { ok: false, error: 'Invalid notification id.' };
  }

  const token = await getAuthToken();
  if (!token) {
    return { ok: false, error: 'Please log in first.', needsAuth: true };
  }

  try {
    const raw = await sdk.client.fetch(
      `/store/notifications/${encodeURIComponent(id)}/read`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: {},
      },
    );

    const parsed = parseOne(MarkReadSchema, raw);
    if (!parsed) {
      return {
        ok: false,
        error: 'Got an unexpected response. Please try again.',
      };
    }

    return {
      ok: true,
      id: parsed.id,
      readAt: coerceReadAt(parsed.read_at) ?? new Date().toISOString(),
    };
  } catch (error) {
    logger.error(`[notifications] markRead failed for '${id}':`, error);
    return {
      ok: false,
      error: friendlyError(error, NOTIF_RULES, NOTIF_FALLBACK),
      needsAuth: isAuthError(error),
    };
  }
}

/**
 * Returns the unread notification count. Returns 0 when logged out — safe to
 * call unconditionally in nav badges without an auth gate.
 */
export async function getUnreadCount(): Promise<number> {
  const token = await getAuthToken();
  if (!token) return 0;

  try {
    const raw = await sdk.client.fetch('/store/notifications', {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
    const envelope = parseOne(NotificationsEnvelopeSchema, raw);
    return envelope?.unread_count ?? 0;
  } catch (error) {
    logger.error('[notifications] unread count failed:', error);
    return 0;
  }
}
