'use client';

import { useEffect, useRef } from 'react';
import { usePrefersReducedMotion } from '@/lib/use-reveal';

/**
 * Board 01 motion: idle float (CSS slabFloat) + a subtle scroll-linked
 * tilt/parallax as the hero scrolls out. rAF-throttled passive listener, CSS
 * transforms only. Reduced motion: perfectly still (no float, no tilt).
 */
export default function HeroSlab({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    if (reduced) return;
    const node = ref.current;
    if (!node) return;
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        // 0 at top → 1 after one viewport of scroll
        const progress = Math.min(
          1,
          Math.max(0, window.scrollY / window.innerHeight),
        );
        node.style.transform = `translateY(${progress * 32}px) rotate3d(1, 0, 0, ${progress * 8}deg)`;
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => {
      window.removeEventListener('scroll', onScroll);
      if (raf) cancelAnimationFrame(raf);
      node.style.transform = '';
    };
  }, [reduced]);

  return (
    <div style={{ perspective: '900px' }}>
      <div ref={ref}>
        <div className="animate-[slabFloat_6s_ease-in-out_infinite] motion-reduce:animate-none">
          {children}
        </div>
      </div>
    </div>
  );
}
