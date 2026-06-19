import { cn } from '@/lib/utils';

/**
 * Horizontal payline across the reel stack. `pulse` flashes on win (spec §3.4).
 * Positions its parts absolutely — render inside a `relative` container.
 */
export function PaylineRow({
  reduced,
  pulse = false,
}: {
  reduced: boolean;
  pulse?: boolean;
}) {
  return (
    <>
      <div
        aria-hidden
        className={cn(
          'pointer-events-none absolute left-0 right-0 top-1/2 z-10 h-1 -translate-y-1/2 rounded-full bg-gradient-to-r from-fuchsia-500 to-violet-500 shadow-[0_0_24px_2px_rgba(168,85,247,0.7)]',
          !reduced && pulse && 'animate-pulse',
        )}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute left-0 top-1/2 z-10 -translate-y-1/2 border-y-[7px] border-l-[9px] border-y-transparent border-l-violet-400"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute right-0 top-1/2 z-10 -translate-y-1/2 rotate-180 border-y-[7px] border-l-[9px] border-y-transparent border-l-violet-400"
      />
    </>
  );
}
