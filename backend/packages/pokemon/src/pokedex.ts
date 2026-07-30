// PokeAPI/sprites via jsDelivr's CDN — raw.githubusercontent.com rate-limits
// (429) and intermittently blocks (000) sprite requests; jsDelivr mirrors the
// same repo+ref with no rate limit. Keep in sync with src/lib/mock/pokedex.ts.
const SPRITE_BASE =
  'https://cdn.jsdelivr.net/gh/PokeAPI/sprites@master/sprites/pokemon';
export const spriteGif = (dex: number) =>
  `${SPRITE_BASE}/other/showdown/${dex}.gif`;
export const spritePng = (dex: number) => `${SPRITE_BASE}/${dex}.png`;
