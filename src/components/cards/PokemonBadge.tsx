'use client';

import { useState } from 'react';
import { resolveCardPokemon } from '@/lib/resolve-card-pokemon';
import { spriteGif, spritePng } from '@/lib/mock/pokedex';
import { rarityRgb } from '@/lib/rarity';
import { cn } from '@/lib/utils';
import type { Rarity } from '@/lib/packs-data';

/**
 * The card's pixel-Pokémon, pinned to the bottom-right of its slab.
 *
 * It is the KEY between the slot reel — which flickers pixel sprites, never
 * card art — and the pack's card list: a player who sees a Charizard land on
 * the reel can find which card that sprite stood for. Same resolution rule as
 * the reel (resolveCardPokemon: configured sprite ⇢ configured dex ⇢ name
 * derivation), so the two surfaces can never disagree.
 *
 * The SAME animated showdown gif the reel flickers (operator, 2026-09-04) — a
 * badge that moves like the reel cell reads as the same object; a static one
 * reads as a different asset. The cost is real and accepted: the Top Hits
 * dialog decodes ~80 looping gifs at once. If that ever bites, gate the gif to
 * the rail + detail hero and let the dialog grid fall to spritePng.
 *
 * Sprite chain: custom upload ⇢ showdown gif ⇢ static png ⇢ nothing. The png
 * step matters — a dex whose showdown gif 404s would otherwise LOSE its badge,
 * which is the one thing this component exists to provide. The reel's poké-ball
 * placeholder is deliberately not reused: it exists only because a reel cell
 * can't be empty, and a card with no Pokémon (trainer/energy) simply has no key.
 *
 * Sizes in % of the slab box so one component serves a 150px rail tile and the
 * 420px detail hero.
 */
export function PokemonBadge({
  card,
  rarity = null,
  className,
}: {
  card: { name: string; pokemonDex?: number | null; spriteImage?: string | null };
  rarity?: Rarity | null;
  className?: string;
}) {
  // resolveCardPokemon takes snake_case; PackCard carries camelCase. Both
  // fields are optional there, so an unmapped call would compile clean and
  // silently drop the admin's configured pixel-Pokémon.
  const { dex, name } = resolveCardPokemon({
    name: card.name,
    pokemon_dex: card.pokemonDex,
    sprite_image: card.spriteImage,
  });
  const custom = card.spriteImage?.trim() ? card.spriteImage : null;
  const chain = custom
    ? [custom]
    : dex !== null
      ? [spriteGif(dex), spritePng(dex)]
      : [];

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
  const src = chain[step];
  if (!src) return null;

  const rgb = rarity ? rarityRgb(rarity) : '255,255,255';
  return (
    <span
      aria-hidden
      title={name ?? undefined}
      className={cn(
        'pointer-events-none absolute bottom-[1.5%] right-[2.5%] grid aspect-square w-[24%] place-items-center rounded-full',
        className,
      )}
      style={{
        background:
          'radial-gradient(circle at 50% 35%, rgba(23,23,27,0.94), rgba(8,8,10,0.86))',
        boxShadow: `0 0 0 1px rgba(${rgb},0.5), 0 0 10px rgba(${rgb},0.35), 0 2px 6px rgba(0,0,0,0.5)`,
      }}
    >
      <img
        src={src}
        alt=""
        loading="lazy"
        decoding="async"
        onError={() => setStep((s) => s + 1)}
        className="h-[76%] w-[76%] object-contain [image-rendering:pixelated] drop-shadow-[0_1px_2px_rgba(0,0,0,0.65)]"
      />
    </span>
  );
}
