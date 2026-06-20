import { features } from '@/lib/features';

// Canonical public origin. Falls back to localhost for dev so metadataBase and
// the sitemap still resolve; set NEXT_PUBLIC_SITE_URL in the deploy env.
export const SITE_URL = (
  process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:4000'
).replace(/\/$/, '');

// Indexable, public routes only (no account/auth pages, no dynamic detail
// pages). Feature-flagged sections are included only when enabled.
export const ROUTES: string[] = [
  '/',
  '/claw',
  '/leaderboard',
  '/how-it-works',
  '/fairness',
  '/about',
  '/contact',
  '/series',
  ...(features.marketplace ? ['/marketplace'] : []),
  ...(features.packParty ? ['/pack-party'] : []),
];
