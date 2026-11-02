'use client';

import {
  useLayoutEffect,
  useState,
  type ElementType,
  type ReactNode,
} from 'react';
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
  'aria-labelledby'?: string;
};

/**
 * Wraps content in a fade-up + slide-in that fires ONCE when scrolled into view.
 * Respects prefers-reduced-motion (renders visible immediately, no transition).
 * Reusable across every section/page so entry animations stay consistent.
 *
 * Content already on screen at load rises in with CSS (.rise-in) and needs no
 * JS: hiding it until hydration pushed the page's largest paint seconds back on
 * a slow phone. Only what starts below the fold waits for the scroll.
 */
export default function Reveal({
  children,
  className,
  delay = 0,
  y = 24,
  as: Tag = 'div',
  'aria-labelledby': ariaLabelledBy,
}: RevealProps) {
  // ref typed loosely so it works whether Tag is div, section, etc.
  const [ref, shown] = useInView<HTMLElement>();
  const reduced = usePrefersReducedMotion();
  const [below, setBelow] = useState(false);
  useLayoutEffect(() => {
    const top = ref.current?.getBoundingClientRect().top ?? 0;
    // Below the fold, so hiding it before this paint is never seen.
    if (top > window.innerHeight) setBelow(true);
  }, [ref]);
  const hidden = below && !shown && !reduced;

  return (
    <Tag
      ref={ref}
      {...(ariaLabelledBy && { 'aria-labelledby': ariaLabelledBy })}
      className={cn(
        // opacity + transform already composite on the GPU, so no will-change:
        // it was leaking one live layer per revealed element across the page.
        below
          ? !reduced &&
              'transition-[opacity,transform] duration-700 ease-out motion-reduce:transition-none'
          : 'rise-in',
        hidden ? 'opacity-0' : 'translate-y-0 opacity-100',
        className,
      )}
      style={{
        transform: hidden ? `translateY(${y}px)` : undefined,
        transitionDelay: shown && !reduced ? `${delay}ms` : '0ms',
        animationDelay: `${delay}ms`,
      }}
    >
      {children}
    </Tag>
  );
}
