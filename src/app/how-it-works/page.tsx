import type { Metadata } from 'next';
import Link from 'next/link';
import Image from 'next/image';
import { features } from '@/lib/features';
import {
  Vault,
  ShieldCheck,
  Thermometer,
  Truck,
  Layers,
  Store,
  Gamepad2,
  Trophy,
  type LucideIcon,
} from 'lucide-react';
import FaqAccordion, { type FaqItem } from '@/components/FaqAccordion';
import Reveal from '@/components/Reveal';
import HowItWorksSteps from '@/components/HowItWorksSteps';
import HeroVideo from '@/components/HeroVideo';
import { DEMO_STATS } from '@/lib/demo-stats';

export const metadata: Metadata = {
  title: 'How It Works',
  description:
    'Open packs of real graded cards, own them instantly, and ship to your door or sell back at up to 90% of market value.',
};

const STATS = [
  { value: DEMO_STATS.transactions, label: 'Transactions' },
  { value: DEMO_STATS.volume, label: 'Volume traded' },
  { value: DEMO_STATS.listings, label: 'Active listings' },
];

type VaultCard = { icon: LucideIcon; title: string; body: string };
const VAULT_CARDS: VaultCard[] = [
  {
    icon: Vault,
    title: 'Choose Your Vault',
    body: 'Cards stored at PSA, Alt, or Fanatics facilities',
  },
  {
    icon: ShieldCheck,
    title: 'Fully Insured',
    body: 'Complete coverage on every card from day one',
  },
  {
    icon: Thermometer,
    title: 'Climate Controlled',
    body: 'Optimal conditions for long-term preservation',
  },
  {
    icon: Truck,
    title: 'Ship Anytime',
    body: 'Redeem your cards with worldwide tracked delivery',
  },
];

const VAULT_LOGOS = [
  { src: '/images/psa.png', alt: 'PSA' },
  { src: '/images/fanatics.png', alt: 'Fanatics' },
  { src: '/images/altwhite.png', alt: 'Alt' },
];

type Testimonial = {
  name: string;
  handle: string;
  text: string;
  pfp: string;
  media: string;
};
const TESTIMONIALS: Testimonial[] = [
  {
    name: 'Mikerow',
    handle: '@Mikerow01',
    text: 'LFG my claim from @pokenic came it look how nice those slabs are. Thank you again one love',
    pfp: '/social/pfp/Mikerow01-400x400.jpg',
    media: '/social/tweets/1940199479699022263_media-1.webp',
  },
  {
    name: 'Lynch',
    handle: '@_LYNCHY__',
    text: 'Digital to physical in just under 2 weeks super cool! Thanks @pokenic for creating unique way to trade!',
    pfp: '/social/pfp/_LYNCHY__-400x400.jpg',
    media: '/social/tweets/1937209444800004323_media-1.webp',
  },
  {
    name: 'James Pleiades Hawkins',
    handle: '@PleiadesHawkin',
    text: 'Mail day here in the gallery. @pokenic made it REAL!!',
    pfp: '/social/pfp/PleiadesHawkin-400x400.jpg',
    media: '/social/tweets/1959021922383274245_media-1.webp',
  },
];

type Capability = { icon: LucideIcon; title: string; body: string };
// Marketplace/games cards only show while their feature flags are on — the
// page must not advertise features the deploy has gated off.
const CAPABILITIES: Capability[] = [
  {
    icon: Layers,
    title: 'Open Packs',
    body: 'Hundreds of Pokémon packs. New drops every week.',
  },
  ...(features.marketplace
    ? [
        {
          icon: Store,
          title: 'Marketplace',
          body: 'Buy and sell cards with other collectors. Real cards, real ownership, instant transfers.',
        },
      ]
    : []),
  ...(features.packParty
    ? [
        {
          icon: Gamepad2,
          title: 'Games',
          body: 'Pack Party, Duel, Draft. Compete with friends and other collectors for real cards.',
        },
      ]
    : []),
  {
    icon: Trophy,
    title: 'Leaderboard',
    body: 'Earn points on every purchase. Top collectors win weekly prizes and exclusive rewards.',
  },
];

