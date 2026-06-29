import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { GENS, REGION, getGeneration } from '@/lib/mock/pokedex';
import PokedexClient from './PokedexClient';

export function generateStaticParams() {
  return GENS.map((gen) => ({ gen }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ gen: string }>;
}): Promise<Metadata> {
  const { gen } = await params;
  const region = REGION[gen];
  return {
    title: region
      ? `Pokémon · Generation ${gen} (${region})`
      : 'Pokémon',
    description: 'Browse the Pokédex by generation.',
  };
}

export default async function PokemonGenerationPage({
  params,
}: {
  params: Promise<{ gen: string }>;
}) {
  const { gen } = await params;
  if (!REGION[gen]) notFound();
  const pokemon = getGeneration(gen);
  return <PokedexClient gen={gen} pokemon={pokemon} />;
}
