'use client';

import { useEffect, useRef } from 'react';
import { useLiquidGlass, GLASS_ACCENT } from '@/lib/use-liquid-glass';

// One source of truth for the dismiss timer AND the progress bar's
// animation-duration (the inline style below overrides the class fallback).
const TOAST_MS = 4000;

// Transient top-of-screen confirmation (e.g. "Shipping order created
// successfully!"). Slides in under the header, auto-dismisses after
// TOAST_MS, and the shrinking green bar shows the time remaining.
// Distinct from the vault's inline `notice`, which persists in the page flow.
//
// Render it UNCONDITIONALLY with message=null when idle: the role="status"
// live region must already be in the DOM before the message lands (sr-only
// while idle), or screen readers may not announce it — a region inserted
// together with its content is skipped by some SR/browser combos. Same
// pattern as SlotMachineClient's persistent announcer.
export function SuccessToast({
  message,
  onClose,
}: {
  message: string | null;
  onClose: () => void;
}) {
  // Latest-ref so an unstable onClose (an inline arrow in the parent) can't
  // restart the dismiss timer on re-render — the CSS progress bar wouldn't
  // restart with it, and the two would desync.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => onCloseRef.current(), TOAST_MS);
    return () => clearTimeout(t);
  }, [message]);

  // Liquid-glass rim while visible (the sr-only idle element has no box to
  // map); frosted fallback on Safari/Firefox. Truthiness gate matches the
  // className gate below so '' can't refract a sr-only box.
  const toastRef = useRef<HTMLDivElement>(null);
  useLiquidGlass(toastRef, !!message, GLASS_ACCENT);

  return (
    <div
      ref={toastRef}
      role="status"
      className={
        message
          ? 'glass-panel fixed inset-x-4 top-[4.25rem] z-[70] mx-auto flex max-w-md items-center gap-3 overflow-hidden rounded-2xl border px-4 py-3 motion-safe:animate-[toastIn_0.25s_ease-out]'
          : 'sr-only'
      }
    >
      {message && (
        <>
          <svg
            viewBox="0 0 20 20"
            fill="currentColor"
            aria-hidden="true"
            className="h-5 w-5 shrink-0 text-buyback-fg"
          >
            <path
              fillRule="evenodd"
              d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16zm3.7-9.3a1 1 0 0 0-1.4-1.4L9 10.6 7.7 9.3a1 1 0 0 0-1.4 1.4l2 2a1 1 0 0 0 1.4 0l4-4z"
              clipRule="evenodd"
            />
          </svg>
          <p className="flex-1 text-[13px] font-semibold text-white">
            {message}
          </p>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={onClose}
            className="shrink-0 rounded p-0.5 text-white/50 hover:text-white focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:outline-none"
          >
            <svg
              viewBox="0 0 20 20"
              fill="currentColor"
              aria-hidden="true"
              className="h-4 w-4"
            >
              <path d="M6.3 5 10 8.6 13.7 5 15 6.3 11.4 10l3.6 3.7-1.3 1.3-3.7-3.6L6.3 15 5 13.7 8.6 10 5 6.3 6.3 5z" />
            </svg>
          </button>
          <span
            aria-hidden="true"
            className="absolute inset-x-0 bottom-0 h-0.5 origin-left bg-buyback-fg motion-safe:animate-[toastBar_4s_linear_forwards]"
            style={{ animationDuration: `${TOAST_MS}ms` }}
          />
        </>
      )}
    </div>
  );
}
