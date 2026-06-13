import type { Metadata } from 'next';
import { MessageCircle, Vault, HelpCircle, ChevronRight } from 'lucide-react';
import Reveal from '@/components/Reveal';

export const metadata: Metadata = {
  title: 'Contact — Phygitals',
  description:
    'How can we help? Our team typically responds within a few minutes.',
};

const VAULTS = [
  {
    name: 'Vault 1',
    status: 'Operational',
    note: '5–7 day processing',
    ok: true,
  },
  {
    name: 'Vault 2',
    status: 'Operational',
    note: '5–7 day processing',
    ok: true,
  },
  {
    name: 'Vault 3',
    status: 'Operational',
    note: '7–10 day processing',
    ok: true,
  },
];

const FAQS = [
  "Why is my card showing 'In Transit'?",
  "Why is my order still 'Processing'?",
  'How long does it take to receive cards after claiming?',
  "Why hasn't my submitted card appeared in my inventory yet?",
  'What grading companies do you accept?',
  'How do I track my shipment?',
];

export default function ContactPage() {
  return (
    <div className="mx-auto w-full max-w-5xl px-fluid py-4">
      {/* 1. HERO */}
      <section className="relative mb-8 overflow-hidden rounded-2xl border border-white/10 bg-neutral-950 px-6 py-14 text-center sm:py-16">
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-white/[0.05] to-transparent" />
        <Reveal
          as="h1"
          className="relative font-heading text-3xl font-bold tracking-tight text-white sm:text-4xl lg:text-5xl"
        >
          How can we help?
        </Reveal>
        <Reveal
          as="p"
          delay={90}
          className="relative mx-auto mt-3 max-w-md text-sm leading-relaxed text-white/60 sm:text-base"
        >
          Our team typically responds within a few minutes.
        </Reveal>
        <Reveal delay={160} className="relative mt-6">
          <a
            href="mailto:hello@phygitals.com"
            className="inline-flex items-center justify-center gap-2 rounded-2xl bg-white/90 px-7 py-3 text-sm font-semibold text-neutral-950 shadow-lg transition-colors duration-300 hover:bg-white"
          >
            <MessageCircle className="h-4 w-4" aria-hidden />
            Start a conversation
          </a>
        </Reveal>
      </section>

      {/* 2. VAULT STATUS + FAQ */}
      <div className="grid gap-4 md:grid-cols-2">
        {/* Vault status */}
        <Reveal className="h-full">
          <div className="flex h-full flex-col rounded-2xl border border-white/10 bg-white/[0.03] p-6">
            <div className="mb-1 flex items-center gap-2.5">
              <Vault className="h-5 w-5 text-white/70" aria-hidden />
              <h2 className="font-heading text-lg font-bold tracking-tight text-white">
                Vault Status
              </h2>
            </div>
            <p className="mb-5 text-[13px] text-white/45">
              Current processing &amp; shipping times
            </p>
            <ul className="flex flex-col gap-2.5">
              {VAULTS.map((v) => (
                <li
                  key={v.name}
                  className="flex items-center justify-between rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3"
                >
                  <div className="flex items-center gap-2.5">
                    <span className="relative flex h-2.5 w-2.5">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400/60 motion-reduce:animate-none" />
                      <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-400" />
                    </span>
                    <span className="text-sm font-medium text-white">
                      {v.name}
                    </span>
                  </div>
                  <div className="text-right">
                    <div className="text-[13px] font-medium text-emerald-400">
                      {v.status}
                    </div>
                    <div className="text-[11px] text-white/40">{v.note}</div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </Reveal>

        {/* FAQ shortcuts */}
        <Reveal delay={90} className="h-full">
          <div className="flex h-full flex-col rounded-2xl border border-white/10 bg-white/[0.03] p-6">
            <div className="mb-1 flex items-center gap-2.5">
              <HelpCircle className="h-5 w-5 text-white/70" aria-hidden />
              <h2 className="font-heading text-lg font-bold tracking-tight text-white">
                FAQ
              </h2>
            </div>
            <p className="mb-5 text-[13px] text-white/45">
              Common questions answered
            </p>
            <ul className="flex flex-col gap-1.5">
              {FAQS.map((q) => (
                <li key={q}>
                  <a
                    href="/how-it-works"
                    className="group flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 text-left text-[13px] font-medium text-white/80 transition-colors hover:border-white/20 hover:bg-white/[0.06] hover:text-white"
                  >
                    {q}
                    <ChevronRight
                      className="h-4 w-4 shrink-0 text-white/30 transition-transform group-hover:translate-x-0.5 group-hover:text-white/60"
                      aria-hidden
                    />
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </Reveal>
      </div>
    </div>
  );
}
