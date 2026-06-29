import type { Metadata } from 'next';
import {
  getMarketplaceCards,
  getMarketplaceCategories,
} from '@/lib/data/products';
import MarketplaceClient from './MarketplaceClient';

export const metadata: Metadata = {
  title: 'Marketplace',
  description:
    'Buy and sell real graded cards with other collectors. Real cards, real ownership, instant transfers.',
};

// Cards are read live from the Store API per request (reflects live inventory and
// avoids a build-time dependency on a running backend). Category tabs are static.
export const dynamic = 'force-dynamic';

export default async function MarketplacePage() {
  const cards = await getMarketplaceCards();
  const categories = getMarketplaceCategories();
  return <MarketplaceClient cards={cards} categories={categories} />;
}
