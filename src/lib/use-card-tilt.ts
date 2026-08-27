'use client';

import { useCallback } from 'react';

/** Peak rotation at the card's edges. Small on purpose: the slab should read as
 *  a solid object turned in the hand, not as a page flipping over. */
const MAX_TILT_DEG = 9;
/** Per-frame approach to the pointer's target angle. Follows the cursor closely
 *  while still easing back to flat when the pointer leaves. */
const EASE = 0.18;

type Tilt = {
  /** degrees */ rx: number;
  /** degrees */ ry: number;
  /** % across the card */ gx: number;
  /** % down the card */ gy: number;
  /** 0..1 */ go: number;
};
const REST: Tilt = { rx: 0, ry: 0, gx: 50, gy: 50, go: 0 };

/**
 * Pointer-follow tilt + specular glare for the card in the reveal.
 *
 * Returns a CALLBACK REF: pass it as the element's `ref` and it wires its own
 * native pointer listeners, returning React 19's ref cleanup on detach. Two
 * reasons it works this way rather than handing back handler props — the React
 * Compiler lint rejects reading a ref object's fields during render, and native
 * listeners keep the pointer stream off React entirely. That matters here: the
 * reveal commits heavily (see SlotReelStack's `frozen`), and a re-render per
 * pointermove would land on the flip's frames. The element is driven through
 * CSS custom properties instead, so nothing re-renders at all.
 *
 * Nothing calls `setPointerCapture` — capture on this subtree swallows the tap
 * that flips the card.
 *
 * `enabled` is the caller's reduced-motion answer. Interaction-driven motion is
 * still motion (WCAG 2.3.3), so when the visitor asks for less of it the card
 * stays flat and the glare stays off.
 */
export function useCardTilt(enabled: boolean) {
  return useCallback(
    (el: HTMLElement | null) => {
      if (!el || !enabled) return;

      let target: Tilt = REST;
      let current: Tilt = REST;
      let raf: number | null = null;

      const tick = () => {
        let moving = false;
        const step = (from: number, to: number) => {
          const d = to - from;
          if (Math.abs(d) < 0.01) return to;
          moving = true;
          return from + d * EASE;
        };
        current = {
          rx: step(current.rx, target.rx),
          ry: step(current.ry, target.ry),
          gx: step(current.gx, target.gx),
          gy: step(current.gy, target.gy),
          go: step(current.go, target.go),
        };
        el.style.setProperty('--tilt-x', `${current.rx.toFixed(2)}deg`);
        el.style.setProperty('--tilt-y', `${current.ry.toFixed(2)}deg`);
        el.style.setProperty('--glare-x', `${current.gx.toFixed(1)}%`);
        el.style.setProperty('--glare-y', `${current.gy.toFixed(1)}%`);
        el.style.setProperty('--glare-o', current.go.toFixed(3));
        raf = moving ? requestAnimationFrame(tick) : null;
      };
      const start = () => {
        if (raf === null) raf = requestAnimationFrame(tick);
      };

      /** Bound to pointerdown as well as pointermove: a finger never hovers, so
       *  touch gets its first angle the moment it lands and then drags the card
       *  round. On a mouse this just means the card is already leaning when a
       *  press starts. */
      const onMove = (e: PointerEvent) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return;
        const px = (e.clientX - r.left) / r.width; // 0 (left) .. 1 (right)
        const py = (e.clientY - r.top) / r.height; // 0 (top) .. 1 (bottom)
        target = {
          rx: (0.5 - py) * 2 * MAX_TILT_DEG,
          ry: (px - 0.5) * 2 * MAX_TILT_DEG,
          gx: px * 100,
          gy: py * 100,
          go: 1,
        };
        start();
      };
      /** Ease back to flat. Bound to pointerup/cancel too, because a touch
       *  pointer never sends pointerleave — the highlight would otherwise stay
       *  frozen mid-card. */
      const rest = () => {
        target = { ...target, rx: 0, ry: 0, go: 0 };
        start();
      };

      el.addEventListener('pointerdown', onMove);
      el.addEventListener('pointermove', onMove);
      el.addEventListener('pointerleave', rest);
      el.addEventListener('pointerup', rest);
      el.addEventListener('pointercancel', rest);
      return () => {
        if (raf !== null) cancelAnimationFrame(raf);
        el.removeEventListener('pointerdown', onMove);
        el.removeEventListener('pointermove', onMove);
        el.removeEventListener('pointerleave', rest);
        el.removeEventListener('pointerup', rest);
        el.removeEventListener('pointercancel', rest);
        el.style.removeProperty('--tilt-x');
        el.style.removeProperty('--tilt-y');
        el.style.removeProperty('--glare-o');
      };
    },
    [enabled],
  );
}
