import type { Metadata } from 'next';
import SocialClient from './SocialClient';

export const metadata: Metadata = {
  title: 'Community',
  description: 'Connect with collectors and traders.',
};

export default function SocialPage() {
  return <SocialClient />;
}
