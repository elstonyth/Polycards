import { cn } from '@/lib/utils';

// DESIGN.md Chips: graphite pill, silver label; selected = Paper White on Ink.
// 44px tall, so a phone thumb never misses one. Shared by the pack page's
// picker and the /slots catalog, so a filter chip is one thing everywhere.
const CHIP =
  'flex min-h-11 shrink-0 items-center gap-1.5 rounded-full px-4 text-[13px] font-semibold outline-none transition-[background-color,color,transform] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-white/40 motion-reduce:transition-[background-color,color] motion-reduce:active:scale-100';

/** Classes for a filter chip `<button aria-pressed>`. */
export const chipVariants = (on: boolean): string =>
  cn(
    CHIP,
    on
      ? 'bg-neutral-50 text-neutral-950'
      : 'bg-neutral-800 text-neutral-400 hover:bg-neutral-700 hover:text-white',
  );
