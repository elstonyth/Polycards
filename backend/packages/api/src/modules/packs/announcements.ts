// modules/packs/announcements.ts — the announcement popup's pure half (spec
// 2026-10-06 §5): the admin write gate and the "which rows are live" filter.
// No DB — the service hands rows in, so the unit suite drives exactly what
// production runs.

import { MedusaError } from '@medusajs/framework/utils';
import { taskIsLive } from './tasks';

export const ANNOUNCEMENT_TITLE_MAX = 80;
/** One popup, swipe carousel — past ten slides nobody is still swiping. */
export const LIVE_ANNOUNCEMENTS_CAP = 10;

const invalid = (message: string) =>
  new MedusaError(MedusaError.Types.INVALID_DATA, message);

// Same rule as site-settings' slab_frame_url: a same-origin path or an
// explicit http(s) URL, ≤ 2048 chars. '//' is protocol-relative — an
// off-origin URL in disguise — so it is refused, as is any other scheme
// (javascript:, data:), which matters doubly here: link_url becomes an href.
function cleanUrl(value: string): string | null {
  const v = value.trim();
  return v.length > 0 &&
    v.length <= 2048 &&
    ((v.startsWith('/') && !v.startsWith('//')) ||
      v.startsWith('http://') ||
      v.startsWith('https://'))
    ? v
    : null;
}

export interface AnnouncementFields {
  image_url: string;
  title: string | null;
  link_url: string | null;
}

/** Admin write gate. Throws INVALID_DATA; returns the trimmed fields with
 *  blank title / link normalized to null. */
export function validateAnnouncement(input: {
  image_url: string;
  title: string | null;
  link_url: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
}): AnnouncementFields {
  const image_url = cleanUrl(input.image_url);
  if (!image_url) {
    throw invalid('image_url must be a /path or http(s) URL (≤ 2048 chars).');
  }
  const title = input.title?.trim() || null;
  if (title && title.length > ANNOUNCEMENT_TITLE_MAX) {
    throw invalid(`title must be ≤ ${ANNOUNCEMENT_TITLE_MAX} chars.`);
  }
  let link_url: string | null = null;
  if (input.link_url?.trim()) {
    link_url = cleanUrl(input.link_url);
    if (!link_url) {
      throw invalid('link_url must be a /path or http(s) URL (≤ 2048 chars).');
    }
  }
  if (
    input.startsAt &&
    input.endsAt &&
    input.endsAt.getTime() <= input.startsAt.getTime()
  ) {
    throw invalid('The schedule end must be after its start.');
  }
  return { image_url, title, link_url };
}

type LiveCandidate = {
  active: boolean;
  sort: number;
  starts_at?: Date | string | null;
  ends_at?: Date | string | null;
  created_at: Date | string;
};

/** Active, inside the run window (same bounds as tasks: start inclusive, end
 *  exclusive), sort ASC then newest first, capped. */
export function pickLiveAnnouncements<T extends LiveCandidate>(
  rows: T[],
  now: Date,
): T[] {
  return rows
    .filter((r) => r.active && taskIsLive(r, now))
    .sort(
      (a, b) =>
        a.sort - b.sort ||
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    )
    .slice(0, LIVE_ANNOUNCEMENTS_CAP);
}
