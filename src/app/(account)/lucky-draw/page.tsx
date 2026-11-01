import type { Metadata } from 'next';
import { getLuckyDraw } from '@/lib/actions/lucky-draw';
import { getPackCategories } from '@/lib/data/packs';
import { ticketPackHref, type PackCategory } from '@/lib/packs-data';
import { LuckyDrawClient } from './LuckyDrawClient';

export const metadata: Metadata = {
  title: 'Lucky Draw',
  description:
    'Put your tickets in the Lucky Draw and watch the wheel. Every draw is checkable.',
};

// The capsule link is optional and the catalog is memoised, so its first read
// after a cold start must not hold the page up: past this, no link.
const CATALOG_WAIT_MS = 1500;
const categoriesInTime = () =>
  Promise.race([
    getPackCategories(),
    new Promise<PackCategory[]>((resolve) =>
      setTimeout(() => resolve([]), CATALOG_WAIT_MS),
    ),
  ]);

// The Lucky Draw (spec docs/superpowers/specs/2026-10-24-lucky-draw-design.md).
// Under the gated account group: the layout bounces logged-out visitors, so a
// null page here is a backend hiccup, not a missing session.
export default async function LuckyDrawPage({
  searchParams,
}: {
  searchParams: Promise<{ open?: string }>;
}) {
  const [page, { open }, categories] = await Promise.all([
    getLuckyDraw(),
    searchParams,
    categoriesInTime(),
  ]);
  return (
    <LuckyDrawClient
      initial={page}
      intro={open === '1'}
      spinHref={ticketPackHref(categories)}
    />
  );
}
