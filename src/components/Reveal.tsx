'use client';

import { type ElementType, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { useInView, usePrefersReducedMotion } from '@/lib/use-reveal';

type RevealProps = {
  children: ReactNode;
  className?: string;
  /** stagger delay in ms (applied only while animating in) */
  delay?: number;
  /** distance to travel up, in px (default 24) */
  y?: number;
  /** element to render (default div). e.g. "section" */
  as?: ElementType;
};

/**
 * Wraps content in a fade-up + slide-in that fires ONCE when scrolled into view.
 * Respects prefers-reduced-motion (renders visible immediately, no transition).
 * Reusable across every section/page so entry animations stay consistent.
 */
export default function Reveal({
  children,
  className,
  delay = 0,
  y = 24,
  as: Tag = 'div',
}: RevealProps) {
  // ref typed loosely so it works whether Tag is div, section, etc.
  const [ref, shown] = useInView<HTMLElement>();
  const reduced = usePrefersReducedMotion();
  const visible = shown || reduced;

  return (
    <Tag
      ref={ref}
      className={cn(
        !reduced &&
          'transition-all duration-700 ease-out will-change-[opacity,transform] motion-reduce:transition-none',
        visible ? 'translate-y-0 opacity-100' : 'opacity-0',
        className,
      )}
      style={{
        transform: visible ? undefined : `translateY(${y}px)`,
        transitionDelay: shown && !reduced ? `${delay}ms` : '0ms',
      }}
    >
      {children}
    </Tag>
  );
}
