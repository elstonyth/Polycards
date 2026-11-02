// src/app/slots/[slug]/TicketReveal.tsx
'use client';

// The reveal on a ticket pack, in place of RevealStage. There is no card here:
// no slab to flip, no sell window, and no clock. The tickets are already in the
// customer's Lucky Draw balance, so nothing is waiting and the result stays up
// until they pick where to go. RevealStage's auto-conclude would clear it, since
// a batch with no offers reads as concluded at once.
import { useEffect, useRef } from 'react';
import Link from 'next/link';
import { motion } from 'motion/react';
import { TicketArt } from '@/components/TicketArt';
import { Pill, pillVariants } from '@/components/ui/pill';
import type { WonCard } from '@/lib/actions/packs';
import { ticketCount, ticketTotal } from '@/lib/packs-data';
import { isTopRarity } from '@/lib/rarity';
import { CARD_STAGGER_MS, type RevealPhase } from '@/lib/reveal-phase';
import { cn } from '@/lib/utils';

export function TicketReveal({
  phase,
  cards,
  reduced,
  demo,
  onSignUp,
  onSkip,
  onConclude,
  vibrate,
  playReveal,
}: {
  phase: RevealPhase;
  cards: WonCard[];
  reduced: boolean;
  /** Guest demo: nothing was won, so a sign-up instead of the Lucky Draw link. */
  demo: boolean;
  onSignUp?: () => void;
  onSkip: () => void;
  /** Back to the idle machine, where Spin is the only press that charges. */
  onConclude: () => void;
  vibrate: (p: number | number[]) => void;
  playReveal: (rarities: readonly string[]) => void;
}) {
  const shown = phase !== 'flood';

  // Once, as the ticket appears: the same rarity sound a card's flip plays. The
  // ref keeps it to one through Strict Mode's double effect.
  const played = useRef(false);
  useEffect(() => {
    if (!shown || played.current) return;
    played.current = true;
    playReveal(cards.map((c) => c.rarity));
    vibrate(cards.some((c) => isTopRarity(c.rarity)) ? [40, 40, 80] : 30);
  }, [shown, cards, playReveal, vibrate]);

  if (!shown) {
    return (
      <button
        type="button"
        aria-label="Skip to your tickets"
        onClick={onSkip}
        className="absolute inset-0 z-20 cursor-default"
      />
    );
  }

  const batch = cards.length > 1;
  return (
    <div className="relative z-10 m-auto flex w-full flex-col items-center gap-5 sm:gap-6">
      <div className="flex w-full items-start justify-center gap-3">
        {cards.map((card, i) => (
          <motion.div
            key={i}
            initial={reduced ? false : { opacity: 0, y: 16, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{
              duration: 0.6,
              ease: [0.16, 1, 0.3, 1],
              delay: (i * CARD_STAGGER_MS) / 1000,
            }}
            className={cn(
              'flex min-w-0 flex-col items-center gap-2',
              batch ? 'max-w-[220px] flex-1' : 'w-[min(72vw,320px)]',
            )}
          >
            <TicketArt
              width={batch ? 220 : 320}
              eager
              className="h-auto w-full"
            />
            <p
              className={cn(
                'text-center font-heading font-bold leading-tight tracking-tight tabular-nums text-white',
                batch ? 'text-base sm:text-xl' : 'text-3xl sm:text-4xl',
              )}
            >
              {ticketCount(card.tickets ?? 0)}
            </p>
          </motion.div>
        ))}
      </div>
      {batch && (
        <p className="text-sm font-semibold tabular-nums text-white/70">
          {ticketCount(ticketTotal(cards))} in total
        </p>
      )}
      <div className="flex w-full max-w-[300px] flex-col gap-2">
        {demo ? (
          <>
            <Pill
              variant="primary"
              size="lg"
              onClick={onSignUp}
              className="w-full"
            >
              Sign up &amp; spin for real
            </Pill>
            <Pill
              variant="ghost"
              size="md"
              onClick={onConclude}
              className="w-full"
            >
              Back to the reel
            </Pill>
          </>
        ) : (
          <>
            <Link
              href="/lucky-draw"
              className={cn(
                pillVariants({ variant: 'primary', size: 'lg' }),
                'w-full',
              )}
            >
              Go to Lucky Draw
            </Link>
            <Pill
              variant="ghost"
              size="md"
              onClick={onConclude}
              className="w-full"
            >
              Spin again
            </Pill>
          </>
        )}
      </div>
    </div>
  );
}
