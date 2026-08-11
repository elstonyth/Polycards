'use client';

/**
 * PARTIALLY SUSPENDED 2026-08-11 — this file has one dead export and one live
 * one; read both paragraphs before pruning either.
 *
 * SUSPENDED: `QuickAccessCreditDot`. The operator asked for the History tile to
 * stop announcing itself, so all three render sites went in one change — this
 * tile (me/page.tsx) and the Me-tab dot the same signal fed on both chrome
 * surfaces (TabBar.tsx, AppHeader.tsx). Restoring the dot means re-adding those
 * three call sites AND the `refreshCreditDot()` call that went with them from
 * TopUpProvider. Don't delete this export in the meantime.
 *
 * STILL LIVE: `MarkCreditsSeen`, mounted by /transactions. It keeps the seen
 * stamp moving while the dot is dark, so a restored dot lights on new activity
 * instead of a backlog the customer already read.
 *
 * Also still wired: CreditDotProvider in layout.tsx. Unmounting it is an
 * app-shell crash rather than a cleanup — useDot throws on a null context, and
 * MarkCreditsSeen below is a consumer.
 *
 * Live residue while suspended: one throttled getCreditsLatest read per
 * login/focus, plus one unthrottled read per /transactions visit (below), both
 * feeding the stamp rather than any pixel.
 */

import { useEffect } from 'react';
import { useCreditDot } from '@/components/app-shell/CreditDotProvider';

/**
 * The money dot on /me's History tile. Rendered INSIDE the tile's icon square,
 * which is why it needs no positioning context of its own.
 *
 * The sr-only text lives here rather than as an aria-label on the Link because
 * the Link is server-rendered and cannot know the dot's state; as a descendant
 * of the Link it still joins the accessible name. It reads as a PREFIX
 * ("New activity, History") because this component sits in the icon square,
 * which precedes the label in DOM order — and DOM order is what builds the
 * name. A colour-only signal is invisible to screen readers either way.
 */
export function QuickAccessCreditDot() {
  const { show } = useCreditDot();
  if (!show) return null;
  return (
    <>
      <span
        aria-hidden
        className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-neutral-50"
      />
      <span className="sr-only">New activity, </span>
    </>
  );
}

/**
 * Renders nothing; opening /transactions marks the balance movements seen.
 *
 * Keyed on `latestAt` rather than bare mount for two reasons: reaching the page
 * before the provider's fetch resolves would otherwise stamp nothing, and a
 * transaction landing DURING the visit clears itself on the next refresh
 * instead of leaving a dot lit for a row already on screen.
 */
export function MarkCreditsSeen() {
  const { latestAt, markSeen, refresh } = useCreditDot();
  // Re-read first. Reaching here by client-side nav neither remounts the
  // provider nor fires focus, so `latestAt` can be OLDER than the rows this
  // page just server-rendered. Stamping the stale value would clear the dot
  // now and relight it on the next focus for a row already read — "the dot
  // won't go away". Refreshing lets the effect below stamp the settled value.
  useEffect(() => {
    refresh();
  }, [refresh]);
  useEffect(() => {
    if (latestAt) markSeen();
  }, [latestAt, markSeen]);
  return null;
}
