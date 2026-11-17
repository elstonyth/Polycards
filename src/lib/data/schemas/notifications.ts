import { z } from './zod';
import { finite, listOf, parseOne } from './shared';

/** GET /store/notifications — single notification row in the feed. */
export const NotificationSchema = z.looseObject({
  id: z.string(),
  template: z.string(),
  data: z.looseObject({}).nullable().optional(),
  created_at: z.string(),
  read_at: z.union([z.string(), z.date()]).nullable(),
});

/** GET /store/notifications — outer envelope (notifications array + unread_count).
 *  `has_more` (pagination) is optional so an older backend still parses. */
export const NotificationsEnvelopeSchema = z.looseObject({
  unread_count: finite,
  has_more: z.boolean().optional(),
});

/** GET /store/notifications as the feed reads it. The envelope is SOFT, like
 *  CreditsPageSchema's totals: a malformed `unread_count` parses to null and
 *  the action falls back to counting the unread rows it did get, rather than
 *  blanking the feed. Rows drop one at a time (`parseList`'s semantics). */
export const NotificationsPageSchema = z
  .looseObject({ notifications: listOf(NotificationSchema) })
  .transform((page) => ({
    envelope: parseOne(NotificationsEnvelopeSchema, page),
    rows: page.notifications,
  }));

/** POST /store/notifications/:id/read — mark-read response. */
export const MarkReadSchema = z.looseObject({
  id: z.string(),
  read_at: z.union([z.string(), z.date()]),
});

/** POST /store/notifications/read-all — bulk mark-read response. */
export const MarkAllReadSchema = z.looseObject({
  marked: finite,
  read_at: z.union([z.string(), z.date()]),
});
