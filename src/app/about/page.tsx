import type { Metadata } from 'next';
import Link from 'next/link';
import {
  ShoppingBag,
  Sparkles,
  Vault,
  Truck,
  Boxes,
  Layers,
  Zap,
  Globe,
  ShieldCheck,
  Thermometer,
  type LucideIcon,
} from 'lucide-react';
import Reveal from '@/components/Reveal';

export const metadata: Metadata = {
  title: 'About',
  description:
    'The infrastructure for digital collectibles. Buy digital packs backed by real physical cards. Instantly reveal, securely vault, and ship or sell whenever you want.',
};

type Step = { icon: LucideIcon; title: string; body: string };
const STEPS: Step[] = [
  {
    icon: ShoppingBag,
    title: 'Buy a Pack',
    body: 'Purchase digitally with your card. Real physical cards from our inventory.',
  },
  {
    icon: Sparkles,
    title: 'Instant Reveal',
    body: 'Watch your cards revealed live. Know exactly what you pulled.',
  },
  {
    icon: Vault,
    title: 'Securely Vaulted',
    body: 'Cards stored in top-tier insured US facilities.',
  },
  {
    icon: Truck,
    title: 'Ship or Sell',
    body: 'Redeem anytime with worldwide shipping, or sell back at 85%.',
  },
];

type Feature = { icon: LucideIcon; stat: string; label: string; body: string };
const FEATURES: Feature[] = [
  {
    icon: Boxes,
    stat: '5+',
    label: 'Card categories',
    body: 'Sports, Pokemon, TCG, and more. One platform for every type of collectible card.',
  },
  {
    icon: Layers,
    stat: '100%',
    label: 'Graded cards vaulted',
    body: 'Every digital card is backed by a real graded card in the vault. Best of both worlds combined.',
  },
  {
    icon: Zap,
    stat: '85%',
    label: 'Buyback rate',
    body: '85% buyback guarantee on every card. Sell instantly without waiting for buyers.',
  },
  {
    icon: Globe,
    stat: '24/7',
    label: 'Always open',
    body: '24/7 marketplace accessible worldwide. Trade across borders without shipping delays.',
  },
];

type VaultCard = { icon: LucideIcon; title: string; body: string };
const VAULT_CARDS: VaultCard[] = [
  {
    icon: Vault,
    title: 'Choose Your Vault',
    body: 'PSA, Alt, or Fanatics facilities',
  },
  {
    icon: ShieldCheck,
    title: 'Fully Insured',
    body: 'Complete coverage for all items',
  },
  {
    icon: Thermometer,
    title: 'Climate Controlled',
    body: 'Optimal storage conditions',
  },
];

const VAULT_LOGOS = [
  { src: '/images/psa.png', alt: 'PSA' },
  { src: '/images/fanatics.png', alt: 'Fanatics' },
  { src: '/images/altwhite.png', alt: 'Alt' },
];

const SectionHeading = ({ title, sub }: { title: string; sub?: string }) => (
  <div className="mb-8 text-center">
    <h2 className="font-heading text-2xl font-bold tracking-tight text-white sm:text-3xl lg:text-4xl">
      {title}
    </h2>
    {sub && (
      <p className="mx-auto mt-3 max-w-xl text-sm text-white/55 sm:text-base">
        {sub}
      </p>
    )}
  </div>
);

