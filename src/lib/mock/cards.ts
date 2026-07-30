// Canonical MOCK card pool for the frontend clone (no backend). Built deterministically
// from the harvested graded-card images in public/cdn/cards/h-*.webp so grids look full.
// Pool only (mock/users.ts fixtures) — /card/<id> reads real backend data now.

import type { Rarity } from '@/lib/packs-data';

// Rarity type + color map come from the canonical modules (packs-data /
// rarity.ts) — re-exported so existing importers keep working without this
// file owning a copy that can drift (it did during the Epic→Mythical rename).
export type { Rarity } from '@/lib/packs-data';
export { RARITY_RGB } from '@/lib/rarity';

export type Grader = 'PSA' | 'CGC' | 'Fanatics';
export type MockCard = {
  id: string;
  name: string;
  set: string;
  grader: Grader;
  grade: string;
  rarity: Rarity;
  image: string;
  slabImage: string;
  fmv: number; // USD
  price: number; // USD listing
  points: number;
  year: number;
};

const SUBJECTS = [
  'Charizard ex',
  'Pikachu VMAX',
  'Mewtwo ex',
  'Umbreon VMAX',
  'Gengar VMAX',
  'Lugia V',
  'Rayquaza VMAX',
  'Mew ex',
  'Giratina V',
  'Lucario VSTAR',
  'Greninja ex',
  'Snorlax',
  'Blastoise ex',
  'Venusaur ex',
  'Sylveon VMAX',
  'Arceus VSTAR',
  'Dialga VSTAR',
  'Palkia VSTAR',
  'Darkrai VSTAR',
  'Celebi V',
  'Ho-Oh V',
  'Jolteon ex',
  'Flareon ex',
  'Glaceon ex',
  'Leafeon VSTAR',
  'Tyranitar ex',
  'Garchomp ex',
  'Dragonite V',
  'Gardevoir ex',
  'Zoroark VSTAR',
];
const SETS = [
  'Scarlet & Violet 151',
  'Crown Zenith',
  'Obsidian Flames',
  'Paradox Rift',
  'Surging Sparks',
  'Twilight Masquerade',
  'VSTAR Universe',
  'Eevee Heroes',
  'Paldea Evolved',
  'Temporal Forces',
];
const GRADERS: Grader[] = ['PSA', 'CGC', 'Fanatics'];
const GRADES = ['10 GEM MINT', '10 PRISTINE', '9.5 MINT+', '9 MINT'];
const YEARS = [2021, 2022, 2023, 2024, 2025];

const HARVEST = Array.from(
  { length: 48 },
  (_, i) => `/cdn/cards/h-${String(i + 1).padStart(3, '0')}.webp`,
);

const kebab = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
const rarityFor = (fmv: number): Rarity =>
  fmv > 800
    ? 'Legendary'
    : fmv > 400
      ? 'Mythical'
      : fmv > 180
        ? 'Rare'
        : fmv > 80
          ? 'Uncommon'
          : 'Common';

function build(i: number, image: string): MockCard {
  const subject = SUBJECTS[i % SUBJECTS.length] ?? SUBJECTS[0]!;
  const set = SETS[i % SETS.length] ?? SETS[0]!;
  const grader = GRADERS[i % GRADERS.length] ?? GRADERS[0]!;
  const grade = GRADES[i % GRADES.length] ?? GRADES[0]!;
  const year = YEARS[i % YEARS.length] ?? YEARS[0]!;
  const fmv = 40 + ((i * 53) % 960);
  const price = Math.round(fmv * (0.9 + (i % 10) / 50));
  return {
    id: `${kebab(subject)}-${kebab(set)}-${i + 1}`,
    name: `${year} ${set} ${subject} ${grader} ${grade}`,
    set,
    grader,
    grade,
    rarity: rarityFor(fmv),
    image,
    slabImage: image,
    fmv,
    price,
    points: 80 + ((i * 13) % 21),
    year,
  };
}

export const MOCK_CARDS: MockCard[] = HARVEST.map((img, i) => build(i, img));
