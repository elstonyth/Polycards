import Link from 'next/link';
import { Send } from 'lucide-react';
import { BUYBACK_RATE_LABEL } from '@/lib/buyback-copy';
import { TELEGRAM_URL } from '@/lib/site';

// Quiet site footer: the visitor's route to the trust pages, then the
// legal/positioning line.
//
// The link row came back 2026-11-11 (home critique, owner call). It was
// removed 2026-07-31 because /me showed the same trust links twice in one
// scroll; /me has since kept only its Support tile, and without this row a
// logged-out visitor had no path to /about or /contact at all. Telegram sits
// here because home shows no floating Telegram chip (it sat on the pack
// ladder's prices). There is no /fairness link: the owner removed that page
// 2026-11-11, so don't add one back.
//
// /about has no other inbound link in src/ — it has the exact signature
// (zero inbound links) that this repo's dead-route sweeps prune on, and it is
// live, not suspended.
//
// Kept to one hairline-bordered band so app surfaces (slots spin, vault) don't
// gain heavy chrome. Bottom padding clears the fixed TabBar on phones, same
// contract as <main> in layout.tsx.
const LINKS = [
  { href: '/how-it-works', label: 'How it works' },
  { href: '/about', label: 'About' },
  { href: '/contact', label: 'Contact' },
  { href: '/privacy', label: 'Privacy' },
] as const;

const LINK =
  'inline-flex min-h-11 items-center gap-1.5 rounded-md px-2 text-[13px] text-neutral-400 transition-colors hover:text-white focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:outline-none motion-reduce:transition-none';

export default function SiteFooter() {
  return (
    <footer
      data-site-chrome
      className="border-t border-white/10 px-fluid pb-28 pt-3 lg:pb-8"
    >
      <nav aria-label="Footer">
        <ul className="-mx-2 flex flex-wrap items-center">
          {LINKS.map(({ href, label }) => (
            <li key={href}>
              <Link href={href} className={LINK}>
                {label}
              </Link>
            </li>
          ))}
          <li>
            <a href={TELEGRAM_URL} className={LINK}>
              <Send className="size-3.5" aria-hidden="true" />
              Telegram
            </a>
          </li>
        </ul>
      </nav>
      <p className="mt-2 text-[12px] text-white/55">
        © {new Date().getFullYear()} Polycards — rip packs, pull real cards.
        Vault buyback at {BUYBACK_RATE_LABEL}. Instant rates apply during the
        reveal countdown.
      </p>
    </footer>
  );
}
