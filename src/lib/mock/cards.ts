// Canonical MOCK card pool for the frontend clone (no backend). Built deterministically
// from the harvested graded-card images in public/cdn/cards/h-*.webp so grids look full.
// `cardOrGeneric()` resolves ANY slug (so every /card/<id> link works, even off-pool).

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
    fmv,
    price,
    points: 80 + ((i * 13) % 21),
    year,
  };
}

export const MOCK_CARDS: MockCard[] = HARVEST.map((img, i) => build(i, img));

export function findCard(id: string): MockCard | null {
  return MOCK_CARDS.find((c) => c.id === id) ?? null;
}

// Deterministic small hash so generic cards have stable values per slug.
function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

// Resolve ANY slug to a card (real pool entry, else a deterministic generic one).
export function cardOrGeneric(id: string): MockCard {
  const found = findCard(id);
  if (found) return found;
  const h = hash(id);
  // HARVEST is a 48-element array; modulo index always in bounds
  const image: string = HARVEST[h % HARVEST.length] ?? '/cdn/cards/h-001.webp';
  const name = id
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (m) => m.toUpperCase())
    .slice(0, 80);
  const fmv = 40 + (h % 960);
  return {
    id,
    name,
    set: SETS[h % SETS.length] ?? SETS[0]!,
    grader: GRADERS[h % GRADERS.length] ?? GRADERS[0]!,
    grade: GRADES[h % GRADES.length] ?? GRADES[0]!,
    rarity: rarityFor(fmv),
    image,
    fmv,
    price: Math.round(fmv * 0.95),
    points: 80 + (h % 21),
    year: YEARS[h % YEARS.length] ?? YEARS[0]!,
  };
}

export const moreFromSet = (card: MockCard, n = 6): MockCard[] =>
  MOCK_CARDS.filter((c) => c.set === card.set && c.id !== card.id).slice(0, n);
