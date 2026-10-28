import { MedusaError } from '@medusajs/framework/utils';

// A start this far in the past is still accepted, so "start it now" survives a
// slow form submit and a skewed browser clock. Anything older is refused: a
// window dated well into the past would price instant sells at 100% from a
// moment nobody scheduled.
const START_GRACE_MS = 5 * 60_000;

const invalid = (message: string): never => {
  throw new MedusaError(MedusaError.Types.INVALID_DATA, message);
};

const parseIso = (value: unknown, field: string): Date => {
  const date = typeof value === 'string' ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime()))
    return invalid(`${field} must be an ISO date-time string.`);
  return date;
};

/**
 * Shape and time checks for POST /admin/lossless-schedules. Whether each slug
 * is a real, eligible pack needs the catalog, so the route does that part.
 * `nowMs` is a parameter so the 5-minute edge is testable.
 */
export function parseLosslessSchedule(
  body: unknown,
  nowMs: number,
): { startsAt: Date; endsAt: Date; packSlugs: string[] | null } {
  const raw = (body ?? {}) as Record<string, unknown>;
  const startsAt = parseIso(raw.starts_at, 'starts_at');
  const endsAt = parseIso(raw.ends_at, 'ends_at');

  if (endsAt.getTime() <= startsAt.getTime())
    invalid('ends_at must be after starts_at.');
  if (endsAt.getTime() <= nowMs) invalid('ends_at must be in the future.');
  if (startsAt.getTime() < nowMs - START_GRACE_MS)
    invalid('starts_at cannot be more than 5 minutes in the past.');

  // Absent or null = every eligible pack. An empty list is refused rather than
  // read as "none": it would save a window that does nothing, or be mistaken
  // for "all".
  let packSlugs: string[] | null = null;
  if (raw.pack_slugs !== undefined && raw.pack_slugs !== null) {
    const slugs = raw.pack_slugs;
    if (
      !Array.isArray(slugs) ||
      slugs.length === 0 ||
      !slugs.every((s) => typeof s === 'string' && s !== '')
    )
      invalid('pack_slugs must be a non-empty list of pack slugs, or omitted for all packs.');
    packSlugs = [...new Set(slugs as string[])];
  }

  return { startsAt, endsAt, packSlugs };
}
