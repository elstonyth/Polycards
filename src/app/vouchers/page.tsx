import type { Metadata } from 'next';
import { Ticket } from 'lucide-react';
import Reveal from '@/components/Reveal';

export const metadata: Metadata = {
  title: 'Your Vouchers — Phygitals',
  description:
    'Redeem vouchers for free pulls and guaranteed buybacks on the claw machine.',
};

// Standalone full-width route matching the live anonymous /vouchers: a centered hero
// over blurred pack art, then an "Active Vouchers" empty state (no fabricated vouchers —
// the live site exposes none until you have them). Moved out of the (account) shell;
// live has no account sidebar here.

const HERO_SLABS = [
  '/images/claw/legend-pack-icon.webp',
  '/images/claw/mythic-pack-icon.webp',
  '/images/claw/elite-pack-icon.webp',
  '/images/claw/legend-one-piece-pack-icon.webp',
  '/images/claw/platinum-football-pack-icon.webp',
];

export default function VouchersPage() {
  return (
    <div className="w-full px-fluid py-10">
      {/* Hero */}
      <section className="relative mb-8 overflow-hidden rounded-2xl border border-white/10 bg-neutral-950">
        <div className="pointer-events-none absolute inset-0 flex">
          {HERO_SLABS.map((src, i) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={i}
              src={src}
              alt=""
              aria-hidden="true"
              className="h-full flex-1 object-cover opacity-25 blur-3xl saturate-150"
            />
          ))}
        </div>
        <div className="pointer-events-none absolute inset-0 bg-neutral-950/80" />
        <div className="relative flex flex-col items-center px-6 py-12 text-center sm:py-14">
          <span className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-white/10 text-white">
            <Ticket className="h-6 w-6" aria-hidden />
          </span>
          <Reveal
            as="h1"
            className="font-heading text-3xl font-bold tracking-tight text-white sm:text-4xl"
          >
            Your Vouchers
          </Reveal>
          <Reveal
            as="p"
            delay={80}
            className="mt-3 max-w-md text-sm leading-relaxed text-white/60 sm:text-base"
          >
            Redeem vouchers for free pulls and guaranteed buybacks on the claw
            machine.
          </Reveal>
        </div>
      </section>

      {/* Active vouchers — empty state */}
      <section>
        <h2 className="font-heading text-xl font-bold tracking-tight text-white">
          Active Vouchers
        </h2>
        <p className="mt-1 text-sm text-white/50">
          Redeem these for free pulls
        </p>
        <div className="mt-5 flex flex-col items-center justify-center rounded-2xl border border-white/10 bg-white/[0.02] px-6 py-16 text-center">
          <span className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-white/5 text-white/40">
            <Ticket className="h-6 w-6" aria-hidden />
          </span>
          <p className="text-sm font-semibold text-white">No Active Vouchers</p>
          <p className="mt-1.5 max-w-sm text-[13px] leading-relaxed text-white/45">
            You don&apos;t have any active vouchers at the moment. Active
            vouchers will appear here when you receive them.
          </p>
        </div>
      </section>
    </div>
  );
}
