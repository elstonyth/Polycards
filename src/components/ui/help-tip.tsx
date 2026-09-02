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
  // `pos` is measured on open, not derived in CSS: a trigger that sits at the
  // right edge of a panel would push an `absolute; left: 0` tip off-screen,
  // and there is no pure-CSS way to clamp it to the viewport (anchor
  // positioning is not universally supported yet). Fixed + measured also
  // means the tip never inherits an ancestor's `overflow: hidden`.
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const open = pos !== null;
  const id = useId();
  const ref = useRef<HTMLSpanElement>(null);

  const GUTTER = 16;
  const WIDTH = 272; // 17rem

  const toggle = () => {
    if (open) return setPos(null);
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const width = Math.min(WIDTH, window.innerWidth - GUTTER * 2);
    setPos({
      top: r.bottom + 6,
      left: Math.min(
        Math.max(GUTTER, r.left),
        window.innerWidth - GUTTER - width,
      ),
    });
  };

  // A scroll or resize would leave the measured tip floating away from its
  // trigger; closing is both simpler and what a tap outside would do anyway.
  useEffect(() => {
    if (!open) return;
    const close = () => setPos(null);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setPos(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPos(null);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <span ref={ref} className={cn('inline-flex', className)}>
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        onClick={toggle}
        className="-m-3 rounded-full p-3.5 text-neutral-500 transition-colors hover:text-white"
      >
        <Info className="h-3.5 w-3.5" aria-hidden />
      </button>
      {pos && (
        <span
          id={id}
          role="note"
          style={{ top: pos.top, left: pos.left }}
          className="fixed z-50 w-[min(17rem,calc(100vw-2rem))] rounded-xl border border-white/10 bg-neutral-900 p-3 text-xs leading-relaxed font-normal tracking-normal text-neutral-300 normal-case shadow-xl"
        >
          {children}
        </span>
      )}
    </span>
  );
}
