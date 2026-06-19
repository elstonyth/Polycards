import { pokemonFromCard, type CardPokemon } from '@acme/pokemon';
import type { EditRow } from './odds-rows';

// One Pokémon cluster of editor rows. `pokemon: null` is the shared "Other"
// bucket (cards whose name resolves to no dex entry). `key` is a stable React
// key — the dex number as a string, or 'other'.
export type PokemonGroup = {
  pokemon: CardPokemon | null;
  key: string;
  rows: EditRow[];
};

// Cluster editor rows by the Pokémon derived from each card's (immutable) name.
// Groups are ordered by dex ascending; the "Other" bucket is always last.
// Row order within a group is preserved (the server already sorts by value
// desc). Pure + display-only — never feeds the save path.
export function groupRowsByPokemon(rows: EditRow[]): PokemonGroup[] {
  const byDex = new Map<number, { pokemon: CardPokemon; rows: EditRow[] }>();
  const other: EditRow[] = [];

  for (const row of rows) {
    const pokemon = pokemonFromCard(row.name);
    if (!pokemon) {
      other.push(row);
      continue;
    }
    const existing = byDex.get(pokemon.dex);
    if (existing) existing.rows.push(row);
    else byDex.set(pokemon.dex, { pokemon, rows: [row] });
  }

  const groups: PokemonGroup[] = [...byDex.values()]
    .sort((a, b) => a.pokemon.dex - b.pokemon.dex)
    .map((g) => ({ pokemon: g.pokemon, key: String(g.pokemon.dex), rows: g.rows }));

  if (other.length > 0) groups.push({ pokemon: null, key: 'other', rows: other });
  return groups;
}
