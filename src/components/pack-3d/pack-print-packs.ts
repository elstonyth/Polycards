// The 11 sleeve packs' back details as the live pack pages print them on
// 2026-11-19 (docs/research/home-3d/pack-back/rollout-audit.json). A fixture
// for fit checks and the capture stage, which cannot import the app's
// formatters: pack-print.test.ts proves every entry is exactly what
// packBackDetails() makes from that pack's page data, so nothing here is
// worded by hand. Not used by the app.

import type { PackBackDetails } from './pack-print';

const RULE =
  'The pack rate applies during the reveal countdown. Leaving the reveal or letting the timer expire changes buyback to 90% of card value in your vault.';
const BUYBACK = { headline: '90% instant buyback', rule: RULE };

const RAW_ODDS = [
  { label: 'Immortal', chance: '0.1%' },
  { label: 'Legendary', chance: '1.4%' },
  { label: 'Mythical', chance: '3.5%' },
  { label: 'Rare', chance: '22%' },
  { label: 'Uncommon', chance: '30%' },
  { label: 'Common', chance: '43%' },
];
const GRADED_ODDS = [
  { label: 'Immortal', chance: '0.2%' },
  { label: 'Legendary', chance: '2.4%' },
  { label: 'Mythical', chance: '3.4%' },
  { label: 'Rare', chance: '22%' },
  { label: 'Uncommon', chance: '30%' },
  { label: 'Common', chance: '42%' },
];

const raw = (name: string, price: string): PackBackDetails => ({
  price,
  productLine: [name, 'Pokémon', 'Original', 'English', 'Raw Cards'],
  odds: RAW_ODDS,
  buyback: BUYBACK,
});
const graded = (
  name: string,
  price: string,
  type: 'Classic' | 'Special',
): PackBackDetails => ({
  price,
  productLine: [name, 'Pokémon', type, 'Graded'],
  odds: GRADED_ODDS,
  buyback: BUYBACK,
});

/** Slug (the pack page's /slots/<slug>) to what its back prints. */
export const ROLLOUT_PACK_DETAILS: Record<string, PackBackDetails> = {
  '151': raw('151', 'RM 40.00'),
  cr: raw('Chaos Rising', 'RM 15.00'),
  'delta-reign': raw('Delta Reign', 'RM 18.00'),
  '30th-celebration': raw('30th Celebration', 'RM 45.00'),
  ah: raw('Ascended Heroes', 'RM 50.00'),
  'bronze-pack': graded('Bronze Pack', 'RM 300.00', 'Classic'),
  'silver-pack': graded('Silver Pack', 'RM 600.00', 'Classic'),
  'gold-pack': graded('Gold Pack', 'RM 1,200.00', 'Classic'),
  'platinum-pack': graded('Platinum Pack', 'RM 2,500.00', 'Classic'),
  'diamond-pack': graded('Diamond Pack', 'RM 5,000.00', 'Classic'),
  'poncho-pack': graded('Poncho Pack', 'RM 22,000.00', 'Special'),
};
