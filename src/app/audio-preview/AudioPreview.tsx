'use client';

import Link from 'next/link';
import { Pill } from '@/components/ui/pill';
import { useSound } from '@/lib/use-sound';
import { RARITY_ORDER } from '@/lib/rarity';

const CUES = {
  Common: 'A small, warm confirmation · 3 seconds',
  Uncommon: 'A gentle melodic reward · 4 seconds',
  Rare: 'A cheerful discovery · 6 seconds',
  Mythical: 'A sparkling magical reveal · 8 seconds',
  Legendary: 'A heroic fanfare · 10 seconds',
  Immortal: 'The fullest celebration · 12 seconds',
};

export function AudioPreview() {
  const { muted, toggleMuted, playReveal, sfx, play } = useSound();
  return (
    <section className="px-fluid mx-auto max-w-2xl py-10">
      <p className="mb-3 text-sm text-neutral-400">Local audio preview</p>
      <h1 className="font-heading text-3xl text-neutral-50">
        Hear every reveal.
      </h1>
      <p className="mt-4 max-w-lg text-neutral-400">
        Playful Adventure plays in the background. Tap anywhere to start if your
        browser paused it. Each reveal plays its full ending; let it finish
        before trying the next rarity.
      </p>
      <div className="my-6 flex flex-wrap gap-3">
        <Pill variant="secondary" onClick={toggleMuted}>
          {muted ? 'Enable audio' : 'Mute audio'}
        </Pill>
        <Pill variant="ghost" onClick={() => sfx('reelTick')} disabled={muted}>
          Reel tick
        </Pill>
        <Pill variant="ghost" onClick={() => play('stop')} disabled={muted}>
          Reel stop
        </Pill>
      </div>
      <div className="divide-y divide-white/10 border-y border-white/10">
        {[...RARITY_ORDER].reverse().map((rarity) => (
          <div
            key={rarity}
            className="flex flex-wrap items-center justify-between gap-4 py-5"
          >
            <div>
              <h2 className="font-semibold text-neutral-50">{rarity}</h2>
              <p className="mt-1 text-sm text-neutral-400">{CUES[rarity]}</p>
            </div>
            <Pill
              variant="secondary"
              disabled={muted}
              onClick={() => playReveal([rarity])}
            >
              Reveal {rarity}
            </Pill>
          </div>
        ))}
      </div>
      <p className="mt-6 text-sm text-neutral-400">
        These buttons only play sound.{' '}
        <Link
          className="text-neutral-50 underline underline-offset-4"
          href="/slots"
        >
          Browse packs
        </Link>{' '}
        to try a guest demo.
      </p>
    </section>
  );
}
