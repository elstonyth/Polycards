'use client';

import { useEffect, useRef } from 'react';
import { usePrefersReducedMotion } from '@/lib/use-reveal';

// Demo video with a pause affordance (WCAG 2.2.2): native controls always on,
// autoplay skipped for reduced-motion users (poster + controls only).
//
// Sources follow `AmbientVideo`: `webm` (VP9) first for smaller bytes, `mp4`
// (H.264) as the universal fallback. This clip autoplays, so `preload`
// buys nothing once playback starts and the whole file lands on every visit —
// the VP9 sibling is what keeps that from being 1.8MB.
export default function HeroVideo({
  mp4,
  webm,
  poster,
  label,
  className,
}: {
  mp4: string;
  webm?: string;
  poster: string;
  label: string;
  className?: string;
}) {
  const reduced = usePrefersReducedMotion();
  const ref = useRef<HTMLVideoElement>(null);
  // The hydration pass renders the server snapshot (reduced=false), so the
  // video may already be playing by the time the real preference lands —
  // pause it explicitly.
  useEffect(() => {
    if (reduced) ref.current?.pause();
  }, [reduced]);
  return (
    <video
      ref={ref}
      poster={poster}
      autoPlay={!reduced}
      loop
      muted
      playsInline
      controls
      preload="metadata"
      aria-label={label}
      className={className}
    >
      {webm ? <source src={webm} type="video/webm" /> : null}
      <source src={mp4} type="video/mp4" />
    </video>
  );
}
