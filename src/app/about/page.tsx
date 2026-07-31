// NOT DEAD — deliberately unlinked. This route has ZERO inbound links in src/
// as of 2026-07-31: the operator removed both the /me "About & help" card and
// the site-footer nav that pointed here (they duplicated each other on one
// screen), and chose not to add a replacement. It is still public, still in
// ROUTES (lib/site.ts) and so still in the sitemap, and is reached from search
// and by URL. See the comment in components/app-shell/SiteFooter.tsx for the
// full reachability map. Zero inbound links is exactly the signature this
// repo's dead-route sweeps prune on — check there before deleting this.
import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import Reveal from '@/components/Reveal';
import { pillVariants } from '@/components/ui/pill';
import { BUYBACK_RATE_LABEL } from '@/lib/buyback-copy';

export const metadata: Metadata = {
  title: 'About',
  description:
    'The infrastructure for digital collectibles. Buy digital packs backed by real physical cards. Instantly reveal, securely vault, and ship or sell whenever you want.',
};

const STEPS = [
  {
    num: '01',
    title: 'BUY A PACK',
    body: 'Purchase digitally with your card. Real physical cards from our inventory.',
  },
  {
    num: '02',
    title: 'INSTANT REVEAL',
    body: 'Watch your cards revealed live. Know exactly what you pulled.',
  },
  {
    num: '03',
    title: 'SECURELY VAULTED',
    body: 'Cards stored in top-tier insured US facilities.',
  },
  {
    num: '04',
    title: 'SHIP OR SELL',
    body: `Redeem anytime with worldwide shipping, or sell back at ${BUYBACK_RATE_LABEL}.`,
  },
] as const;

const FEATURES = [
  {
    stat: '100%',
    statClass: 'text-white',
    label: 'Graded cards vaulted',
    body: 'Every digital card is backed by a real graded card in the vault. Best of both worlds combined.',
  },
  {
    stat: BUYBACK_RATE_LABEL,
    // Money-in signal (DESIGN.md Signal Rule) — the one colored stat.
    statClass: 'text-buyback-fg',
    label: 'Buyback rate',
    body: `${BUYBACK_RATE_LABEL} buyback guarantee on every card. Sell instantly without waiting for buyers.`,
  },
  {
    stat: '24/7',
    statClass: 'text-white',
    label: 'Always open',
    body: 'Open around the clock, worldwide. Rip a pack or sell a card back any hour, no waiting on a buyer.',
  },
] as const;

const VAULT_ROWS = [
  {
    title: 'CHOOSE YOUR VAULT',
    body: 'PSA, Alt, or Fanatics facilities',
  },
  {
    title: 'FULLY INSURED',
    body: 'Complete coverage for all items',
  },
  {
    title: 'CLIMATE CONTROLLED',
    body: 'Optimal storage conditions',
  },
] as const;

const VAULT_LOGOS = [
  { src: '/images/psa.png', alt: 'PSA' },
  { src: '/images/fanatics.png', alt: 'Fanatics' },
  { src: '/images/altwhite.png', alt: 'Alt' },
];

/** Board lockup (DESIGN.md §5) — ALL-CAPS Nekst head, optional quiet link. */
const BoardHead = ({
  id,
  title,
  link,
}: {
  id: string;
  title: string;
  link?: { href: string; label: string };
}) => (
  <div className="flex items-baseline justify-between">
    <h2 id={id} className="font-heading text-2xl text-white">
      {title}
    </h2>
    {link && (
      <Link
        href={link.href}
        className="flex min-h-11 items-center gap-1 text-[13px] font-semibold text-neutral-400 transition-colors hover:text-white"
      >
        {link.label}
        <ArrowRight className="h-3.5 w-3.5" aria-hidden />
      </Link>
    )}
  </div>
);

