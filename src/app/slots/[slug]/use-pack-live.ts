'use client';

import { loadSchemas } from '@/lib/lazy-schemas';
import { useLivePoll } from '@/lib/use-live-poll';
import type { PackLive, PackTiers } from '@/lib/pack-tiers';

const POLL_MS = 60_000;
// Soon after a seeded load, not at the next poll: browser Back can restore an
// old server snapshot.
const FIRST_TICK_MS = 5_000;

export const packTiersUrl = (slug: string) =>
  `/api/pack-tiers/${encodeURIComponent(slug)}`;

/**
 * The pack's tier view and live figures (price, buyback, stock), polled from
 * `/api/pack-tiers/<slug>` every 60s while the tab is visible. Only the
 * homepage flow reads it (useFlowData); Lossless Mode flips the buyback
 * percent there within a poll.
 *
 * - `seed` is a server projection for this slug, or null (the homepage
 *   fetches at focus): with no seed it fetches at once, and a failed first
 *   fetch is tried again after FIRST_TICK_MS.
 * - `slug` null polls nothing (nothing focused yet).
 * - Until a response for the current slug lands, the caller's seed is what
 *   renders, never the previous pack's tiers under the new pack's name.
 * - A failed or malformed answer keeps the last good view.
 */
export function usePackLive(
  slug: string | null,
  seed: PackTiers | null,
): { tiers: PackTiers | null; live: PackLive | null } {
  const { data, pending } = useLivePoll<PackTiers | null>(
    slug ? packTiersUrl(slug) : null,
    seed,
    {
      intervalMs: POLL_MS,
      resetKey: slug ?? '',
      firstTickMs: seed === null ? 0 : FIRST_TICK_MS,
      seedFollowsKey: true,
      // the homepage has no seed: a failed first fetch is tried again soon
      retryMs: seed === null ? FIRST_TICK_MS : undefined,
      accept: async (next) => {
        const { PackTiersResponseSchema, parseOne } = await loadSchemas();
        return parseOne(PackTiersResponseSchema, next) ?? null;
      },
    },
  );
  const tiers = pending ? seed : data;
  return { tiers, live: tiers?.pack ?? null };
}
