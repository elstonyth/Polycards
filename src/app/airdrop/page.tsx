import type { Metadata } from 'next';
import { Gift, Sparkles } from 'lucide-react';
import Reveal from '@/components/Reveal';
import AuthButton from '@/components/AuthButton';

export const metadata: Metadata = {
  title: 'Pokémon Card Airdrop',
  description: 'Claim free Pokémon cards in the upcoming airdrop.',
};

// Early claimers wall (reuses the local avatar set).
const AVATARS = Array.from(
  { length: 48 },
  (_, i) => `/images/pfps/pfp-${(i % 81) + 1}.webp`,
);

export default function AirdropPage() {
  return (
    <div className="mx-auto w-full px-fluid py-4">
      <section className="relative mb-8 overflow-hidden rounded-2xl border border-white/10 bg-neutral-950 px-6 py-16 text-center sm:py-24">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_50%_at_50%_0%,rgba(168,85,247,0.18),transparent_70%)]" />
        <div className="relative">
          <span className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-fuchsia-500/30 to-violet-500/10 text-fuchsia-300 [animation:coinSpin_4s_linear_infinite] [perspective:600px] motion-reduce:[animation:none]">
            <Gift className="h-8 w-8" aria-hidden />
          </span>
          <p className="mb-3 text-[12px] font-semibold uppercase tracking-[0.25em] text-fuchsia-300/80">
            Preparing Pokémon Card Airdrop
          </p>
          <h1 className="mx-auto max-w-2xl font-heading text-4xl font-bold leading-[1.05] tracking-tight text-white sm:text-5xl lg:text-6xl">
            Free cards are dropping soon
          </h1>
          <p className="mx-auto mt-4 max-w-md text-sm leading-relaxed text-white/65 sm:text-base">
            Reserve your spot now and claim a free graded card when the airdrop
            goes live.
          </p>
          <AuthButton
            mode="signup"
            className="mt-8 inline-flex h-12 items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-fuchsia-500 to-violet-500 px-8 text-sm font-semibold text-white shadow-lg transition-opacity hover:opacity-90"
          >
            <Sparkles className="h-4 w-4" aria-hidden /> Claim Free Pokémon
            Cards
          </AuthButton>
        </div>
      </section>

      {/* Claimers wall */}
      <Reveal as="section" className="text-center">
        <p className="mb-4 text-[13px] font-medium text-white/50">
          Joined by collectors worldwide
        </p>
        <div className="mx-auto grid max-w-4xl grid-cols-8 gap-2 sm:grid-cols-12">
          {AVATARS.map((src, i) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={i}
              src={src}
              alt=""
              aria-hidden
              className="aspect-square w-full rounded-full object-cover ring-1 ring-white/10"
              loading="lazy"
            />
          ))}
        </div>
      </Reveal>
    </div>
  );
}
