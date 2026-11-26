'use client';

import { useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import { cn } from '@/lib/utils';
import type { HoloKind, HoloTone } from './holo-pose';
import type { HoloHandle } from './holo-runtime';

/**
 * A live 3D icon (crown, gift or vault door): glossy black lit in white, or a
 * solid metal (`tone`). It floats and turns on its own, leans towards the
 * mouse, and when `interactive` turns under a drag and plays its move on a
 * tap. Decoration only, so it is hidden from assistive tech.
 *
 * The poster picture shows first and stays for reduced motion or no WebGL;
 * the 3D code and model load only once the icon is near the screen.
 * `className` sizes the square box.
 *
 * A poster is a file, /3dicons/<kind>[-<tone>][-cage].webp, and exists only
 * for the pairings in use: add a new one to /holo-preview and run
 * scripts/capture-holo-posters.mjs.
 */
export function HoloIcon({
  kind,
  tone = 'ink',
  cage = false,
  interactive = true,
  still = false,
  className,
}: {
  kind: HoloKind;
  tone?: HoloTone;
  /** The hologram cube, floor dial and scan line. For 128px and up. */
  cage?: boolean;
  interactive?: boolean;
  /** The poster only, no 3D: for a row of small icons, where a 3D scene
   *  each would cost a phone more than it shows. */
  still?: boolean;
  className?: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [live, setLive] = useState(false);

  useEffect(() => {
    // No canvas when `still`.
    const el = canvas.current;
    if (!el) return;
    // The poster stays for reduced motion, and where a browser (or a test's
    // DOM) lacks what the live icon needs.
    if (typeof IntersectionObserver === 'undefined') return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    let handle: HoloHandle | null = null;
    let gone = false;
    const near = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        near.disconnect();
        void import('./holo-runtime')
          .then(({ mountHolo }) => {
            if (gone) return;
            handle = mountHolo(el, {
              kind,
              tone,
              cage,
              interactive,
              onReady: () => setLive(true),
            });
          })
          .catch(() => {});
      },
      { rootMargin: '200px' },
    );
    near.observe(el);
    return () => {
      gone = true;
      near.disconnect();
      handle?.dispose();
      setLive(false);
    };
  }, [kind, tone, cage, interactive, still]);

  return (
    <span
      aria-hidden
      className={cn('relative block aspect-square select-none', className)}
    >
      <Image
        src={`/3dicons/${kind}${tone === 'ink' ? '' : `-${tone}`}${cage ? '-cage' : ''}.webp`}
        alt=""
        width={352}
        height={352}
        className={cn(
          'pointer-events-none h-full w-full object-contain transition-opacity duration-500',
          live && 'opacity-0',
        )}
      />
      {!still && (
        <canvas
          ref={canvas}
          className={cn(
            'absolute inset-0 h-full w-full transition-opacity duration-500',
            live ? 'opacity-100' : 'opacity-0',
            interactive
              ? 'cursor-grab touch-pan-y active:cursor-grabbing'
              : 'pointer-events-none',
          )}
        />
      )}
    </span>
  );
}
