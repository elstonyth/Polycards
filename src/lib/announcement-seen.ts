// "Which announcements has this visitor already been shown today?" — the
// popup's once-per-MYT-day rule (spec 2026-10-06 §5). Pure, so the rule is
// unit-tested without a browser; AnnouncementPopup owns the storage access.
//
// The record is a per-day UNION of slide keys, `{ day, seen: [...] }`, not a
// signature of the whole set. With a signature, any change to the set re-popped
// everything: switching one slide off showed the rest again, and two server
// instances holding different copies of the set flapped the popup on every
// load. With a union, only a slide never shown today can open the popup.

export const ANNOUNCEMENT_SEEN_KEY = 'polycards.announcements-seen';

type Keyed = { id: string; updated_at: string };

/** A slide's identity for "seen": an edit (new updated_at) makes it new. */
export const announcementKey = (a: Keyed): string => `${a.id}@${a.updated_at}`;

/** Calendar day in Malaysia (UTC+8, no DST — the fixed shift the rest of the
 *  app uses), e.g. "2026-10-06". */
export const mytDay = (ms: number): string =>
  new Date(ms + 8 * 3_600_000).toISOString().slice(0, 10);

/** Keys shown on `day`. A record from another day, or one that cannot be
 *  read, counts as nothing seen. */
function seenOn(stored: string | null, day: string): Set<string> {
  try {
    const rec = JSON.parse(stored ?? 'null') as {
      day?: unknown;
      seen?: unknown;
    } | null;
    if (rec?.day !== day || !Array.isArray(rec.seen)) return new Set();
    return new Set(rec.seen.filter((k): k is string => typeof k === 'string'));
  } catch {
    return new Set();
  }
}

/** The live slides not yet shown today, in carousel order. Empty = no popup.
 *  Removing, expiring or switching off a slide never re-shows the others;
 *  an added or edited slide shows on its own. */
export function unseenAnnouncements<T extends Keyed>(
  live: T[],
  stored: string | null,
  day: string,
): T[] {
  const seen = seenOn(stored, day);
  return live.filter((a) => !seen.has(announcementKey(a)));
}

/** The record to store once `shown` is on screen: today's union. */
export function recordSeen(
  stored: string | null,
  shown: Keyed[],
  day: string,
): string {
  const seen = seenOn(stored, day);
  for (const a of shown) seen.add(announcementKey(a));
  return JSON.stringify({ day, seen: [...seen] });
}
