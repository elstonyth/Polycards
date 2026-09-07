'use client';

import type { RecentFeed } from '@/lib/data/packs';
import type { Rarity } from '@/lib/packs-data';
import { RecentPollResponseSchema, parseOne } from '@/lib/data/schemas';
import { useLivePoll } from '@/lib/use-live-poll';

// "Live" = polling of the same-origin proxy (a direct :9000 call is
// CORS-blocked). This is the storefront's single highest-volume request: one
// tick per open tab on the home or a pack page, forever. At 4s, 2000 concurrent
// tabs meant 500 req/s against a one-vCPU instance; 10s is the same feed at a
// fifth of the cost.
//
// Nothing perceptible is lost. Both hops already serve from 5s caches (this
// route and the backend's store/pulls/recent), so a row could already be ~10s
// behind the ledger, and the feed labels time in whole minutes.
const POLL_MS = 10_000;

/** An empty response only replaces the rows on screen when the scope changed
 *  (`pending`) — otherwise a pack with no pulls would keep showing the
 *  previous pack's rows, while a backend blip would blank a healthy feed. */
function acceptFeed(
  next: unknown,
  _prev: RecentFeed,
  pending: boolean,
): RecentFeed | null {
  const body = parseOne(RecentPollResponseSchema, next);
  if (!body) return null;
  if (body.pulls.length === 0 && !pending) return null;
  return body;
}

/** Live pull-history feed: seeds from the server snapshot, then polls.
 *  `packSlug` scopes the poll to one pack's own history (the /slots/[slug]
 *  pages); omit it for the global feed. `rarity` keeps only that tier (the
 *  panel's tabs) — switching it refetches at once, and `pending` is true
 *  until rows for the new scope have landed (the previous scope's rows stay
 *  on screen meanwhile, so a tab switch never flashes an empty list).
 *  Keeps the last good set on transient failures so the feed never blanks. */
export function useLiveRecentPulls(
  initial: RecentFeed,
  packSlug?: string,
  rarity?: Rarity | null,
): RecentFeed & {
  pending: boolean;
  /** The (pack, tier) scope the rows on screen belong to — changes exactly
   *  when a new scope's rows land, so a list keyed on it re-enters once. */
  shownScope: string;
} {
  const q = new URLSearchParams();
  if (packSlug) q.set('pack_id', packSlug);
  if (rarity) q.set('rarity', rarity);
  const qs = q.toString();
  // The seed came from the server for the mount-time pack, unfiltered — so the
  // scope it belongs to is the mount-time scope, which is what useLivePoll
  // records as `shownKey`.
  const { data, pending, shownKey } = useLivePoll<RecentFeed>(
    `/api/recent-pulls${qs ? `?${qs}` : ''}`,
    initial,
    {
      intervalMs: POLL_MS,
      // A client-side nav between two pack pages (or a tier switch) refetches
      // at once and reports `pending` until the new scope's rows land.
      resetKey: `${packSlug ?? ''}|${rarity ?? ''}`,
      accept: acceptFeed,
    },
  );

  return { ...data, pending, shownScope: shownKey };
}
