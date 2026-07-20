/**
 * Clamp an arbitrary ?page= value (URL param or action arg) to a safe
 * 1-based integer. Bad input → page 1; absurd input capped at 1000.
 * Shared by the paged account actions (notifications, transactions).
 */
export function sanePage(page: unknown): number {
  const n = typeof page === 'number' ? page : Number(page);
  if (!Number.isInteger(n) || n < 1) return 1;
  return Math.min(n, 1000);
}
