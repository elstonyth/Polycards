'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

const REDUCED_QUERY = '(prefers-reduced-motion: reduce)';

function subscribeReducedMotion(onChange: () => void) {
  const mql = window.matchMedia(REDUCED_QUERY);
  mql.addEventListener('change', onChange);
  return () => mql.removeEventListener('change', onChange);
}

/**
 * SSR-safe `prefers-reduced-motion` listener. Backed by `useSyncExternalStore` so
 * there's no setState-in-effect; the server snapshot is always `false`, matching the
 * client's first paint (no hydration flash).
 */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReducedMotion,
    () => window.matchMedia(REDUCED_QUERY).matches,
    () => false,
  );
}

/**
 * Fire-once scroll-into-view detector. Returns a ref + a `shown` flag that flips
 * true the first time the element enters the viewport, then stops observing.
 * Works with the page's real scroll container (IntersectionObserver uses the
 * nearest scrollable ancestor automatically).
 */
export function useInView<T extends HTMLElement = HTMLDivElement>() {
  const ref = useRef<T>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    // If IntersectionObserver is unavailable (legacy / SSR-only), reveal on the next
    // tick — deferred via setTimeout so we never setState synchronously in the effect.
    if (typeof IntersectionObserver === 'undefined') {
      const id = setTimeout(() => setShown(true), 0);
      return () => clearTimeout(id);
    }
    const obs = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setShown(true);
            obs.unobserve(entry.target);
          }
        }
      },
      { threshold: 0.15, rootMargin: '0px 0px -8% 0px' },
    );
    obs.observe(node);
    return () => obs.disconnect();
  }, []);

  return [ref, shown] as const;
}
