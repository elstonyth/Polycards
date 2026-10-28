'use client';

import { useEffect, useState } from 'react';
import { TicketArt } from '@/components/TicketArt';
import { cn } from '@/lib/utils';

// The ticket art (spec §11 slot 2) grows in and fades out. Plays once when
// the vault row's Open brings the player here (?open=1); the caller skips it
// under reduced motion.
const IN_MS = 40;
const OUT_MS = 1100;
const DONE_MS = 1500;

export function TicketOpenIntro({ onDone }: { onDone: () => void }) {
  const [phase, setPhase] = useState<'start' | 'in' | 'out'>('start');

  useEffect(() => {
    const timers = [
      window.setTimeout(() => setPhase('in'), IN_MS),
      window.setTimeout(() => setPhase('out'), OUT_MS),
      window.setTimeout(onDone, DONE_MS),
    ];
    return () => timers.forEach((id) => window.clearTimeout(id));
  }, [onDone]);

  return (
    <div
      aria-hidden
      className={cn(
        'glass-scrim pointer-events-none fixed inset-0 z-[60] flex items-center justify-center transition-opacity duration-400',
        phase === 'out' ? 'opacity-0' : 'opacity-100',
      )}
    >
      <div
        className={cn(
          'flex flex-col items-center gap-3 transition-[opacity,scale] duration-700 ease-[cubic-bezier(.2,.8,.2,1)]',
          phase === 'start' && 'scale-60 opacity-0',
          phase === 'in' && 'scale-100 opacity-100',
          phase === 'out' && 'scale-110 opacity-0',
        )}
      >
        <TicketArt width={240} eager />
        <p className="font-heading text-2xl text-white">LUCKY DRAW</p>
      </div>
    </div>
  );
}
