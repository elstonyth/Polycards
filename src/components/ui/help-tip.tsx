'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Info } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * A tap-to-open explainer next to a label.
 *
 * Not `title=""`: that never fires on touch, and this storefront is
 * mobile-first. Not a library popover either — `@base-ui/react` was removed
 * 2026-07-13 and `@medusajs/ui`'s Tooltip is admin-side, so this is the
 * Tailwind-only version: a button, an `aria-describedby` panel, and a
 * click-outside/Escape close.
 */
export function HelpTip({
  label,
  children,
  className,
}: {
  /** Screen-reader name — "what does Current rate mean?" */
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <span ref={ref} className={cn('relative inline-flex', className)}>
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        onClick={() => setOpen((v) => !v)}
        className="rounded-full p-0.5 text-neutral-500 transition-colors hover:text-white"
      >
        <Info className="h-3.5 w-3.5" aria-hidden />
      </button>
      {open && (
        <span
          id={id}
          role="note"
          // Anchored to the trigger's left edge and clamped by the viewport
          // width so a tip near the right gutter can't push the page wide.
          className="absolute top-full left-0 z-20 mt-1.5 w-[min(17rem,calc(100vw-2rem))] rounded-xl border border-white/10 bg-neutral-900 p-3 text-xs leading-relaxed text-neutral-300 normal-case shadow-xl"
        >
          {children}
        </span>
      )}
    </span>
  );
}
