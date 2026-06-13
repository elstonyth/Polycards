import { cache } from 'react';
import type { Metadata } from 'next';
import { MOCK_CARDS } from '@/lib/mock/cards';
import { getCardById, getCardHandles } from '@/lib/data/products';
import CardDetailClient from './CardDetailClient';

// Prerendered seeded handles are revalidated hourly so card-detail price/FMV
// don't drift from the live (force-dynamic) marketplace grid. Non-seeded slugs
// render on demand via dynamicParams (default true).
export const revalidate = 3600;

// Dedupe the Store API lookup across generateMetadata + the page render (one
// request), then fall back to the deterministic mock pool for non-seeded slugs.
const resolveCard = cache((id: string) => getCardById(decodeURIComponent(id)));

// Prerender every seeded product plus the mock pool; any other slug renders on
// demand (getCardById → cardOrGeneric), so every /card/<id> link works.
export async function generateStaticParams() {
  const handles = await getCardHandles();
  const ids = new Set<string>([...handles, ...MOCK_CARDS.map((c) => c.id)]);
  return [...ids].map((id) => ({ id }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const card = await resolveCard(id);
  return {
    title: `${card.name} | Pokenic`,
    description: `${card.set} · ${card.grader} ${card.grade}`,
  };
}

export default async function CardPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const card = await resolveCard(id);
  return <CardDetailClient card={card} />;
}
