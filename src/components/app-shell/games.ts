// The Games tab opens the game picker (GamesSheet, mounted once in the root
// layout) through a window event, the way openAuth reaches AuthModal — so
// TabBar and AppHeader need no shared state.
export const GAMES_EVENT = 'polycards:games';

// Coin Flip shows as Coming soon until this is true (operator 2026-11-03): no
// tile link, Vault button, ticket link, history or page. The admin switch only
// stops flips and hides nothing. To open: set true, deploy, then enable in admin.
// scripts/qa-coin-flip.mjs needs it true, the page redirects otherwise.
export const COIN_FLIP_OPEN = true;

export function openGames(): void {
  window.dispatchEvent(new Event(GAMES_EVENT));
}
