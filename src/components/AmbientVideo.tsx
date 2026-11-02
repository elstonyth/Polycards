'use client';

import { useEffect, useRef } from 'react';
import { preload } from 'react-dom';
import { usePrefersReducedMotion } from '@/lib/use-reveal';

/**
 * Decorative, autoplaying, muted, looping hero loop with a still poster — for
 * ambient scene motion (factory line, shop at night), not a playable video.
 * No controls: it is background atmosphere, so it carries no content a user
 * needs to pause/seek (that is what the controls-on `HeroVideo` demo player is
 * for). The poster is the clip's own first frame, so there is no pop on play,
 * and it doubles as the LCP image and the reduced-motion still — under
 * `prefers-reduced-motion` the clip never plays and the element just shows
 * the poster. The clip downloads from hydration on, never ahead of the page's
 * first paint. `webm` (VP9) is offered first for smaller bytes; `mp4` (H.264) is
 * the universal fallback.
 *
 * It is `aria-hidden`: the motion is decoration whose meaning is always carried
 * by the surrounding text (headings, pack title/price), so exposing it to
 * assistive tech would only add noise.
 */
export function AmbientVideo({
  mp4,
  webm,
  poster,
  className,
  fit = 'cover',
  testId,
}: {
  mp4: string;
  webm?: string;
  poster: string;
  className?: string;
  fit?: 'cover' | 'contain';
  /** Keeps a hero selector stable across the video and still-image branches
   *  (both a <video> and an <img> expose `.currentSrc`). */
  testId?: string;
}) {
  // The poster is the LCP, and a <video> poster is found late without this.
  preload(poster, { as: 'image', fetchPriority: 'high' });
  const ref = useRef<HTMLVideoElement>(null);
  const reduced = usePrefersReducedMotion();

  // Started here, not with `autoPlay`, so the bytes wait for hydration.
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    if (reduced) {
      v.pause();
      v.currentTime = 0;
    } else {
      v.play().catch(() => {});
    }
  }, [reduced]);

  return (
    <video
      ref={ref}
      data-testid={testId}
      className={className}
      style={{ objectFit: fit }}
      poster={poster}
      muted
      loop
      playsInline
      preload="none"
      aria-hidden
    >
      {webm ? <source src={webm} type="video/webm" /> : null}
      <source src={mp4} type="video/mp4" />
    </video>
  );
}
