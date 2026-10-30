// The Games tab opens the game picker (GamesSheet, mounted once in the root
// layout) through a window event, the way openAuth reaches AuthModal — so
// TabBar and AppHeader need no shared state.
export const GAMES_EVENT = 'polycards:games';

export function openGames(): void {
  window.dispatchEvent(new Event(GAMES_EVENT));
}
