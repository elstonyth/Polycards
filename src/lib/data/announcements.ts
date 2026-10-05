/**
 * Announcement popup seam (spec 2026-10-06 §5) — the live slides the root
 * layout hands to AnnouncementPopup. Server-only like the other data getters;
 * failures degrade to [] (no popup).
 */
import 'server-only';
import { store } from '@/lib/store';
import { logger } from '@/lib/logger';
import { AnnouncementsSchema, type Announcement } from '@/lib/data/schemas';
import { cached } from '@/lib/ttl-cache';

// The root layout renders on every page, so this must not cost a backend hop
// per view. 60s: an operator's save reaches visitors within a minute (the
// layout's own `revalidate = 60` bounds the prerendered pages the same way).
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
          // Public route on statically prerendered pages: no bearer and no
          // cache key on the wire, or every page would turn dynamic.
          await store.get('/store/announcements', AnnouncementsSchema, {
            auth: 'none',
            cache: 'auto',
          }),
        ).announcements,
    );
  } catch (error) {
    logger.error('[announcements] load failed:', error);
    return [];
  }
}
