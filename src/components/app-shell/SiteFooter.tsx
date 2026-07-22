import Link from 'next/link';
import { BUYBACK_RATE_LABEL } from '@/lib/buyback-copy';

// Quiet site footer — the only place the trust/info routes (how-it-works,
// fairness, about, contact) are discoverable; the 5-tab shell deliberately
// doesn't carry them. Kept to one hairline-bordered band so app surfaces
// (slots spin, vault) don't gain heavy chrome. Bottom padding clears the
// fixed TabBar on phones, same contract as <main> in layout.tsx.
const FOOTER_LINKS = [
  { href: '/how-it-works', label: 'How it works' },
  { href: '/fairness', label: 'Fairness' },
  { href: '/leaderboard', label: 'Leaderboard' },
  { href: '/about', label: 'About' },
  { href: '/contact', label: 'Contact' },
];

export default function SiteFooter() {
  return (
    <footer
      data-site-chrome
      className="border-t border-white/10 px-fluid pb-28 pt-6 lg:pb-8"
    >
      <nav aria-label="Site">
        <ul className="-ml-2 flex flex-wrap items-center gap-x-1 gap-y-0">
          {FOOTER_LINKS.map((l) => (
            <li key={l.href}>
              {/* py-3 lifts the tap target to 44px without visual bulk. */}
              <Link
                href={l.href}
                className="inline-flex items-center px-2 py-3 text-[13px] font-medium text-white/60 transition-colors hover:text-white"
              >
                {l.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <p className="mt-1 text-[12px] text-white/55">
        © {new Date().getFullYear()} Polycards — rip packs, pull graded cards,
        sell back at {BUYBACK_RATE_LABEL}.
      </p>
    </footer>
  );
}
