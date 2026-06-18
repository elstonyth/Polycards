// src/app/slots/[slug]/PaylineBeam.tsx
import { cn } from '@/lib/utils';

/** Center payline overlaying the reel. `pulse` flashes on win (PRD §3.4). */
export function PaylineBeam({
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
          'pointer-events-none absolute left-1/2 top-0 z-10 h-full w-1 -translate-x-1/2 rounded-full bg-gradient-to-b from-fuchsia-500 to-violet-500 shadow-[0_0_24px_2px_rgba(168,85,247,0.7)]',
          !reduced && pulse && 'animate-pulse',
        )}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-0 z-10 -translate-x-1/2 border-x-[7px] border-t-[9px] border-x-transparent border-t-violet-400"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute bottom-0 left-1/2 z-10 -translate-x-1/2 rotate-180 border-x-[7px] border-t-[9px] border-x-transparent border-t-violet-400"
      />
    </>
  );
}