const FAQS: FaqItem[] = [
  {
    q: 'Are these real physical cards?',
    a: 'Yes. Every card on Polycards is a real, professionally graded physical card stored in secure vault facilities. When you open a pack, you receive ownership of a specific physical slab that exists in a PSA, Fanatics, or Alt vault. You can ship it to your door at any time.',
  },
  {
    q: 'How does shipping work?',
    a: 'When you request a shipment, your card is pulled from the vault, carefully packaged, and shipped via fully tracked and insured delivery. We ship worldwide, and most domestic orders arrive within 5-7 business days. International shipping typically takes 10-14 days.',
  },
  {
    q: "What if I don't like my pull?",
    // Marketplace copy only while the flag is on (see CAPABILITIES above).
    a: features.marketplace
      ? 'You can sell any card back instantly for 85-90% of its market value, or list it on the marketplace at your own price. Many collectors also trade cards with each other directly on the platform.'
      : 'You can sell any card back instantly for 85-90% of its market value — the credit lands on your balance immediately, ready for the next rip.',
  },
  {
    q: 'How are pulls determined? Is it fair?',
    a: 'Every pull is determined by a provably fair system: each result is committed to before the pull and verifiable afterwards (commit-reveal). The odds for each pack are published transparently, and every result can be independently checked. No one, including us, can influence the outcome.',
  },
  {
    q: 'Where are my cards stored?',
    a: 'Cards are stored in climate-controlled, fully insured vault facilities operated by PSA, Fanatics, and Alt. These are the same facilities used by major auction houses and institutional collectors. Your cards are protected around the clock.',
  },
  {
    q: 'Can I sell my cards?',
    // Marketplace copy only while the flag is on (see CAPABILITIES above).
    a: features.marketplace
      ? 'Absolutely. You can list any card on the Polycards marketplace and set your own price. When it sells, funds are available immediately. You can also use the instant sell-back feature for a guaranteed payout at 85-90% of market value.'
      : 'Absolutely. Every card comes with an instant sell-back at 85-90% of its market value — a guaranteed payout, with funds available immediately.',
  },
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

export default function HowItWorksPage() {
  return (
    <div className="mx-auto w-full px-fluid py-4">
      {/* 1. HERO — wordings, pack, and stats each animate in (staggered) */}
      <section className="relative mb-6 overflow-hidden rounded-2xl border border-white/10 bg-neutral-950">
        {/* decorative blurred blob (static, not animated-in) */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/home/hero/ripped-packs/pokemon.webp"
          alt=""
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 h-full w-full object-cover opacity-70 blur-[40px] saturate-[1.7] will-change-transform animate-[heroBlob_18s_ease-in-out_infinite] motion-reduce:animate-none motion-reduce:will-change-auto"
        />
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-neutral-950/90 via-neutral-950/55 to-neutral-950/20" />
        <div className="relative flex flex-col gap-8 px-6 py-12 sm:px-10 md:flex-row md:items-center md:py-16 2xl:px-16 2xl:py-20">
          <div className="flex-[1.2]">
            <Reveal
              as="p"
              delay={0}
              className="mb-3 text-[11px] font-medium uppercase tracking-widest text-white/60 lg:text-[13px]"
            >
              Built for collectors, backed by graded-card buyback
            </Reveal>
            <Reveal
              as="h1"
              delay={90}
              className="font-heading text-4xl font-bold leading-[1.05] tracking-tight text-white sm:text-5xl lg:text-6xl 2xl:text-7xl"
            >
              Real Cards,{' '}
              <span className="text-neutral-500">Owned Digitally</span>
            </Reveal>
            <Reveal
              as="p"
              delay={180}
              className="mt-4 max-w-lg text-sm leading-relaxed text-white/65 sm:text-base 2xl:text-lg"
            >
              Open packs of real graded cards, own them instantly, and ship to
              your door or sell back at up to 90% of market value.
            </Reveal>
            <Reveal delay={270} className="mt-6 flex flex-wrap gap-3">
              <Link
                href="/slots"
                className="inline-flex items-center justify-center rounded-2xl bg-white/90 px-7 py-3 text-sm font-semibold text-neutral-950 shadow-lg transition-colors duration-300 hover:bg-white"
              >
                Start Opening Packs
              </Link>
              {features.marketplace && (
                <a
                  href="/marketplace"
                  className="inline-flex items-center justify-center rounded-2xl border border-white/15 bg-white/5 px-7 py-3 text-sm font-semibold text-white transition-colors duration-300 hover:bg-white/10"
                >
                  Browse the marketplace
                </a>
              )}
            </Reveal>
          </div>
          {/* pack fan slides/scales in — matches the live site: a center Trainer pack
              flanked by two faded, smaller packs (platinum left, diamond right). */}
          <Reveal
            delay={200}
            y={32}
            className="relative flex flex-1 items-center justify-center"
          >
            <div className="relative h-[280px] w-full max-w-[360px] 2xl:h-[340px] 2xl:max-w-[440px]">
              {/* left pack — behind, faded */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/images/polycards/platinum-pack.webp"
                alt=""
                aria-hidden="true"
                className="absolute bottom-[8%] left-[32%] z-0 h-[72%] w-auto -translate-x-1/2 object-contain opacity-50 drop-shadow-[0_20px_60px_rgba(0,0,0,0.5)]"
              />
              {/* right pack — behind, faded */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/images/polycards/diamond-pack.webp"
                alt=""
                aria-hidden="true"
                className="absolute bottom-[8%] left-[68%] z-0 h-[72%] w-auto -translate-x-1/2 object-contain opacity-50 drop-shadow-[0_20px_60px_rgba(0,0,0,0.5)]"
              />
              {/* center pack — front */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/images/polycards/bronze-pack.webp"
                alt="Polycards trading card pack"
                className="absolute bottom-0 left-1/2 z-[2] h-[92%] w-auto -translate-x-1/2 object-contain drop-shadow-[0_30px_80px_rgba(0,0,0,0.6)]"
              />
            </div>
          </Reveal>
        </div>
        {/* stats bar — each stat staggers in */}
        <div className="relative grid grid-cols-3 border-t border-white/10">
          {STATS.map((s, i) => (
            <Reveal
              key={s.label}
              delay={350 + i * 110}
              className="px-4 py-5 text-center 2xl:py-7"
            >
              <div className="font-heading text-xl font-bold text-white sm:text-2xl lg:text-3xl 2xl:text-4xl">
                {s.value}
              </div>
              <div className="mt-1 text-[11px] uppercase tracking-wide text-white/50 sm:text-xs">
                {s.label}
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* 2. HOW IT WORKS — 3 steps */}
      <section className="mb-16 mt-16">
        <Reveal>
          <SectionHeading
            title="How It Works"
            sub="From purchase to ownership in three simple steps."
          />
        </Reveal>
        <HowItWorksSteps />
      </section>

      {/* 3. SEE IT IN ACTION — full-width autoplaying pack-opening video (matches live) */}
      <Reveal as="section" className="mb-16">
        <SectionHeading
          title="See It in Action"
          sub="Watch a pack opening from start to finish."
        />
        <div className="relative aspect-video w-full overflow-hidden rounded-2xl border border-white/10 bg-neutral-950 shadow-[0_8px_40px_rgba(0,0,0,0.45)]">
          <HeroVideo
            src="/videos/pack-opening-demo.mp4"
            poster="/images/polycards/bronze-pack.webp"
            label="Pack opening demo"
            className="h-full w-full object-cover"
          />
        </div>
      </Reveal>

      {/* 4. VAULT & SECURITY */}
      <section className="mb-16">
        <Reveal>
          <SectionHeading
            title="Vault & Security"
            sub="Every card is stored in insured, climate-controlled facilities managed by industry leaders."
          />
        </Reveal>
        {/* One grouped guarantee panel (hairline-divided cells), deliberately
            NOT the discrete feature-card grid section 6 uses — the two benefit
            sections must not read as the same component twice. A gap-px grid
            over a hairline-tinted container paints the dividers without the
            divide-x/-y-on-grid stray-border gotcha; the panel reveals as one
            unit rather than four staggered cards. */}
        <Reveal>
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-white/10 bg-white/10 lg:grid-cols-4">
            {VAULT_CARDS.map((c) => {
              const Icon = c.icon;
              return (
                <div
                  key={c.title}
                  className="flex flex-col gap-2 bg-neutral-900 p-5 sm:p-6"
                >
                  <Icon className="h-5 w-5 text-white/80" aria-hidden />
                  <h3 className="font-heading text-sm font-semibold text-white">
                    {c.title}
                  </h3>
                  <p className="text-[13px] leading-relaxed text-white/60">
                    {c.body}
                  </p>
                </div>
              );
            })}
          </div>
        </Reveal>
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

      {/* 5. TESTIMONIALS */}
      <section className="mb-16">
        <Reveal>
          <SectionHeading
            title="What Collectors Are Saying"
            sub="Real feedback from the Polycards community."
          />
        </Reveal>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {TESTIMONIALS.map((t, i) => (
            <Reveal key={t.handle} delay={i * 110} className="h-full">
              <div className="flex h-full flex-col overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03] transition-colors duration-300 hover:border-white/20">
                <div className="relative h-44 w-full">
                  <Image
                    src={t.media}
                    alt={`Photo shared by ${t.name}`}
                    fill
                    sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
                    className="object-cover"
                  />
                </div>
                <div className="flex flex-1 flex-col gap-3 p-5">
                  <p className="flex-1 text-[13px] leading-relaxed text-white/75">
                    {t.text}
                  </p>
                  <div className="flex items-center gap-3">
                    <Image
                      src={t.pfp}
                      alt={t.name}
                      width={32}
                      height={32}
                      className="h-8 w-8 rounded-full object-cover"
                    />
                    <div className="leading-tight">
                      <div className="text-[13px] font-semibold text-white">
                        {t.name}
                      </div>
                      <div className="text-[11px] text-white/50">
                        {t.handle}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* 6. WHAT YOU CAN DO */}
      <section className="mb-16">
        <Reveal>
          <SectionHeading
            title="What You Can Do"
            sub="Everything you need to collect, compete, and trade"
          />
        </Reveal>
        {/* Discrete feature cards, 2-up and width-capped with the icon set
            BESIDE the copy (horizontal) — a different structure and measure
            from the full-bleed vault guarantee panel above, so the two benefit
            sections don't rhyme. The narrower column also funnels the page
            inward toward the FAQ/CTA. */}
        <div className="mx-auto grid max-w-4xl grid-cols-1 gap-4 sm:grid-cols-2">
          {CAPABILITIES.map((c, i) => {
            const Icon = c.icon;
            return (
              <Reveal key={c.title} delay={i * 90} className="h-full">
                <div className="flex h-full items-start gap-4 rounded-2xl border border-white/10 bg-gradient-to-br from-white/[0.07] to-white/[0.02] p-6 transition-colors duration-300 hover:border-white/20">
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-white/10 text-white">
                    <Icon className="h-5 w-5" aria-hidden />
                  </div>
                  <div>
                    <h3 className="font-heading text-lg font-bold text-white">
                      {c.title}
                    </h3>
                    <p className="mt-1.5 text-[13px] leading-relaxed text-white/60">
                      {c.body}
                    </p>
                  </div>
                </div>
              </Reveal>
            );
          })}
        </div>
      </section>

      {/* 7. FAQ */}
      <section className="mb-16">
        <Reveal>
          <SectionHeading
            title="Frequently Asked Questions"
            sub="Everything you need to know before you rip."
          />
        </Reveal>
        <Reveal className="mx-auto max-w-3xl">
          <FaqAccordion items={FAQS} />
        </Reveal>
      </section>

      {/* 8. CTA */}
      <Reveal
        as="section"
        className="mb-8 overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-b from-white/[0.06] to-transparent px-6 py-14 text-center sm:py-16"
      >
        <h2 className="font-heading text-2xl font-bold tracking-tight text-white sm:text-3xl lg:text-4xl">
          Ready to start collecting?
        </h2>
        <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-white/60">
          Join the collectors opening packs and pulling real graded cards every
          day.
        </p>
        <Link
          href="/slots"
          className="mt-6 inline-flex items-center justify-center rounded-2xl bg-white/90 px-8 py-3 text-sm font-semibold text-neutral-950 shadow-lg transition-colors duration-300 hover:bg-white"
        >
          Open Your First Pack
        </Link>
      </Reveal>
    </div>
  );
}
