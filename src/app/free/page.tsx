import type { Metadata } from 'next';
import { Sparkles, UserPlus, Gamepad2, Banknote } from 'lucide-react';
import Reveal from '@/components/Reveal';
import AuthButton from '@/components/AuthButton';
import { BUYBACK_RATE_LABEL } from '@/lib/buyback-copy';

export const metadata: Metadata = {
  title: 'Your Free Pack is Waiting',
  description:
    'Join thousands of collectors pulling rare cards daily. Create your account and claim a free pack.',
};

// All five distinct Polycards tiers — also keeps key={src} unique in the fan.
const PACKS = [
  '/images/polycards/silver-pack.webp',
  '/images/polycards/platinum-pack.webp',
  '/images/polycards/diamond-pack.webp',
  '/images/polycards/gold-pack.webp',
  '/images/polycards/bronze-pack.webp',
];

const STEPS = [
  {
    icon: UserPlus,
    title: 'Create your account in seconds',
    body: 'Sign up free — no card required to start.',
  },
  {
    icon: Gamepad2,
    title: 'Try our RM 1 claw machine risk free',
    body: 'Rip your first pack and reveal a real graded card.',
  },
  {
    icon: Banknote,
    title: 'Keep or sell back for up to RM 500',
    body: `Hold it, ship it, or sell back instantly at ${BUYBACK_RATE_LABEL}.`,
  },
];

export default function FreePage() {
  return (
    <div className="mx-auto w-full px-fluid py-4">
      {/* Hero */}
      <section className="relative mb-10 overflow-hidden rounded-2xl border border-white/10 bg-neutral-950 px-6 py-14 text-center sm:py-20">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/home/hero/ripped-packs/pokemon.webp"
          alt=""
          aria-hidden
          className="pointer-events-none absolute inset-0 h-full w-full object-cover opacity-50 blur-[44px] saturate-[1.6] animate-[heroBlob_18s_ease-in-out_infinite] motion-reduce:animate-none"
        />
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-neutral-950/80 via-neutral-950/70 to-neutral-950/95" />
        <div className="relative">
          <p className="mb-3 inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-white/5 px-3 py-1 text-[11px] font-semibold uppercase tracking-widest text-white/60">
            <Sparkles className="h-3.5 w-3.5" aria-hidden /> Free to start
          </p>
          <h1 className="mx-auto max-w-2xl font-heading text-4xl font-bold leading-[1.05] tracking-tight text-white sm:text-5xl lg:text-6xl">
            Your Free Pack is Waiting
          </h1>
          <p className="mx-auto mt-4 max-w-md text-sm leading-relaxed text-white/65 sm:text-base">
            Join thousands of collectors pulling rare cards daily.
          </p>
          {/* pack fan */}
          <div className="mt-8 flex items-end justify-center gap-2 sm:gap-4">
            {PACKS.map((src, i) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={src}
                src={src}
                alt=""
                aria-hidden
                className="h-20 w-auto object-contain drop-shadow-[0_16px_40px_rgba(0,0,0,0.5)] sm:h-28"
                style={{
                  transform: `translateY(${Math.abs(i - 2) * 8}px) rotate(${(i - 2) * 5}deg)`,
                }}
              />
            ))}
          </div>
          <AuthButton
            mode="signup"
            className="mt-10 inline-flex h-12 items-center justify-center rounded-2xl bg-white px-8 text-sm font-semibold text-neutral-950 shadow-lg transition-opacity hover:opacity-90"
          >
            Sign Up &amp; Claim Free Pack
          </AuthButton>
        </div>
      </section>

      {/* Steps */}
      <div className="mx-auto grid max-w-4xl grid-cols-1 gap-4 sm:grid-cols-3">
        {STEPS.map((s, i) => {
          const Icon = s.icon;
          return (
            <Reveal key={s.title} delay={i * 90} className="h-full">
              <div className="flex h-full flex-col rounded-2xl border border-white/10 bg-white/[0.03] p-6">
                <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-white/15 to-white/5 text-white">
                  <Icon className="h-5 w-5" aria-hidden />
                </div>
                <h3 className="mb-1.5 font-heading text-sm font-semibold text-white">
                  {s.title}
                </h3>
                <p className="text-[13px] leading-relaxed text-white/55">
                  {s.body}
                </p>
              </div>
            </Reveal>
          );
        })}
      </div>
    </div>
  );
}
