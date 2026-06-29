import type { Metadata } from 'next';
import RepacksClient from './RepacksClient';

export const metadata: Metadata = {
  title: 'Repacks',
  description:
    'Packs created by anyone — curated pulls with 85% guaranteed buyback. Filter and sort to find your next rip.',
};

export default function RepacksPage() {
  return <RepacksClient />;
}
