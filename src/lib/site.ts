// Canonical public origin. Falls back to localhost for dev so metadataBase and
// the sitemap still resolve; set NEXT_PUBLIC_SITE_URL in the deploy env.
export const SITE_URL = (
  process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:4000'
).replace(/\/$/, '');

// Indexable, public routes only (no account/auth pages, no dynamic detail
// pages, no demo pages).
export const ROUTES: string[] = [
  '/',
  '/slots',
  '/leaderboard',
  '/how-it-works',
  '/fairness',
  '/about',
  '/contact',
  '/privacy',
];
