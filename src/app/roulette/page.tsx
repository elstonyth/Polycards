import type { Metadata } from 'next';
import RouletteClient from './RouletteClient';

export const metadata: Metadata = {
  title: 'Pokémon Card Roulette',
  description: 'Test your luck and win exclusive cards.',
};

export default function RoulettePage() {
  return <RouletteClient />;
}
