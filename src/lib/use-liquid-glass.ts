'use client';

import { useEffect, useRef, type RefObject } from 'react';
import {
  liquidGlass,
  type LiquidGlassHandle,
  type LiquidGlassOptions,
} from './liquid-glass';

/**
 * Tuned presets (see .claude/skills/liquid-glass). SUBTLE is for text-heavy
 * panels — sheets, modals, forms — where the interior must stay legible.
 * ACCENT is for small, short-content surfaces (toast, chips, banners) that
 * can afford the stronger rim bulge.
 */
export const GLASS_SUBTLE: LiquidGlassOptions = {
  scale: -60,
  chroma: 4,
  blur: 6,
  saturate: 1.4,
  fallbackBlur: 24,
};

export const GLASS_ACCENT: LiquidGlassOptions = {
  scale: -100,
  chroma: 6,
  blur: 4,
  saturate: 1.5,
  fallbackBlur: 20,
};

/**
 * Liquid-glass rim refraction on `ref`'s element while `enabled` is true
 * (pass the modal/sheet `open` flag so the map is built only when the panel
 * is actually mounted). Options are read when the effect (re)runs — they are
 * static per call site, not reactive. Safari/Firefox get the frosted-blur
 * fallback automatically; callers keep the CSS dressing (translucent tint,
 * border, inset highlights) so the fallback still reads as glass.
 */
export function useLiquidGlass(
  ref: RefObject<HTMLElement | null>,
  enabled = true,
  opts: LiquidGlassOptions = GLASS_SUBTLE,
) {
  const optsRef = useRef(opts);
  // Ref writes during render are disallowed in React 19 — sync in an effect
  // (same convention as use-modal-a11y). Declared before the glass effect so
  // it runs first within each commit.
  useEffect(() => {
    optsRef.current = opts;
  });

  useEffect(() => {
    if (!enabled) return;
    // OS "reduce transparency": globals.css bumps the .glass-* tints to
    // near-opaque, so drop the backdrop filter — and track live changes to
    // the setting, destroying/recreating the effect as it flips.
    const mql = window.matchMedia('(prefers-reduced-transparency: reduce)');
    let handle: LiquidGlassHandle | null = null;
    const sync = () => {
      if (mql.matches) {
        handle?.destroy();
        handle = null;
      } else if (!handle && ref.current) {
        handle = liquidGlass(ref.current, optsRef.current);
      }
    };
    sync();
    mql.addEventListener('change', sync);
    return () => {
      mql.removeEventListener('change', sync);
      handle?.destroy();
    };
  }, [ref, enabled]);
}
