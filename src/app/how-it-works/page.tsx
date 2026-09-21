import type { Metadata } from 'next';
import Link from 'next/link';
import {
  Vault,
  ShieldCheck,
  Thermometer,
  Truck,
  Layers,
  Trophy,
  type LucideIcon,
} from 'lucide-react';
import FaqAccordion, { type FaqItem } from '@/components/FaqAccordion';
import Reveal from '@/components/Reveal';
import HowItWorksSteps from '@/components/HowItWorksSteps';
import HeroVideo from '@/components/HeroVideo';
import { BUYBACK_EXPLANATION, BUYBACK_RATE_LABEL } from '@/lib/buyback-copy';

export const metadata: Metadata = {
  title: 'How It Works',
  description: `Open packs of real graded cards, own them instantly, and ship to your door or sell from your vault at ${BUYBACK_RATE_LABEL} of card value.`,
};

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

type Capability = { icon: LucideIcon; title: string; body: string };
// Only what the storefront actually ships — the marketplace and games cards
// were removed with their routes. Don't advertise what isn't there.
const CAPABILITIES: Capability[] = [
  {
    icon: Layers,
    title: 'Open Packs',
    body: 'Hundreds of Pokémon packs. New drops every week.',
  },
  {
    icon: Trophy,
    title: 'Leaderboard',
    body: 'Rip packs to climb the weekly leaderboard. Top collectors win prizes and exclusive rewards.',
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
    a: BUYBACK_EXPLANATION,
  },
  {
    q: 'How are pulls determined? Is it fair?',
    a: 'Cards are selected on the server using a cryptographically secure random draw and the applicable pack odds. Review the odds before opening. Independent per-pull verification is not available yet: we do not currently publish the proof data needed to reproduce an individual result yourself. See the fairness page for the current availability notice.',
  },
  {
    q: 'Where are my cards stored?',
    a: 'Cards are stored in climate-controlled, fully insured vault facilities operated by PSA, Fanatics, and Alt. These are the same facilities used by major auction houses and institutional collectors. Your cards are protected around the clock.',
  },
  {
    q: 'Can I sell my cards?',
    a: `Eligible cards in your vault sell back for ${BUYBACK_RATE_LABEL} of card value. The pack's displayed instant rate is available during the reveal countdown only. Buyback pays site credit immediately; bank withdrawal has separate eligibility requirements.`,
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
      {/* 1. HERO — wordings and pack each animate in (staggered) */}
      <section className="relative mb-6 overflow-hidden rounded-2xl border border-white/10 bg-neutral-950">
        {/* decorative blurred blob (static, not animated-in) */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/images/polycards/gold-pack.webp"
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
              your door or sell from your vault at {BUYBACK_RATE_LABEL} of card
              value.
            </Reveal>
            <Reveal delay={270} className="mt-6 flex flex-wrap gap-3">
              <Link
                href="/slots"
                className="inline-flex items-center justify-center rounded-2xl bg-white/90 px-7 py-3 text-sm font-semibold text-neutral-950 shadow-lg transition-colors duration-300 hover:bg-white"
              >
                Open Your First Pack
              </Link>
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
            mp4="/videos/pack-opening-demo.mp4"
            webm="/videos/pack-opening-demo.webm"
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
            NOT the discrete feature-card grid section 5 uses — the two benefit
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
      </section>

      {/* 5. WHAT YOU CAN DO */}
      <section className="mb-16">
        <Reveal>
          <SectionHeading
            title="What You Can Do"
            sub="Everything you need to collect, compete, and cash out"
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

      {/* 6. FAQ. #faq is linked from /contact */}
      <section id="faq" className="mb-16 scroll-mt-24">
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

      {/* 7. CTA */}
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
