'use client';

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

const REDUCED_QUERY = '(prefers-reduced-motion: reduce)';

function subscribeReducedMotion(onChange: () => void) {
  const mql = window.matchMedia(REDUCED_QUERY);
  mql.addEventListener('change', onChange);
  return () => mql.removeEventListener('change', onChange);
}

/**
 * SSR-safe media-query listener, same shape as `usePrefersReducedMotion`: the
 * server snapshot is always `false`, so the first client paint matches the HTML
 * and the query result lands on hydration (no flash). For layout that CSS can't
 * express — a JS number a rendering engine consumes, not a class name.
 */
export function useMediaQuery(query: string): boolean {
  const [subscribe, snapshot] = useMemo(
    () =>
      [
        (onChange: () => void) => {
          const mql = window.matchMedia(query);
          mql.addEventListener('change', onChange);
          return () => mql.removeEventListener('change', onChange);
        },
        () => window.matchMedia(query).matches,
      ] as const,
    [query],
  );
  return useSyncExternalStore(subscribe, snapshot, () => false);
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

/**
 * Per-item stagger delay for a container-driven reveal: child `index` fades in
 * `index * stepMs` after the container scrolls into view. Returns a `style`-ready
 * object so staggered sections (HowItWorksSteps, LeaderboardSection) share the
 * one timing formula instead of re-deriving the ternary. Delay is suppressed
 * under reduced motion (the items are shown immediately, no transition).
 */
export function staggerDelay(
  shown: boolean,
  reduced: boolean,
  index: number,
  stepMs: number,
): { transitionDelay: string } {
  return { transitionDelay: shown && !reduced ? `${index * stepMs}ms` : '0ms' };
}
