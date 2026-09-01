import type { Metadata } from 'next';
import { cache } from 'react';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { getCardResult } from '@/lib/data/cards';
import { CardDetailHydrated } from './CardDetailHydrated';

// Price freshness is the whole point — always render on demand (the 60s
// client refresh takes over after hydration).
export const dynamic = 'force-dynamic';

// Dedupe the lookup across generateMetadata + the page render (one request).
// The param is already percent-decoded by Next's route matcher — a second
// decode threw URIError (→ 500) on a literal `%` where a 404 was meant.
const resolveCard = cache((handle: string) => getCardResult(handle));

export async function generateMetadata({
  params,
}: {
  params: Promise<{ handle: string }>;
}): Promise<Metadata> {
  const { handle } = await params;
  const result = await resolveCard(handle);
  // Metadata must never throw: an error reads the same as a miss here (the page
  // body is what distinguishes them).
  if (result.status !== 'ok') return { title: 'Card not found' };
  const { card } = result;
  return {
    title: card.name,
    description: `${card.set} · ${card.grader} ${card.grade}`,
  };
}

export default async function CardPage({
  params,
  searchParams,
}: {
  params: Promise<{ handle: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { handle } = await params;
  const result = await resolveCard(handle);
  // `?prize=weekly` marks an arrival from the Weekly Pulled Value Challenge, so
  // the card keeps the challenge's prism frame here instead of switching to its
  // pack tier — a prize should still read as a prize when you open it. Any
  // other value (or none) renders the tier frame as usual.
  const { prize } = await searchParams;
  const frameVariant = prize === 'weekly' ? ('prism' as const) : undefined;
  // A transient backend failure must NOT 404: this card may well exist (and be
  // owned by whoever bookmarked it). Only a genuine miss gets notFound().
  if (result.status === 'error') {
    return (
      <div className="mx-auto w-full px-fluid py-16">
        <div className="mx-auto max-w-md rounded-2xl border border-white/10 bg-neutral-900 px-6 py-12 text-center">
          <h1 className="font-heading text-2xl text-white">
            Couldn&apos;t load this card
          </h1>
          <p className="mt-2 text-sm text-neutral-400">
            Something went wrong on our end. Please try again in a moment.
          </p>
          {/* Plain anchor, not Link: a full request re-runs this dynamic page
              instead of a soft nav that can serve the cached error render. */}
          <a
            href={`/card/${encodeURIComponent(handle)}`}
            className="mt-5 inline-flex items-center text-sm font-bold text-white underline underline-offset-4"
          >
            Try again
          </a>
        </div>
      </div>
    );
  }
  if (result.status === 'notfound') notFound();
  return (
    <div className="mx-auto w-full px-fluid py-6">
      <Link
        href="/slots"
        className="rise-in group mb-6 inline-flex items-center gap-1.5 text-[13px] font-medium text-white/55 transition-colors hover:text-white"
      >
        <ArrowLeft
          className="h-4 w-4 transition-transform duration-200 ease-out group-hover:-translate-x-0.5 motion-reduce:transition-none motion-reduce:group-hover:translate-x-0"
          aria-hidden
        />{' '}
        All packs
      </Link>
      <CardDetailHydrated initial={result.card} frameVariant={frameVariant} />
    </div>
  );
}
