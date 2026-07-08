// Pure, testable pieces of the encyclopedia seed (Spec 2 §2). The I/O wiring
// (fetch → upload → upsert) lives in seed-pixel-pokemon.ts and is verified by a
// manual run + psql count.
export type PokeApiSprites = {
  front_default: string | null;
  other?: { showdown?: { front_default: string | null } };
};
export type PokeApiPokemon = {
  sprites: PokeApiSprites;
  types: { type: { name: string } }[];
};

/** Per-dex fallback chain: animated showdown gif → static png → null (→ image_url
 *  null → the storefront renders its poké-ball fallback). */
export function chooseSpriteUrl(p: PokeApiPokemon): string | null {
  return (
    p.sprites?.other?.showdown?.front_default ??
    p.sprites?.front_default ??
    null
  );
}

/** Pokémon type names, Capitalized (e.g. ["Fire","Flying"]) for the admin filter. */
export function extractTypes(p: PokeApiPokemon): string[] {
  return (p.types ?? []).map((t) => {
    const n = t.type.name;
    return n.charAt(0).toUpperCase() + n.slice(1);
  });
}

/** Uploaded-file extension inferred from the source sprite url (gif vs png). */
export function spriteExt(url: string): 'gif' | 'png' {
  return url.toLowerCase().endsWith('.gif') ? 'gif' : 'png';
}
