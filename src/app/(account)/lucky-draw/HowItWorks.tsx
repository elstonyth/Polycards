import Link from 'next/link';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { holoConic, rulesCopy } from '@/lib/lucky-draw';

/** Where a pool is in its life, which is where the player is in the steps. */
export type PoolStage = 'collect' | 'enter' | 'draw' | 'next';

const STEPS: { stage: PoolStage; title: string; body: string }[] = [
  {
    stage: 'collect',
    title: 'Collect tickets',
    body: 'Tasks and Polycards gifts pay them. They wait in your vault until you use them.',
  },
  {
    stage: 'enter',
    title: 'Put them in before the clock runs out',
    body: 'Every ticket is one chance at the whole pool. More tickets means a better chance, and one ticket can still win. You need at least one top-up to enter.',
  },
  {
    stage: 'draw',
    title: 'Clock hits zero, the arena opens',
    body: 'One ticket is drawn when the gate closes, and everyone watches it play out in about 20 seconds. Your share of the tickets is your share of the discs. Bigger discs eat smaller ones, and whoever holds the last one left takes every prize. Replay it any time in Results.',
  },
  {
    stage: 'next',
    title: 'Then the next pool',
    body: 'A pool can run for a day, a few days or a week, and each shows its own clock. Tickets you kept carry over. Tickets you put in are used, win or lose.',
  },
];

/** The rules as a line the pool is moving along, marked where it is now, then
 *  the small print for whoever wants it. */
export function HowItWorks({
  at,
  className,
}: {
  at: PoolStage;
  className?: string;
}) {
  return (
    <details className={cn('group', className)}>
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1 text-sm font-semibold text-neutral-300 [&::-webkit-details-marker]:hidden">
        How it works
        <ChevronDown
          className="h-4 w-4 transition-transform group-open:rotate-180 motion-reduce:transition-none"
          aria-hidden
        />
      </summary>
      <ol className="mt-2 lg:grid lg:grid-cols-4 lg:gap-6">
        {STEPS.map((s, i) => {
          const now = s.stage === at;
          return (
            <li
              key={s.stage}
              aria-current={now ? 'step' : undefined}
              className="relative flex gap-3 pb-5 last:pb-0 lg:block lg:pb-0"
            >
              {/* The line to the next step: down on a phone, across on a desktop. */}
              {i < STEPS.length - 1 && (
                <span
                  aria-hidden
                  className="absolute top-4 bottom-0 left-[7px] w-px bg-white/15 lg:top-[7px] lg:right-[-1.5rem] lg:bottom-auto lg:left-4 lg:h-px lg:w-auto"
                />
              )}
              <span
                aria-hidden
                className={cn(
                  'relative mt-0.5 block h-[15px] w-[15px] shrink-0 rounded-full lg:mt-0 lg:mb-3',
                  now ? 'holo-turn' : 'border border-white/25 bg-neutral-950',
                )}
                style={now ? { background: holoConic } : undefined}
              />
              <div className="min-w-0">
                <h3
                  className={cn(
                    'text-sm font-semibold',
                    now ? 'text-white' : 'text-neutral-300',
                  )}
                >
                  {s.title}
                  {now && (
                    <span className="ml-2 inline-block rounded-full bg-neutral-50 px-1.5 align-[1px] text-[10px] font-semibold text-neutral-950">
                      Now
                    </span>
                  )}
                </h3>
                <p className="mt-0.5 text-sm leading-relaxed text-neutral-400">
                  {s.body}
                </p>
                {s.stage === 'collect' && (
                  <Link
                    href="/task"
                    className="mt-1 inline-block text-sm font-semibold text-white underline underline-offset-4"
                  >
                    Go to tasks
                  </Link>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      <p className="mt-5 text-xs leading-relaxed text-neutral-400">
        {rulesCopy('one_winner')}
      </p>
    </details>
  );
}
