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

export const ANNOUNCEMENT_SORT_MAX = 1_000_000;

// Whitespace, backslashes and control characters: a browser strips or
// reinterprets them (it reads `\` as `/`, so `/\evil.example` is
// protocol-relative), and a URL carrying one can mean something other than
// what the checks below saw.
const hasUnsafeChar = (v: string): boolean =>
  /[\s\\]/.test(v) ||
  [...v].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f);

const isHttpUrl = (v: string): boolean => {
  if (!/^https?:\/\//i.test(v)) return false;
  try {
    const { protocol } = new URL(v);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
};

// The image is always an /admin/media upload, which returns an ABSOLUTE URL
// (the S3/CDN host in prod, the backend's /static locally). Relative paths are
// refused: next/image throws on some of them (a `?` in a local src) and that
// would take the storefront to its error page. SVG is refused too — it is a
// document, not a picture, and /admin/media never produces one.
function cleanImageUrl(value: string): string | null {
  const v = value.trim();
  if (!v || v.length > 2048 || hasUnsafeChar(v) || !isHttpUrl(v)) return null;
  return /\.svg$/i.test(new URL(v).pathname) ? null : v;
}

// link_url becomes an href: an in-site path (`/x`, never `//` or `/\`, which
// a browser treats as off-origin) or an explicit http(s) URL. Any other
// scheme (javascript:, data:) is refused.
function cleanLinkUrl(value: string): string | null {
  const v = value.trim();
  if (!v || v.length > 2048 || hasUnsafeChar(v)) return null;
  return /^\/(?![/\\])/.test(v) || isHttpUrl(v) ? v : null;
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
  sort: number;
  startsAt: Date | null;
  endsAt: Date | null;
}): AnnouncementFields {
  const image_url = cleanImageUrl(input.image_url);
  if (!image_url) {
    throw invalid(
      'image_url must be an absolute http(s) image URL (not SVG, ≤ 2048 chars) — upload it through /admin/media.',
    );
  }
  const title = input.title?.trim() || null;
  if (title && title.length > ANNOUNCEMENT_TITLE_MAX) {
    throw invalid(`title must be ≤ ${ANNOUNCEMENT_TITLE_MAX} chars.`);
  }
  let link_url: string | null = null;
  if (input.link_url?.trim()) {
    link_url = cleanLinkUrl(input.link_url);
    if (!link_url) {
      throw invalid(
        'link_url must be a site path like /slots/x or an http(s) URL (≤ 2048 chars, no spaces or backslashes).',
      );
    }
  }
  if (
    !Number.isInteger(input.sort) ||
    Math.abs(input.sort) > ANNOUNCEMENT_SORT_MAX
  ) {
    throw invalid(
      `sort must be a whole number between -${ANNOUNCEMENT_SORT_MAX} and ${ANNOUNCEMENT_SORT_MAX}.`,
    );
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
