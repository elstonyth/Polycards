// PokeAPI/sprites served via jsDelivr's CDN. raw.githubusercontent.com
// rate-limits (429) and intermittently blocks (000) sprite requests, which broke
// reel cells into broken-image icons; jsDelivr mirrors the SAME repo+ref with no
// rate limit and proper CDN caching. Animated "showdown" gif (matches the live
// site); static png is the fallback.
const SPRITE_BASE =
  'https://cdn.jsdelivr.net/gh/PokeAPI/sprites@master/sprites/pokemon';
export const spritePng = (dex: number) => `${SPRITE_BASE}/${dex}.png`;

// Iron Moth and Iron Thorns have static art but no Showdown GIF. Avoid
// requesting known 404s, including speculative reel image preloads.
const STATIC_ONLY_DEX = new Set([994, 995]);
export const spriteGif = (dex: number) =>
  STATIC_ONLY_DEX.has(dex)
    ? spritePng(dex)
    : `${SPRITE_BASE}/other/showdown/${dex}.gif`;
