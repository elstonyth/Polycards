// PokeAPI/sprites served via jsDelivr's CDN. raw.githubusercontent.com
// rate-limits (429) and intermittently blocks (000) sprite requests, which broke
// reel cells into broken-image icons; jsDelivr mirrors the SAME repo+ref with no
// rate limit and proper CDN caching. Animated "showdown" gif (matches the live
// site); static png is the fallback.
const SPRITE_BASE =
  'https://cdn.jsdelivr.net/gh/PokeAPI/sprites@master/sprites/pokemon';
export const spritePng = (dex: number) => `${SPRITE_BASE}/${dex}.png`;

// Static art but no Showdown GIF — the late Gen 9 paradoxes, legends and
// Ogerpon (#1017 404'd on the prod bronze reel 2026-09-24). The list is the
// full measured set: every dex 1-1025 was HEAD-checked on jsDelivr that day.
// Avoid requesting known 404s, including speculative reel image preloads.
const STATIC_ONLY_DEX = new Set([
  990, 991, 992, 993, 994, 995, 1006, 1008, 1010, 1017, 1022, 1023, 1024, 1025,
]);
export const spriteGif = (dex: number) =>
  STATIC_ONLY_DEX.has(dex)
    ? spritePng(dex)
    : `${SPRITE_BASE}/other/showdown/${dex}.gif`;
