// PokeAPI/sprites served via jsDelivr's CDN. raw.githubusercontent.com
// rate-limits (429) and intermittently blocks (000) sprite requests, which broke
// reel cells into broken-image icons; jsDelivr mirrors the SAME repo+ref with no
// rate limit and proper CDN caching. Animated "showdown" gif (matches the live
// site); static png is the fallback.
const SPRITE_BASE =
  'https://cdn.jsdelivr.net/gh/PokeAPI/sprites@master/sprites/pokemon';
export const spriteGif = (dex: number) =>
  `${SPRITE_BASE}/other/showdown/${dex}.gif`;
export const spritePng = (dex: number) => `${SPRITE_BASE}/${dex}.png`;
