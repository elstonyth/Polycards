'use client';

import { useEffect } from 'react';
import { useCreditDot } from '@/components/app-shell/CreditDotProvider';

/**
 * The money dot on /me's History tile. Rendered INSIDE the tile's icon square,
 * which is why it needs no positioning context of its own.
 *
 * The sr-only text lives here rather than as an aria-label on the Link because
 * the Link is server-rendered and cannot know the dot's state; as a descendant
 * of the Link it still joins the accessible name ("History, new activity").
 * A colour-only signal is invisible to screen readers either way.
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
      <span className="sr-only">, new activity</span>
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
  const { latestAt, markSeen } = useCreditDot();
  useEffect(() => {
    if (latestAt) markSeen();
  }, [latestAt, markSeen]);
  return null;
}
