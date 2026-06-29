import type { Metadata } from 'next';
import { getPackCategories } from '@/lib/data/packs';
import ClawClient from './ClawClient';

export const metadata: Metadata = { title: 'Open Packs' };

// Pack catalog is read live from the backend (GET /store/packs) — render fresh.
export const dynamic = 'force-dynamic';

export default async function ClawPage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string }>;
}) {
  const [{ category }, categories] = await Promise.all([
    searchParams,
    getPackCategories(),
  ]);

  // Honor a deep link (/claw?category=<key>) only when the category exists;
  // otherwise default to the "All Packs" view.
  const initialCategory =
    category && categories.some((c) => c.id === category) ? category : 'all';

  return (
    <ClawClient categories={categories} initialCategory={initialCategory} />
  );
}
