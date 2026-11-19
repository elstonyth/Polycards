import type { ReactNode } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { cn } from '@/lib/utils';

// The "soft" look's building blocks (DESIGN.md, Soft catalog / Soft pack page):
// nested double-bezel surfaces, an eyebrow pill, a nested arrow disc, and one
// spring curve. Only the pack catalog and the pack page wear it.

/** The one motion curve: mass and a soft landing, never linear or ease-in-out. */
export const SPRING = 'ease-[cubic-bezier(0.32,0.72,0,1)]';

/** The small uppercase pill that names what follows. 12px, not the guide's
 *  10px: the house floor for readable text wins over a decorative size. */
export const EYEBROW =
  'inline-flex items-center gap-2 rounded-full bg-white/[0.06] px-3 py-1 text-xs font-medium uppercase tracking-[0.18em] text-neutral-300 ring-1 ring-white/10';

/** A section's name at the soft look's scale: Nekst, fluid, tight. */
export const SOFT_H2 =
  'font-heading text-[clamp(1.5rem,3.2vw,2.5rem)] font-bold leading-[1.05] tracking-[-0.02em] text-white';

/** A section's opening: an eyebrow pill that states a fact about it, then its
 *  name. The `<h2>` holds the name alone, so a test can match it exactly. */
export function SectionHead({
  eyebrow,
  title,
  className,
}: {
  eyebrow?: ReactNode;
  title: string;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-start gap-3', className)}>
      {eyebrow != null && <span className={EYEBROW}>{eyebrow}</span>}
      <h2 className={SOFT_H2}>{title}</h2>
    </div>
  );
}

/**
 * The double bezel: an outer tray (faint fill, hairline ring) holding an inner
 * plate with its own surface and top highlight. The plate's radius is the
 * tray's minus the tray's padding, so the two curves stay concentric. Opaque
 * on purpose: blur on scrolling content repaints every frame on a phone.
 */
export function Bezel({
  size = 'lg',
  className,
  core,
  children,
}: {
  size?: 'lg' | 'md';
  /** Classes for the tray. */
  className?: string;
  /** Classes for the plate. */
  core?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        'bg-white/[0.04] ring-1 ring-white/10',
        size === 'lg' ? 'rounded-[2rem] p-1.5' : 'rounded-[1.5rem] p-1',
        className,
      )}
    >
      <div
        className={cn(
          'relative h-full overflow-hidden bg-neutral-950 shadow-[inset_0_1px_1px_rgba(255,255,255,0.12)]',
          size === 'lg'
            ? 'rounded-[calc(2rem-0.375rem)]'
            : 'rounded-[calc(1.5rem-0.25rem)]',
          core,
        )}
      >
        {children}
      </div>
    </div>
  );
}

/** The arrow of a button, in its own disc flush with the pill's inner edge. */
export function ArrowDisc({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-neutral-950/10 transition-transform duration-500',
        SPRING,
        'motion-reduce:transition-none',
        className,
      )}
    >
      <ArrowUpRight className="h-4 w-4" strokeWidth={1.5} />
    </span>
  );
}
