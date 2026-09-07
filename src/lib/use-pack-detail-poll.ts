'use client';

import type { PackDetail } from '@/lib/data/packs';
import { PackPollResponseSchema, parseOne } from '@/lib/data/schemas';
import { useLivePoll } from '@/lib/use-live-poll';

const POLL_MS = 60_000;

/** Live pack detail: fetches immediately on mount AND on every pack switch,
 *  then refreshes every 60s while the tab is visible. The caller only ever
 *  passes `initial` for the matching pack (null on a sibling switch, per
 *  PackDetailClient) -- so a switch renders null (the caller's gated-empty
 *  sections) until the immediate tick lands, never the PREVIOUS pack's pool/
 *  Top Hits/odds under the new pack's name. The immediate tick still matters:
 *  without it, a sibling switch would sit empty for up to a full poll
 *  interval instead of resolving within one request. */
export function usePackDetailPoll(
  slug: string,
  initial: PackDetail | null,
): PackDetail | null {
  const { data, pending } = useLivePoll<PackDetail | null>(
    `/api/pack-detail/${encodeURIComponent(slug)}`,
    initial,
    {
      intervalMs: POLL_MS,
      resetKey: slug,
      accept: (next) => parseOne(PackPollResponseSchema, next)?.detail ?? null,
    },
  );
  // `pending` is exactly "this slug's data hasn't landed yet": show the new
  // seed rather than the previous pack's detail. A same-slug seed re-render is
  // not pending, so it can never stomp fresher polled data.
  return pending ? initial : data;
}
