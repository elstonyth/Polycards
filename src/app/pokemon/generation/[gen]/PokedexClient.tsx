'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  type Pokemon,
  GENS,
  REGION,
  spriteGif,
  spritePng,
} from '@/lib/mock/pokedex';

const LANGS = ['US', 'JP', 'KR'];

function PokeSprite({ dex, name }: { dex: number; name: string }) {
  const [src, setSrc] = useState(spriteGif(dex));
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={name}
      loading="lazy"
      onError={() => setSrc((s) => (s === spritePng(dex) ? s : spritePng(dex)))}
      className="h-16 w-auto max-w-[80%] object-contain [image-rendering:auto]"
    />
  );
}

export default function PokedexClient({
  gen,
  pokemon,
}: {
  gen: string;
  pokemon: Pokemon[];
}) {
  const [query, setQuery] = useState('');
  const [lang, setLang] = useState('US');

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return pokemon;
    return pokemon.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        String(p.dex) === q ||
        `#${p.dex}` === q,
    );
  }, [pokemon, query]);

  return (
    <div className="mx-auto w-full px-fluid py-5">
      {/* Top bar: search + language (left), generation tabs (right) */}
      <div className="mb-5 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-2">
          <div className="relative w-full sm:w-64">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/40"
              aria-hidden
            />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search Pokémon..."
              className="h-10 w-full rounded-xl border border-white/10 bg-white/[0.03] pl-9 pr-3 text-sm text-white placeholder:text-white/40 focus:border-white/25 focus:outline-none"
            />
          </div>
          <div className="flex shrink-0 rounded-xl border border-white/10 bg-white/[0.03] p-0.5">
            {LANGS.map((l) => (
              <button
                key={l}
                type="button"
                onClick={() => setLang(l)}
                className={cn(
                  'rounded-lg px-2.5 py-1.5 text-[12px] font-semibold transition-colors',
                  lang === l
                    ? 'bg-white/10 text-white'
                    : 'text-white/45 hover:text-white/70',
                )}
              >
                {l}
              </button>
            ))}
          </div>
        </div>

        {/* Generation tabs — underline style, horizontally scrollable */}
        <div className="flex gap-0.5 overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {GENS.map((n) => (
            <Link
              key={n}
              href={`/pokemon/generation/${n}`}
              className={cn(
                '-mb-px shrink-0 border-b-2 px-3 py-2 text-[13px] font-medium transition-colors',
                n === gen
                  ? 'border-white text-white'
                  : 'border-transparent text-white/45 hover:text-white',
              )}
            >
              Gen {n}
            </Link>
          ))}
        </div>
      </div>

      {/* Pokédex grid */}
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-7">
        {visible.map((p) => (
          <li
            key={p.dex}
            className="group flex h-full flex-col items-center justify-center gap-1.5 rounded-2xl border border-white/10 bg-white/[0.03] p-4 transition-colors duration-300 hover:border-white/20 hover:bg-white/[0.06]"
          >
            <div className="flex h-20 items-end justify-center">
              <PokeSprite dex={p.dex} name={p.name} />
            </div>
            <span className="font-heading text-sm font-bold text-white">
              {p.name}
            </span>
            <span className="text-[11px] tabular-nums text-white/40">
              #{p.dex}
            </span>
          </li>
        ))}
      </ul>

      {visible.length === 0 && (
        <p className="py-16 text-center text-sm text-white/40">
          No Pokémon match “{query}”.
        </p>
      )}
      <p className="mt-6 text-center text-[11px] text-white/30">
        Sprites courtesy of PokeAPI · Generation {gen} ({REGION[gen]}) ·{' '}
        {pokemon.length} Pokémon
      </p>
    </div>
  );
}
