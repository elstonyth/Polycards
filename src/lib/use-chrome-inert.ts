'use client';

import { useEffect } from 'react';

/**
 * Immersive-surface helper: while `active`, lock body scroll and mark the root
 * site chrome (`[data-site-chrome]` = SiteHeader/SiteFooter) `inert` +
 * `aria-hidden` so focus and the a11y tree can't escape into the chrome behind a
 * full-screen overlay. Restores everything on cleanup. (spec §10, G2 — overlay
 * mechanism, supersedes the route-group plan for Phase B.)
 */
export function useChromeInert(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const nodes = Array.from(
      document.querySelectorAll<HTMLElement>('[data-site-chrome]'),
    );
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    for (const n of nodes) {
      n.setAttribute('inert', '');
      n.setAttribute('aria-hidden', 'true');
    }
    return () => {
      document.body.style.overflow = prevOverflow;
      for (const n of nodes) {
        n.removeAttribute('inert');
        n.removeAttribute('aria-hidden');
      }
    };
  }, [active]);
}