export default function AboutPage() {
  return (
    <div className="mx-auto w-full px-fluid py-4">
      {/* 1. HERO */}
      <section className="relative mb-16 overflow-hidden rounded-2xl border border-white/10 bg-neutral-950">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/home/hero/ripped-packs/pokemon.webp"
          alt=""
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 h-full w-full object-cover opacity-60 blur-[44px] saturate-[1.6] animate-[heroBlob_18s_ease-in-out_infinite] motion-reduce:animate-none"
        />
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-neutral-950/80 via-neutral-950/70 to-neutral-950/95" />
        <div className="relative px-6 py-16 text-center sm:px-10 sm:py-20 lg:py-24">
          <Reveal className="mb-5 flex justify-center">
            <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[12px] font-medium text-white/70">
              <span
                className="h-1.5 w-1.5 rounded-full bg-buyback"
                aria-hidden
              />{' '}
              Graded cards, real buyback
            </span>
          </Reveal>
          <Reveal
            as="h1"
            className="mx-auto max-w-3xl font-heading text-4xl font-bold leading-[1.05] tracking-tight text-white sm:text-5xl lg:text-6xl"
          >
            The Infrastructure for{' '}
            <span className="text-neutral-500">Digital Collectibles</span>
          </Reveal>
          <Reveal
            as="p"
            delay={90}
            className="mx-auto mt-5 max-w-xl text-sm leading-relaxed text-white/65 sm:text-base"
          >
            Buy digital packs backed by real physical cards. Instantly reveal,
            securely vault, and ship or sell whenever you want.
          </Reveal>
          <Reveal
            delay={180}
            className="mt-9 flex flex-wrap items-center justify-center gap-3"
          >
            <Link
              href="/slots"
              className="inline-flex items-center justify-center rounded-2xl bg-white px-7 py-3 text-sm font-semibold text-neutral-950 shadow-lg transition-colors duration-300 hover:bg-white/90"
            >
              Explore Packs
            </Link>
            <a
              href="#launch"
              className="inline-flex items-center justify-center rounded-2xl border border-white/15 bg-white/5 px-7 py-3 text-sm font-semibold text-white transition-colors duration-300 hover:bg-white/10"
            >
              Launch With Us
            </a>
          </Reveal>
        </div>
      </section>

      {/* 2. HOW IT WORKS */}
      <section className="mb-16">
        <Reveal>
          <SectionHeading
            title="How It Works"
            sub="From purchase to ownership in four simple steps."
          />
        </Reveal>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((s, i) => {
            const Icon = s.icon;
            return (
              <Reveal key={s.title} delay={i * 90} className="h-full">
                <div className="flex h-full flex-col rounded-2xl border border-white/10 bg-white/[0.03] p-6 transition-colors duration-300 hover:border-white/20">
                  <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-white/15 to-white/5 text-white">
                    <Icon className="h-5 w-5" aria-hidden />
                  </div>
                  <h3 className="mb-2 font-heading text-sm font-semibold text-white">
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
      </section>

      {/* 3. PLATFORM FEATURES */}
      <section className="mb-16">
        <Reveal>
          <SectionHeading
            title="Platform Features"
            sub="Everything you need to collect, trade, and grow."
          />
        </Reveal>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {FEATURES.map((f, i) => {
            const Icon = f.icon;
            return (
              <Reveal key={f.label} delay={i * 90} className="h-full">
                <div className="flex h-full flex-col rounded-2xl border border-white/10 bg-gradient-to-br from-white/[0.07] to-white/[0.02] p-6 transition-colors duration-300 hover:border-white/20">
                  <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl bg-white/10 text-white">
                    <Icon className="h-5 w-5" aria-hidden />
                  </div>
                  <div className="font-heading text-3xl font-bold text-white">
                    {f.stat}
                  </div>
                  <div className="mb-2 mt-1 text-[11px] uppercase tracking-wide text-white/50">
                    {f.label}
                  </div>
                  <p className="text-[13px] leading-relaxed text-white/55">
                    {f.body}
                  </p>
                </div>
              </Reveal>
            );
          })}
        </div>
      </section>

      {/* 4. LAUNCH WITH US */}
      <div id="launch" className="scroll-mt-24" />
      <Reveal
        as="section"
        className="mb-16 overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-br from-white/[0.06] to-transparent p-8 sm:p-10"
      >
        <div className="grid gap-8 md:grid-cols-2 md:items-center">
          <div>
            <p className="mb-2 text-[11px] font-medium uppercase tracking-widest text-white/60">
              For Brands
            </p>
            <h2 className="font-heading text-2xl font-bold tracking-tight text-white sm:text-3xl">
              Launch With Us
            </h2>
            <p className="mt-3 max-w-md text-sm leading-relaxed text-white/60">
              Power your brand with our complete infrastructure. Custom
              branding, payment processing, vault storage, and worldwide
              fulfillment.
            </p>
            <div className="mt-6 flex gap-8">
              <div>
                <div className="font-heading text-2xl font-bold text-white">
                  520K+
                </div>
                <div className="text-[11px] uppercase tracking-wide text-white/50">
                  Units sold
                </div>
              </div>
              <div>
                <div className="font-heading text-2xl font-bold text-white">
                  5+
                </div>
                <div className="text-[11px] uppercase tracking-wide text-white/50">
                  Brand partners
                </div>
              </div>
            </div>
          </div>
          <div className="rounded-2xl border border-white/10 bg-neutral-950 p-6">
            <p className="mb-3 text-[11px] font-medium uppercase tracking-widest text-white/60">
              Featured Partner
            </p>
            <h3 className="font-heading text-xl font-bold text-white">
              Zardo Cards
            </h3>
            <p className="mt-2 text-[13px] leading-relaxed text-white/55">
              One of the largest online Pokemon stores, now offering digital
              pack breaks powered by Polycards.
            </p>
          </div>
        </div>
      </Reveal>

      {/* 5. VAULT & SECURITY */}
      <section className="mb-16">
        <Reveal>
          <SectionHeading
            title="Vault & Security"
            sub="Top-tier insured US facilities, managed by industry professionals."
          />
        </Reveal>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {VAULT_CARDS.map((c, i) => {
            const Icon = c.icon;
            return (
              <Reveal key={c.title} delay={i * 90} className="h-full">
                <div className="flex h-full flex-col rounded-2xl border border-white/10 bg-white/[0.03] p-6 transition-colors duration-300 hover:border-white/20">
                  <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-white/15 to-white/5 text-white">
                    <Icon className="h-5 w-5" aria-hidden />
                  </div>
                  <h3 className="mb-2 font-heading text-sm font-semibold text-white">
                    {c.title}
                  </h3>
                  <p className="text-[13px] leading-relaxed text-white/55">
                    {c.body}
                  </p>
                </div>
              </Reveal>
            );
          })}
        </div>
        <Reveal className="mt-8 flex flex-wrap items-center justify-center gap-8 opacity-70">
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

      {/* 6. START COLLECTING */}
      <Reveal
        as="section"
        className="mb-8 overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-b from-white/[0.06] to-transparent px-6 py-14 text-center sm:py-16"
      >
        <h2 className="font-heading text-2xl font-bold tracking-tight text-white sm:text-3xl lg:text-4xl">
          Start Collecting
        </h2>
        <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-white/60">
          Open packs, build your collection, and trade globally — or create your
          own branded collectibles experience.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <Link
            href="/slots"
            className="inline-flex items-center justify-center rounded-2xl bg-white/90 px-8 py-3 text-sm font-semibold text-neutral-950 shadow-lg transition-colors duration-300 hover:bg-white"
          >
            For Collectors
          </Link>
          <a
            href="mailto:hello@pokenic.com"
            className="inline-flex items-center justify-center rounded-2xl border border-white/15 bg-white/5 px-8 py-3 text-sm font-semibold text-white transition-colors duration-300 hover:bg-white/10"
          >
            For Brands
          </a>
        </div>
        <p className="mt-5 text-[13px] text-white/50">
          Reach out to{' '}
          <a
            href="mailto:hello@pokenic.com"
            className="text-white/70 underline-offset-2 hover:underline"
          >
            hello@pokenic.com
          </a>
        </p>
      </Reveal>
    </div>
  );
}
