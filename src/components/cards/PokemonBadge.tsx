'use client';

import { useCallback, useState } from 'react';
import {
  slabArtInset,
  slabGlowRgb,
  type FrameVariant,
} from '@/components/SlabImage';
import { badgeSprite, type BadgeCard } from '@/lib/pokemon-badge-sprite';
import { usePrefersReducedMotion } from '@/lib/use-reveal';
import { cn } from '@/lib/utils';
import type { Rarity } from '@/lib/packs-data';

/**
 * The card's pixel-Pokémon, pinned to the bottom-right of its slab.
 *
 * It is the KEY between the slot reel — which flickers pixel sprites, never
 * card art — and the pack's card list: a player who sees a Charizard land on
 * the reel can find which card that sprite stood for. Same resolution rule as
 * the reel (see badgeSprite), so the two surfaces show the same Pokémon.
 *
 * MOTION: the animated showdown gif the reel uses, swapped for the static png
 * under prefers-reduced-motion. A gif is reachable by NEITHER tier of this
 * repo's reduced-motion policy — globals.css can't slow its frame timing and
 * CSS can't pause it — so the source swap is the only lever, and without it
 * this would be the first surface in the codebase to reintroduce motion a
 * reduced-motion visitor cannot escape (WCAG 2.2.2 also bites: auto-starting,
 * looping past 5s, no pause control). The custom-upload path stays ungated —
 * an operator gif has no static counterpart.
 * ponytail: measured 0.7–1.5 MB of gif per pack-page view (8–18 rail tiles ×
 * ~86 KB, and Chrome's lazy threshold covers the whole rail so nothing defers).
 * The png is ~1.4 KB. If that bill comes due, pass `still` from CardTile and
 * keep the gif for the detail hero, where the badge is ~64px rather than ~21px.
 *
 * Renders nothing for a card with no resolvable Pokémon (trainer/energy). The
 * reel's poké-ball placeholder is deliberately not reused: it exists only
 * because a reel cell can't be empty.
 */
export function PokemonBadge({
  card,
  rarity = null,
  frameVariant,
  slabSrc = null,
  className,
}: {
  card: BadgeCard;
  rarity?: Rarity | null;
  /** Cosmetic frame the slab is WEARING — a prism prize is white, not its tier. */
  frameVariant?: FrameVariant;
  /** The card's baked composite; null = raw. Decides the art box to anchor to. */
  slabSrc?: string | null;
  className?: string;
}) {
  const still = usePrefersReducedMotion();
  const { name, chain } = badgeSprite(card, still);

  // Walk the chain on load failure. Reset when the CARD changes: the overlay
  // switches card→card without remounting, so a step left over from a broken
  // sprite would blank the next card's badge. Adjusted during render (the
  // React "state derived from props" pattern CardDetail's price tick uses) —
  // an effect here would paint one frame of the wrong sprite.
  const [step, setStep] = useState(0);
  const [seenFor, setSeenFor] = useState(chain[0]);
  if (seenFor !== chain[0]) {
    setSeenFor(chain[0]);
    setStep(0);
  }
  const advance = useCallback(() => setStep((s) => s + 1), []);
  // onError alone loses every SSR failure: React attaches the listener at
  // hydration, and an image in the server HTML 404s while the page is still
  // parsing — the event fires into nothing and the chain never walks. Both
  // call sites render server-side (the pack pool arrives as a prop, and
  // /card/<handle> is a server page), so that was most of the failures. This
  // catches an <img> that is already finished-and-empty when the node attaches.
  const catchUpOnBroken = useCallback(
    (el: HTMLImageElement | null) => {
      if (el?.complete && el.naturalWidth === 0) advance();
    },
    [advance],
  );

  const src = chain[step];
  if (!src) return null;

  // Ask the slab what colour it is WEARING rather than re-deriving it: a prism
  // challenge prize wears white, so rarityRgb here would ring a white slab in
  // its pack tier — the disagreement CardDetail's own glow was fixed to close.
  const rgb =
    rarity || frameVariant ? slabGlowRgb(rarity, frameVariant) : '255,255,255';
  return (
    <span
      className="pointer-events-none absolute"
      style={{ inset: slabArtInset(slabSrc, rarity, frameVariant) }}
    >
      <span
        className={cn(
          'absolute bottom-[1.5%] right-[2.5%] grid aspect-square w-[24%] place-items-center rounded-full',
          className,
        )}
        style={{
          background:
            'radial-gradient(circle at 50% 35%, rgba(23,23,23,0.94), rgba(10,10,10,0.86))',
          boxShadow: `0 0 0 1px rgba(${rgb},0.5), 0 0 10px rgba(${rgb},0.35), 0 2px 6px rgba(0,0,0,0.5)`,
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- jsDelivr sprite
            or an operator-entered host; neither is a next/image remotePattern,
            and the fallback chain needs the raw onError. */}
        <img
          key={src}
          ref={catchUpOnBroken}
          // Stable hook for the QA gate, like SlabImage's data-slab. Matching
          // the badge by URL does not work: an admin-configured sprite is an
          // arbitrary Spaces object, so a `src*="sprites"` probe counts only
          // the cards that DON'T have one — the reverse of what it should
          // check, and it read 0 badges on a page rendering eight.
          data-poke-badge=""
          src={src}
          alt={name ?? ''}
          loading="lazy"
          decoding="async"
          onError={advance}
          /* No image-rendering:pixelated — the reel UPSCALES these sprites,
             this badge minifies them (~21px on a mobile rail tile), where
             nearest-neighbour drops whole rows and jags the sprite instead.
             The light halo (not a dark drop-shadow) keeps a dark-bodied
             sprite — Gengar, Umbreon — off the near-black disc behind it. */
          className="h-[76%] w-[76%] object-contain drop-shadow-[0_0_1px_rgba(255,255,255,0.55)]"
        />
      </span>
    </span>
  );
}
