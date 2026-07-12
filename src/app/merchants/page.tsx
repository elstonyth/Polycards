import type { Metadata } from 'next';
import MerchantsClient from './MerchantsClient';

export const metadata: Metadata = {
  title: 'Merchants',
  description: 'Curated selection of trading card merchants worldwide.',
};

export default function MerchantsPage() {
  return <MerchantsClient />;
}
