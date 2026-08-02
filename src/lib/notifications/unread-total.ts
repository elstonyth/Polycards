// Merges the server's TRUE cross-page unread total (route.ts contract) with
// this page's optimistic mark-read state, so the "Mark all read (N)" label
// reflects everything the button clears — not just the 20 rows on screen.
//
// `serverTotal` is a frozen snapshot from the initial render; rows on OTHER
// pages can only change via this very button, so the only local drift we must
// subtract is reads that happened on THIS page since it rendered:
// (initialUnreadOnPage - currentUnreadOnPage). Clamped ≥ 0 so a stale
// RSC-cached serverTotal after a Back navigation can never render negative.
export function displayUnreadTotal(
  serverTotal: number,
  initialUnreadOnPage: number,
  currentUnreadOnPage: number,
): number {
  return Math.max(serverTotal - (initialUnreadOnPage - currentUnreadOnPage), 0);
}
