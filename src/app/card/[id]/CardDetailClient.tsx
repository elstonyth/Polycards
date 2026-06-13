'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  ShoppingCart,
  Tag,
  HandCoins,
  ShieldCheck,
  TrendingUp,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import Reveal from '@/components/Reveal';
import { features } from '@/lib/features';
import { usd, num } from '@/lib/format';
import { useAuth } from '@/components/auth/AuthProvider';
import { openAuth } from '@/components/AuthButton';
import { type MockCard, RARITY_RGB, moreFromSet } from '@/lib/mock/cards';
import { MOCK_USERS } from '@/lib/mock/users';

export default function CardDetailClient({ card }: { card: MockCard }) {
  const ring = RARITY_RGB[card.rarity];
  const { customer } = useAuth();
  const [note, setNote] = useState<string | null>(null);

  // Marketplace actions stay login-gated (Task C decision): anonymous visitors
  // get the login modal; logged-in customers see the not-yet-live note.
  const gated = (message: string) => () => {
    if (!customer) {
      openAuth('login');
      return;
    }
    setNote(message);
  };
  const more = useMemo(() => {
    const set = moreFromSet(card, 6);
    return set.length ? set : []; // may be empty for generic cards
  }, [card]);
  const owner = useMemo(
    () => MOCK_USERS[(card.points + card.year) % MOCK_USERS.length],
    [card],
  );

  // Tiny deterministic sparkline for the price-history placeholder.
  const spark = useMemo(() => {
    const pts: number[] = [];
    let v = card.fmv * 0.7;
    for (let i = 0; i < 24; i++) {
      v += Math.sin(i * 1.3 + card.fmv) * (card.fmv * 0.04) + card.fmv * 0.006;
      pts.push(Math.max(card.fmv * 0.5, v));
    }
    const max = Math.max(...pts),
      min = Math.min(...pts);
    return pts
      .map(
        (p, i) =>
          `${(i / 23) * 100},${100 - ((p - min) / (max - min || 1)) * 100}`,
      )
      .join(' ');
  }, [card]);

  return (
    <div className="mx-auto w-full px-fluid py-4">
      <Link
        href={features.marketplace ? '/marketplace' : '/claw'}
        className="mb-4 inline-flex items-center gap-1.5 text-[13px] font-medium text-white/55 transition-colors hover:text-white"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />{' '}
        {features.marketplace ? 'Marketplace' : 'Packs'}
      </Link>

      <section className="grid gap-8 md:grid-cols-[0.9fr_1.1fr]">
        {/* Card image */}
        <Reveal className="md:sticky md:top-20 md:self-start">
          <div
            className="relative overflow-hidden rounded-3xl border p-4"
            style={{
              borderColor: `rgba(${ring},0.5)`,
              boxShadow: `0 0 60px -20px rgba(${ring},0.6)`,
            }}
          >
            <div className="aspect-[3/4] w-full overflow-hidden rounded-2xl bg-[radial-gradient(120%_80%_at_50%_12%,#2e2e2e_0%,#1c1c1c_55%,#121212_100%)]">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={card.image}
                alt={card.name}
                className="h-full w-full object-contain p-4"
              />
            </div>
          </div>
        </Reveal>

        {/* Details */}
        <Reveal delay={80}>
          <span
            className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide"
            style={{
              color: `rgb(${ring})`,
              backgroundColor: `rgba(${ring},0.12)`,
            }}
          >
            {card.rarity}
          </span>
          <h1 className="mt-3 font-heading text-2xl font-bold leading-tight tracking-tight text-white sm:text-3xl">
            {card.name}
          </h1>
          <p className="mt-2 text-sm text-white/50">{card.set}</p>

          {/* chips */}
          <div className="mt-4 flex flex-wrap gap-2">
            {[
              `${card.grader} ${card.grade}`,
              `${card.year}`,
              `+${card.points} pts`,
            ].map((c) => (
              <span
                key={c}
                className="rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[12px] font-medium text-white/80"
              >
                {c}
              </span>
            ))}
          </div>

          {/* price block */}
          <div className="mt-5 flex flex-wrap items-end gap-x-8 gap-y-3 rounded-2xl border border-white/10 bg-white/[0.03] p-5">
            <div>
              <p className="text-[11px] uppercase tracking-wide text-white/40">
                Price
              </p>
              <p className="font-heading text-3xl font-bold text-white">
                {usd(card.price)}
              </p>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-wide text-white/40">
                Fair Market Value
              </p>
              <p className="text-lg font-semibold text-white/80">
                {usd(card.fmv)}
              </p>
            </div>
            <div className="flex items-center gap-1 text-[13px] font-medium text-emerald-400">
              <TrendingUp className="h-4 w-4" aria-hidden /> Buyback{' '}
              {usd(Math.round(card.fmv * 0.88))}
            </div>
          </div>

          {/* actions */}
          <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-3">
            <button
              type="button"
              onClick={gated('Checkout goes live with the backend.')}
              className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-neutral-200 text-sm font-semibold text-neutral-950 transition-colors hover:bg-white"
            >
              <ShoppingCart className="h-4 w-4" aria-hidden /> Buy now
            </button>
            <button
              type="button"
              onClick={gated('Offers go live with the backend.')}
              className="inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-white/15 bg-white/5 text-sm font-medium text-white transition-colors hover:bg-white/10"
            >
              <HandCoins className="h-4 w-4" aria-hidden /> Make offer
            </button>
            <button
              type="button"
              onClick={gated('Instant sell-back goes live with the backend.')}
              className="inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-white/15 bg-white/5 text-sm font-medium text-white transition-colors hover:bg-white/10"
            >
              <Tag className="h-4 w-4" aria-hidden /> Sell
            </button>
          </div>
          {note && <p className="mt-2 text-[12px] text-white/45">{note}</p>}

          {/* owner + vault */}
          <div className="mt-5 flex flex-wrap items-center gap-4 text-[13px]">
            <Link
              href={`/profile/${owner.username}`}
              className="group flex items-center gap-2 text-white/70 hover:text-white"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={owner.pfp}
                alt=""
                className="h-7 w-7 rounded-full object-cover ring-1 ring-white/10"
              />
              Owned by{' '}
              <span className="font-semibold text-white">{owner.username}</span>
            </Link>
            <span className="flex items-center gap-1.5 text-white/45">
              <ShieldCheck className="h-4 w-4 text-emerald-400" aria-hidden />{' '}
              Vaulted &amp; insured · {card.grader}
            </span>
          </div>

          {/* price history placeholder */}
          <div className="mt-6 rounded-2xl border border-white/10 bg-white/[0.03] p-5">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-white">
                Price history
              </h2>
              <span className="text-[11px] text-white/35">demo data</span>
            </div>
            <svg
              viewBox="0 0 100 100"
              preserveAspectRatio="none"
              className="h-24 w-full"
            >
              <polyline
                points={spark}
                fill="none"
                stroke={`rgb(${ring})`}
                strokeWidth="1.5"
                vectorEffect="non-scaling-stroke"
              />
            </svg>
            <div className="mt-2 flex justify-between text-[11px] text-white/40">
              <span>24 sales</span>
              <span>Last: {usd(card.fmv)}</span>
            </div>
          </div>
        </Reveal>
      </section>

      {/* More from this set */}
      {more.length > 0 && (
        <section className="mt-12">
          <h2 className="mb-4 font-heading text-lg font-bold tracking-tight text-white">
            More from {card.set}
          </h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {more.map((c, i) => (
              <Reveal key={c.id} delay={Math.min(i, 5) * 50} className="h-full">
                <Link
                  href={`/card/${c.id}`}
                  className="group block h-full overflow-hidden rounded-2xl border border-white/10 bg-neutral-800 transition-all duration-300 hover:-translate-y-1 hover:border-white/20"
                >
                  <div className="aspect-[3/4] w-full overflow-hidden bg-[radial-gradient(120%_80%_at_50%_15%,#2e2e2e_0%,#1c1c1c_55%,#141414_100%)]">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={c.image}
                      alt={c.name}
                      loading="lazy"
                      className="h-full w-full object-contain p-3 transition-transform duration-300 group-hover:scale-[1.04]"
                    />
                  </div>
                  <div className="p-2.5">
                    <p className="truncate text-[11px] text-white/70">
                      {c.grader} {c.grade}
                    </p>
                    <p className="text-sm font-bold text-white">
                      {usd(c.price)}
                    </p>
                  </div>
                </Link>
              </Reveal>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
