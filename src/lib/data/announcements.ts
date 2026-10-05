/**
 * Announcement popup seam (spec 2026-10-06 §5) — the live slides behind
 * GET /api/announcements, which AnnouncementPopup fetches client-side.
 * Server-only like the other data getters; failures degrade to [] (no popup).
 */
import 'server-only';
import { store } from '@/lib/store';
import { logger } from '@/lib/logger';
import { AnnouncementsSchema, type Announcement } from '@/lib/data/schemas';
import { cached } from '@/lib/ttl-cache';

// Every page load asks for this, so it must not cost a backend hop per view.
// 60s: an operator's save reaches visitors within a minute.
const ANNOUNCEMENTS_TTL_MS = 60_000;

/** Degradation caught OUTSIDE `cached`, same contract as getAvatarFrames: a
 *  failure must evict and retry, not memoise [] for the whole window. */
export async function getAnnouncements(): Promise<Announcement[]> {
  try {
    return await cached(
      'announcements',
      ANNOUNCEMENTS_TTL_MS,
      async () =>
        store.orThrow(
          // Public route: no bearer. The caller is a force-dynamic route
          // handler, so the default no-store costs nothing.
          await store.get('/store/announcements', AnnouncementsSchema, {
            auth: 'none',
          }),
        ).announcements,
    );
  } catch (error) {
    logger.error('[announcements] load failed:', error);
    return [];
  }
}
