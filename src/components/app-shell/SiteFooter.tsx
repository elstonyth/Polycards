import { BUYBACK_RATE_LABEL } from '@/lib/buyback-copy';

// Quiet site footer — now just the legal/positioning line.
//
// It used to carry a nav row (how-it-works, fairness, leaderboard, about,
// contact). Removed 2026-07-31: /me rendered its own card of the same four
// trust links directly above this band, so that page showed them twice in one
// scroll, and Leaderboard already has a permanent home in the tab bar ("Ranks").
// Both copies went — operator call.
//
// CONSEQUENCE, on purpose. All four trust routes stay public and stay in ROUTES
// (lib/site.ts), so they stay in the sitemap and are reachable by URL and from
// search. What they lost is navigation. The FULL inbound-link map in src/ as of
// this change — verified by grep, keep it honest if you touch these pages:
//
//   /how-it-works  home page (components/home/TheGame.tsx), /about, /contact
//   /fairness      /contact ONLY
//   /contact       the "Support" tile on /me ONLY — and (account)/layout.tsx
//                  redirects logged-out visitors, so that link is behind login
//   /about         NOTHING
//
// Read the second and third rows together: /fairness is navigable only as
// log in → /me → /contact → /fairness. A logged-out visitor has no path to the
// fairness disclosure, to support, or to /about at all.
//
// Do NOT prune these as orphans without checking here first — /about in
// particular has the exact signature (zero inbound links) that this repo's
// dead-route sweeps prune on, and it is live, not suspended.
//
// Kept to one hairline-bordered band so app surfaces (slots spin, vault) don't
// gain heavy chrome. Bottom padding clears the fixed TabBar on phones, same
// contract as <main> in layout.tsx.
export default function SiteFooter() {
  return (
    <footer
      data-site-chrome
      className="border-t border-white/10 px-fluid pb-28 pt-6 lg:pb-8"
    >
      <p className="text-[12px] text-white/55">
        © {new Date().getFullYear()} Polycards — rip packs, pull graded cards,
        sell back at {BUYBACK_RATE_LABEL}.
      </p>
    </footer>
  );
}
