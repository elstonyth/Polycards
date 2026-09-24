// PokeAPI/sprites via jsDelivr's CDN — raw.githubusercontent.com rate-limits
// (429) and intermittently blocks (000) sprite requests; jsDelivr mirrors the
// same repo+ref with no rate limit. Keep in sync with src/lib/mock/pokedex.ts.
const SPRITE_BASE =
  'https://cdn.jsdelivr.net/gh/PokeAPI/sprites@master/sprites/pokemon';
export const spritePng = (dex: number) => `${SPRITE_BASE}/${dex}.png`;

// Static art but no Showdown GIF — every dex 1-1025 HEAD-checked on jsDelivr
// 2026-09-24. Same set as the storefront; the admin card-Pokémon picker shows
// these with no error fallback, so requesting the GIF left a broken image.
export const STATIC_ONLY_DEX: ReadonlySet<number> = new Set([
  990, 991, 992, 993, 994, 995, 1006, 1008, 1010, 1017, 1022, 1023, 1024, 1025,
]);
export const spriteGif = (dex: number) =>
  STATIC_ONLY_DEX.has(dex)
    ? spritePng(dex)
    : `${SPRITE_BASE}/other/showdown/${dex}.gif`;
