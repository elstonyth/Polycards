import type { Metadata } from 'next';
import PackPartyClient from './PackPartyClient';

export const metadata: Metadata = {
  title: 'Pack Party',
  description:
    'Rip packs with friends. Multiple players enter, one pack is opened, and cards are allocated to every player at random.',
};

export default function PackPartyPage() {
  return <PackPartyClient />;
}
