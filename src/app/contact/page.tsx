import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight, ArrowUpRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import Reveal from '@/components/Reveal';
import { pillVariants } from '@/components/ui/pill';
import { BUYBACK_RATE_LABEL } from '@/lib/buyback-copy';

export const metadata: Metadata = {
  title: 'Contact',
  description:
    'No ticket forms, no bots. Message the Polycards team on Telegram, Instagram, or Facebook — replies within a day.',
};

// Support is chat-only by design: no support email, no contact form.
const SOCIALS = [
  {
    label: 'Instagram',
    handle: '@POLYCARDS.GG',
    copy: 'Pull highlights, drops, and DMs.',
    href: 'https://www.instagram.com/polycards.gg',
  },
  {
    label: 'Facebook',
    handle: 'POLYCARDS.GG',
    copy: 'News, events, and messages.',
    href: 'https://www.facebook.com/polycards.gg/',
  },
] as const;

const QUICK_ANSWERS = [
  {
    num: '01',
    title: 'SHIPPING',
    copy: 'Your vault ships worldwide the moment you ask it to.',
    href: '/how-it-works',
  },
  {
    num: '02',
    title: 'BUYBACK',
    copy: (
      <>
        Every card sells back instantly at{' '}
        <span className="text-buyback-fg font-semibold">
          {BUYBACK_RATE_LABEL}
        </span>
        . No buyer needed.
      </>
    ),
    href: '/how-it-works#faq',
  },
  {
    num: '03',
    title: 'FAIR PULLS',
    copy: 'Every rip is provably fair. Check the math yourself.',
    href: '/fairness',
  },
] as const;

export default function ContactPage() {
  return (
    <div className="px-fluid mx-auto w-full max-w-5xl py-4">
      {/* 01 — hero lockup */}
      <section
        aria-labelledby="contact-heading"
        className="flex flex-col items-center py-14 text-center sm:py-16"
      >
        <Reveal
          as="p"
          className="text-[11px] font-semibold uppercase tracking-[0.3em] text-neutral-400"
        >
          Live humans · Replies within a day
        </Reveal>
        <Reveal delay={60}>
          <h1
            id="contact-heading"
            className="font-heading mt-4 text-5xl leading-[0.95] text-white lg:text-7xl"
          >
            SAY THE
            <br />
            WORD.
          </h1>
        </Reveal>
        <Reveal
          as="p"
          delay={120}
          className="mt-5 max-w-md text-[15px] leading-relaxed text-neutral-300"
        >
          No ticket forms, no bots, no inbox black hole. Message the team where
          you already hang out.
        </Reveal>
        <Reveal
          delay={180}
          className="mt-8 flex flex-wrap justify-center gap-3"
        >
          <a
            href="https://t.me/polycardsgg"
            target="_blank"
            rel="noopener noreferrer"
            className={cn(pillVariants({ variant: 'primary', size: 'lg' }))}
          >
            Message us on Telegram
            <ArrowUpRight className="h-4 w-4" aria-hidden />
          </a>
          <Link
            href="/how-it-works#faq"
            className={cn(pillVariants({ variant: 'ghost', size: 'lg' }))}
          >
            Read the FAQ
          </Link>
        </Reveal>
      </section>

      {/* 02 — channels: Telegram is the featured line, socials ride beside */}
      <section aria-labelledby="channels-heading" className="w-full">
        <h2 id="channels-heading" className="font-heading text-2xl text-white">
          PICK YOUR LINE
        </h2>
        <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-5">
          <Reveal className="lg:col-span-3">
            <a
              href="https://t.me/polycardsgg"
              target="_blank"
              rel="noopener noreferrer"
              className="group flex h-full flex-col justify-between gap-8 rounded-2xl border border-white/10 bg-neutral-900 p-6 transition-colors hover:border-white/25"
            >
              <div className="flex items-baseline justify-between gap-3">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
                  Telegram · The fast line
                </p>
                <ArrowUpRight
                  className="h-4 w-4 shrink-0 text-neutral-500 transition-colors group-hover:text-white"
                  aria-hidden
                />
              </div>
              <div>
                <p className="font-heading text-4xl leading-none text-white sm:text-5xl">
                  @POLYCARDSGG
                </p>
                <p className="mt-3 max-w-sm text-[13px] leading-relaxed text-neutral-400">
                  Straight line to the team — order trouble, shipping, buyback,
                  anything. First reply usually lands the same day.
                </p>
              </div>
            </a>
          </Reveal>
          <div className="flex flex-col gap-3 lg:col-span-2">
            {SOCIALS.map((s, i) => (
              <Reveal key={s.label} delay={(i + 1) * 90} className="flex-1">
                <a
                  href={s.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group flex h-full flex-col justify-between gap-4 rounded-2xl border border-white/10 bg-neutral-900 p-5 transition-colors hover:border-white/25"
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
                      {s.label}
                    </p>
                    <ArrowUpRight
                      className="h-4 w-4 shrink-0 text-neutral-500 transition-colors group-hover:text-white"
                      aria-hidden
                    />
                  </div>
                  <div>
                    <p className="font-heading text-xl leading-none text-white">
                      {s.handle}
                    </p>
                    <p className="mt-1.5 text-[13px] leading-relaxed text-neutral-400">
                      {s.copy}
                    </p>
                  </div>
                </a>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* 03 — quick answers: the three questions support hears most, answered
          before the DM (numbered-row idiom, same as /about's how-it-works; each
          row a real link) */}
      <section aria-labelledby="quick-heading" className="mt-14 w-full">
        <div className="flex items-baseline justify-between">
          <h2 id="quick-heading" className="font-heading text-2xl text-white">
            BEFORE YOU PING
          </h2>
          <Link
            href="/how-it-works#faq"
            className="flex min-h-11 items-center gap-1 text-[13px] font-semibold text-neutral-400 transition-colors hover:text-white"
          >
            Full FAQ
            <ArrowRight className="h-3.5 w-3.5" aria-hidden />
          </Link>
        </div>
        <div className="mt-4 flex flex-col gap-3 lg:flex-row">
          {QUICK_ANSWERS.map((q, i) => (
            <Reveal key={q.num} delay={i * 90} className="flex-1">
              <Link
                href={q.href}
                className="group flex h-full items-start gap-4 rounded-2xl border border-white/10 bg-neutral-900 p-4 transition-colors hover:border-white/25"
              >
                <span className="font-heading text-4xl leading-none text-neutral-700 transition-colors group-hover:text-neutral-500">
                  {q.num}
                </span>
                <div>
                  <p className="font-heading text-base text-white">{q.title}</p>
                  <p className="mt-1 text-[13px] leading-relaxed text-neutral-400">
                    {q.copy}
                  </p>
                </div>
              </Link>
            </Reveal>
          ))}
        </div>
      </section>
    </div>
  );
}
