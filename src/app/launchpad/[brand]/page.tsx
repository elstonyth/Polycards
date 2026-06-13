import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ShieldCheck, Zap, Boxes, Repeat } from 'lucide-react';
import Reveal from '@/components/Reveal';
import FaqAccordion, { type FaqItem } from '@/components/FaqAccordion';

type Brand = { name: string; icon: string; tagline: string };
const BRANDS: Record<string, Brand> = {
  fwog: {
    name: 'Fwog',
    icon: '/pack-index-icons/fwog.jpg',
    tagline: 'Next-generation entertainment collectibles',
  },
  neuko: {
    name: 'NEUKO',
    icon: '/pack-index-icons/neuko.jpg',
    tagline: 'Premium drops, blockchain-verified',
  },
  vibes: {
    name: 'Vibes',
    icon: '/pack-index-icons/vibes.webp',
    tagline: 'Good vibes, real collectibles',
  },
  moonbirds: {
    name: 'Moonbirds',
    icon: '/pack-index-icons/moonbirds.png',
    tagline: 'Iconic art, physically backed',
  },
};

export function generateStaticParams() {
  return Object.keys(BRANDS).map((brand) => ({ brand }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ brand: string }>;
}): Promise<Metadata> {
  const { brand } = await params;
  const b = BRANDS[brand];
  return {
    title: b ? `${b.name} Launchpad — Pokenic` : 'Launchpad — Pokenic',
    description: b?.tagline,
  };
}

const TIERS = [
  {
    name: 'Single Box',
    price: '$50',
    contents: '1 sealed box · 1 digital collectible',
  },
  {
    name: 'Collector Pack',
    price: '$250',
    contents: '5 boxes · boosted chase odds',
    popular: true,
  },
  {
    name: 'Whale Pack',
    price: '$1,000',
    contents: '20 boxes · guaranteed grail + perks',
  },
];

const FEATURES = [
  {
    icon: ShieldCheck,
    title: 'Blockchain-verified',
    body: "Every collectible is verifiable on-chain from the moment it's minted.",
  },
  {
    icon: Zap,
    title: 'Minted instantly',
    body: 'Your digital item is created the second you purchase — no waiting.',
  },
  {
    icon: Boxes,
    title: 'Physically backed',
    body: 'Each digital collectible is redeemable for a real, vaulted physical item.',
  },
  {
    icon: Repeat,
    title: 'Trade anytime',
    body: 'List on the marketplace or trade peer-to-peer with zero friction.',
  },
];

export default async function LaunchpadPage({
  params,
}: {
  params: Promise<{ brand: string }>;
}) {
  const { brand } = await params;
  const b = BRANDS[brand];
  if (!b) notFound();

  const faqs: FaqItem[] = [
    {
      q: `What is ${b.name}?`,
      a: `${b.name} is a digital collectible series backed by a real physical item that you can redeem at any time.`,
    },
    {
      q: 'What do I receive with my purchase?',
      a: 'A blockchain-verified digital collectible, minted instantly, plus the physical item shipped to you on request.',
    },
    {
      q: 'When will I receive my physical item?',
      a: 'Redeem whenever you like — physical items ship fully tracked and insured, typically within 5–7 business days.',
    },
    {
      q: `Can I trade my ${b.name} collectible?`,
      a: 'Yes. List it on the Pokenic marketplace or trade peer-to-peer with other collectors instantly.',
    },
  ];

  return (
    <div className="mx-auto w-full px-fluid py-4">
      {/* Hero */}
      <section className="relative mb-12 overflow-hidden rounded-2xl border border-white/10 bg-neutral-950 px-6 py-14 text-center sm:py-20">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_50%_at_50%_0%,rgba(255,255,255,0.08),transparent_70%)]" />
        <div className="relative">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={b.icon}
            alt={b.name}
            className="mx-auto mb-5 h-20 w-20 rounded-2xl object-cover ring-1 ring-white/15"
          />
          <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.25em] text-white/50">
            Launchpad
          </p>
          <h1 className="font-heading text-4xl font-bold tracking-tight text-white sm:text-5xl lg:text-6xl">
            {b.name}
          </h1>
          <p className="mx-auto mt-4 max-w-md text-sm leading-relaxed text-white/65 sm:text-base">
            {b.tagline}
          </p>
        </div>
      </section>

      {/* Tiers */}
      <section className="mb-14 grid grid-cols-1 gap-4 sm:grid-cols-3">
        {TIERS.map((t, i) => (
          <Reveal key={t.name} delay={i * 90} className="h-full">
            <div
              className={`flex h-full flex-col rounded-2xl border p-6 ${t.popular ? 'border-white/25 bg-white/[0.06]' : 'border-white/10 bg-white/[0.03]'}`}
            >
              {t.popular && (
                <span className="mb-3 self-start rounded-full bg-white px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-neutral-950">
                  Popular
                </span>
              )}
              <h3 className="font-heading text-lg font-bold text-white">
                {t.name}
              </h3>
              <p className="mt-1 font-heading text-3xl font-bold text-white">
                {t.price}
              </p>
              <p className="mt-2 flex-1 text-[13px] leading-relaxed text-white/55">
                {t.contents}
              </p>
              <button
                type="button"
                className="mt-5 w-full rounded-xl bg-neutral-200 py-2.5 text-sm font-semibold text-neutral-950 transition-colors hover:bg-white"
              >
                Buy Now
              </button>
            </div>
          </Reveal>
        ))}
      </section>

      {/* Features */}
      <section className="mb-14">
        <Reveal>
          <h2 className="mb-8 text-center font-heading text-2xl font-bold tracking-tight text-white sm:text-3xl">
            Built for What&apos;s Next
          </h2>
        </Reveal>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {FEATURES.map((f, i) => {
            const Icon = f.icon;
            return (
              <Reveal key={f.title} delay={i * 80} className="h-full">
                <div className="flex h-full flex-col rounded-2xl border border-white/10 bg-white/[0.03] p-6">
                  <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-white/15 to-white/5 text-white">
                    <Icon className="h-5 w-5" aria-hidden />
                  </div>
                  <h3 className="mb-1.5 font-heading text-sm font-semibold text-white">
                    {f.title}
                  </h3>
                  <p className="text-[13px] leading-relaxed text-white/55">
                    {f.body}
                  </p>
                </div>
              </Reveal>
            );
          })}
        </div>
      </section>

      {/* FAQ */}
      <section className="mb-8">
        <Reveal>
          <h2 className="mb-8 text-center font-heading text-2xl font-bold tracking-tight text-white sm:text-3xl">
            Frequently Asked Questions
          </h2>
        </Reveal>
        <Reveal className="mx-auto max-w-3xl">
          <FaqAccordion items={faqs} />
        </Reveal>
      </section>
    </div>
  );
}
