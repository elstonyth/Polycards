// "Has this visitor already seen today's announcements?" — the popup's
// once-per-MYT-day rule (spec 2026-10-06 §5). Pure, so the rule is unit-tested
// without a browser; AnnouncementPopup owns the storage access.

export const ANNOUNCEMENT_SEEN_KEY = 'polycards.announcements-seen';

/** Identity of the live set: a new, removed or edited slide changes it, so
 *  the popup re-shows at once instead of waiting for tomorrow. */
export const announcementSig = (
  list: { id: string; updated_at: string }[],
): string => list.map((a) => `${a.id}@${a.updated_at}`).join('|');

/** Calendar day in Malaysia (UTC+8, no DST — the fixed shift the rest of the
 *  app uses), e.g. "2026-10-06". */
export const mytDay = (ms: number): string =>
  new Date(ms + 8 * 3_600_000).toISOString().slice(0, 10);

/** Show unless the stored record names this exact set on this exact day.
 *  Anything unreadable counts as "not seen". */
export function shouldShowAnnouncements(
  stored: string | null,
  sig: string,
  day: string,
): boolean {
  if (!sig) return false;
  try {
    const seen = JSON.parse(stored ?? 'null') as {
      sig?: unknown;
      day?: unknown;
    } | null;
    return seen?.sig !== sig || seen?.day !== day;
  } catch {
    return true;
  }
}