export default function AboutPage() {
  return (
    <div className="px-fluid mx-auto w-full py-4">
      {/* 01 — hero lockup */}
      <section
        aria-labelledby="about-heading"
        className="flex flex-col items-center py-14 text-center sm:py-20"
      >
        <Reveal
          as="p"
          className="text-[11px] font-semibold uppercase tracking-[0.3em] text-neutral-400"
        >
          Graded cards · Real buyback
        </Reveal>
        <Reveal delay={60}>
          <h1
            id="about-heading"
            className="font-heading mx-auto mt-4 max-w-4xl text-4xl leading-[0.95] text-white sm:text-5xl lg:text-6xl"
          >
            THE INFRASTRUCTURE FOR{' '}
            <span className="text-neutral-500">DIGITAL COLLECTIBLES</span>
          </h1>
        </Reveal>
        <Reveal
          as="p"
          delay={120}
          className="mt-5 max-w-md text-[15px] leading-relaxed text-neutral-300"
        >
          Buy digital packs backed by real physical cards. Instantly reveal,
          securely vault, and ship or sell whenever you want.
        </Reveal>
        <Reveal
          delay={180}
          className="mt-8 flex flex-wrap justify-center gap-3"
        >
          <Link
            href="/slots"
            className={cn(pillVariants({ variant: 'primary', size: 'lg' }))}
          >
            Explore packs
            <ArrowRight className="h-4 w-4" aria-hidden />
          </Link>
          <a
            href="#launch"
            className={cn(pillVariants({ variant: 'ghost', size: 'lg' }))}
          >
            Launch with us
          </a>
        </Reveal>
      </section>

      {/* 02 — how it works: numbered editorial rows (same idiom as /contact's
          quick answers) */}
      <section aria-labelledby="how-heading" className="mt-10 w-full">
        <BoardHead
          id="how-heading"
          title="HOW IT WORKS"
          link={{ href: '/how-it-works', label: 'Full details' }}
        />
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((step, i) => (
            <Reveal key={step.num} delay={i * 90} className="h-full">
              <div className="flex h-full items-start gap-4 rounded-2xl border border-white/10 bg-neutral-900 p-4">
                <span className="font-heading text-4xl leading-none text-neutral-700">
                  {step.num}
                </span>
                <div>
                  <p className="font-heading text-base text-white">
                    {step.title}
                  </p>
                  <p className="mt-1 text-[13px] leading-relaxed text-neutral-400">
                    {step.body}
                  </p>
                </div>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* 03 — platform stats */}
      <section aria-labelledby="platform-heading" className="mt-14 w-full">
        <BoardHead id="platform-heading" title="THE PLATFORM" />
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
          {FEATURES.map((f, i) => (
            <Reveal key={f.label} delay={i * 90} className="h-full">
              <div className="flex h-full flex-col rounded-2xl border border-white/10 bg-neutral-900 p-5">
                <p
                  className={`font-heading text-4xl leading-none ${f.statClass}`}
                >
                  {f.stat}
                </p>
                <p className="mt-2 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
                  {f.label}
                </p>
                <p className="mt-3 text-[13px] leading-relaxed text-neutral-400">
                  {f.body}
                </p>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* 04 — launch with us */}
      <section
        id="launch"
        aria-labelledby="launch-heading"
        className="mt-14 w-full scroll-mt-24"
      >
        <BoardHead id="launch-heading" title="LAUNCH WITH US" />
        <div className="mt-4 flex flex-col gap-3 lg:flex-row">
          <Reveal className="flex-1">
            <div className="flex h-full flex-col justify-center gap-3 rounded-2xl border border-white/10 bg-neutral-900 p-5">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
                  For brands
                </p>
                <p className="font-heading mt-2 text-lg leading-snug text-white">
                  YOUR BRAND, OUR RAILS.
                </p>
                <p className="mt-1 max-w-md text-[13px] leading-relaxed text-neutral-400">
                  Power your brand with our complete infrastructure. Custom
                  branding, payment processing, vault storage, and worldwide
                  fulfillment.
                </p>
              </div>
              <a
                href="mailto:hello@polycards.com"
                className="flex min-h-11 w-fit items-center gap-1 text-[13px] font-semibold text-neutral-400 transition-colors hover:text-white"
              >
                Talk to us
                <ArrowRight className="h-3.5 w-3.5" aria-hidden />
              </a>
            </div>
          </Reveal>
          <Reveal delay={90} className="flex-1">
            <div className="flex h-full flex-col justify-center rounded-2xl border border-white/10 bg-neutral-900 p-5">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
                Featured partner
              </p>
              <p className="font-heading mt-2 text-lg leading-snug text-white">
                ZARDO CARDS
              </p>
              <p className="mt-1 text-[13px] leading-relaxed text-neutral-400">
                One of the largest online Pokemon stores, now offering digital
                pack breaks powered by Polycards.
              </p>
            </div>
          </Reveal>
        </div>
      </section>

      {/* 05 — vault & security */}
      <section aria-labelledby="vault-heading" className="mt-14 w-full">
        <BoardHead id="vault-heading" title="VAULT & SECURITY" />
        <div className="mt-4 flex flex-col gap-3 lg:flex-row">
          {VAULT_ROWS.map((row, i) => (
            <Reveal key={row.title} delay={i * 90} className="flex-1">
              <div className="flex h-full flex-col rounded-2xl border border-white/10 bg-neutral-900 p-4">
                <p className="font-heading text-base text-white">{row.title}</p>
                <p className="mt-1 text-[13px] leading-relaxed text-neutral-400">
                  {row.body}
                </p>
              </div>
            </Reveal>
          ))}
        </div>
        <Reveal className="mt-6 flex flex-wrap items-center justify-center gap-8 opacity-70">
          {VAULT_LOGOS.map((l) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={l.alt}
              src={l.src}
              alt={l.alt}
              className="h-7 w-auto object-contain"
            />
          ))}
        </Reveal>
      </section>

      {/* 06 — closer (FinalCta idiom) */}
      <Reveal as="section" className="mt-16 w-full pb-4">
        <div className="flex flex-col items-center py-10 text-center">
          <p className="font-heading text-5xl leading-[0.95] text-white lg:text-7xl">
            START
            <br />
            COLLECTING
          </p>
          <Link
            href="/slots"
            className={cn(
              pillVariants({ variant: 'primary', size: 'lg' }),
              'mt-8',
            )}
          >
            EXPLORE PACKS
            <ArrowRight className="h-4 w-4" aria-hidden />
          </Link>
          <p className="mt-4 text-[13px] text-neutral-400">
            Real graded slabs · {BUYBACK_RATE_LABEL} buyback ·{' '}
            <a
              href="mailto:hello@polycards.com"
              className="text-neutral-300 underline-offset-2 hover:underline"
            >
              hello@polycards.com
            </a>
          </p>
        </div>
      </Reveal>
    </div>
  );
}
