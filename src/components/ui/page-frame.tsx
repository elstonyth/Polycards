import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

// The frame every main tab shares (tab-flow plan, 2026-11-19), so moving
// between Task, Ranks, Draw, Vault and Me keeps the column, the title and the
// way the page arrives. Server-safe: no hooks, usable from server pages,
// client components and loading.tsx fallbacks alike.

/** The one content column: the `(account)` layout's, which Vault, Draw and Me
 *  already sit in. Pages outside that layout (Task, Ranks) put it on their own
 *  wrapper with `pt-6`, the layout's top spacing. */
export const PAGE_COLUMN = 'mx-auto w-full max-w-2xl px-fluid lg:max-w-4xl';

/** For a page whose loading.tsx and loaded content can differ in height (Task:
 *  a visitor's page is short, its skeleton is not). A cold load streams the
 *  skeleton first, and a footer that then jumps up into view counted as a
 *  0.048 layout shift (measured 2026-11-20). Holding the column to the screen
 *  below the 69px header keeps the footer under the fold in both states. */
export const PAGE_FILL = 'min-h-[calc(100svh-69px)]';

/** The page title: Draw's no-wrap clamp (equal to text-3xl from 375px up),
 *  uppercase Nekst. `leading-none` so the title box is exactly the type size
 *  and a skeleton can put the same text in the same place. */
export const PAGE_TITLE =
  'font-heading text-[clamp(1.35rem,8vw,1.875rem)] leading-none text-white uppercase';

export function PageTitle({
  as: Tag = 'h1',
  children,
  className,
}: {
  /** `p` where another element already owns the page's h1 (Me), or in a
   *  loading fallback. */
  as?: 'h1' | 'h2' | 'p';
  children: ReactNode;
  className?: string;
}) {
  return <Tag className={cn(PAGE_TITLE, className)}>{children}</Tag>;
}

// Opacity only, NEVER a transform: a transform on this wrapper would move the
// position:fixed elements inside it (the Ranks your-rank card, sheets, account
// modals) for the length of the animation. `backwards` holds the 0% frame and
// leaves nothing pinned once it ends. Reuses globals.css @keyframes fadeIn.
const PAGE_ENTER =
  'motion-safe:animate-[fadeIn_180ms_var(--ease-out-quart)_backwards]';

/** Everything below a tab's title: it fades in when the page arrives, the
 *  title does not. A plain block on purpose (no flex, padding or overflow of
 *  its own unless the caller adds it): margins inside still collapse through
 *  it exactly as they did before it was there. */
export function PageBody({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cn(PAGE_ENTER, className)}>{children}</div>;
}

/** Hidden for the first 150ms, then a 200ms fade: a navigation that lands
 *  fast never flashes skeleton blocks. Reduced motion: the globals.css
 *  backstop zeroes the delay and the duration, so the blocks show at once.
 *  For an element that cannot be a div (inside a flex row or a <p>), put the
 *  class on it directly. Never on the pulsing element itself: both are
 *  `animation`, and one would replace the other. */
export const SKELETON_REVEAL =
  'animate-[fadeIn_200ms_ease-out_150ms_backwards]';

export function SkeletonReveal({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cn(SKELETON_REVEAL, className)}>{children}</div>;
}

/** Skeleton block classes (from the account fallback): `pulse` goes on the
 *  wrapper of the bones, inside a SkeletonReveal. */
export const BONE = {
  pulse: 'animate-pulse motion-reduce:animate-none',
  /** A heading-weight bar. */
  bar: 'rounded-lg bg-white/10',
  /** A line of body text. */
  line: 'rounded bg-white/5',
  /** A card or panel. */
  panel: 'rounded-2xl border border-white/10 bg-white/[0.03]',
  /** A segmented pill track, in the real track's colours. */
  track: 'rounded-full border border-white/10 bg-neutral-900',
} as const;
