export type AchievementDefSeed = {
  key: string;
  name: string;
  description: string;
  category: 'cases_opened' | 'collection' | 'spending';
  rarity: 'Common' | 'Uncommon' | 'Rare' | 'Epic' | 'Legendary';
  xp: number;
  metric: 'spend' | 'cases_opened' | 'collection_size';
  threshold: number;
};

// v1 core seed (16). Trading/Social/Streaks/Pull-streak categories deferred
// (no data source yet). "Set Finisher" excluded (needs set-completion, not size).
export const ACHIEVEMENT_DEFS: AchievementDefSeed[] = [
  // Cases Opened (metric: cases_opened) — 6
  { key: 'cases_opened_1', name: 'First Pull', description: 'Open your first pack', category: 'cases_opened', rarity: 'Common', xp: 50, metric: 'cases_opened', threshold: 1 },
  { key: 'cases_opened_25', name: 'Pack Opener', description: 'Open 25 packs', category: 'cases_opened', rarity: 'Common', xp: 100, metric: 'cases_opened', threshold: 25 },
  { key: 'cases_opened_50', name: 'Pack Enthusiast', description: 'Open 50 packs', category: 'cases_opened', rarity: 'Uncommon', xp: 250, metric: 'cases_opened', threshold: 50 },
  { key: 'cases_opened_250', name: 'Pack Master', description: 'Open 250 packs', category: 'cases_opened', rarity: 'Rare', xp: 500, metric: 'cases_opened', threshold: 250 },
  { key: 'cases_opened_1000', name: 'Pack Legend', description: 'Open 1,000 packs', category: 'cases_opened', rarity: 'Epic', xp: 1500, metric: 'cases_opened', threshold: 1000 },
  { key: 'cases_opened_5000', name: 'Pack God', description: 'Open 5,000 packs', category: 'cases_opened', rarity: 'Legendary', xp: 5000, metric: 'cases_opened', threshold: 5000 },
  // Collection size (metric: collection_size) — 6
  { key: 'collection_1', name: 'Getting Started', description: 'Add your first card', category: 'collection', rarity: 'Common', xp: 50, metric: 'collection_size', threshold: 1 },
  { key: 'collection_10', name: 'Collector', description: 'Own 10 cards', category: 'collection', rarity: 'Common', xp: 100, metric: 'collection_size', threshold: 10 },
  { key: 'collection_100', name: 'Curator', description: 'Own 100 cards', category: 'collection', rarity: 'Uncommon', xp: 250, metric: 'collection_size', threshold: 100 },
  { key: 'collection_500', name: 'Archivist', description: 'Own 500 cards', category: 'collection', rarity: 'Rare', xp: 750, metric: 'collection_size', threshold: 500 },
  { key: 'collection_1000', name: 'Hoarder', description: 'Own 1,000 cards', category: 'collection', rarity: 'Epic', xp: 1500, metric: 'collection_size', threshold: 1000 },
  { key: 'collection_5000', name: 'Vault Keeper', description: 'Own 5,000 cards', category: 'collection', rarity: 'Legendary', xp: 5000, metric: 'collection_size', threshold: 5000 },
  // Spending (metric: spend, threshold in MYR) — 4
  { key: 'spend_1000', name: 'Big Spender', description: 'Spend RM 1,000', category: 'spending', rarity: 'Uncommon', xp: 200, metric: 'spend', threshold: 1000 },
  { key: 'spend_5000', name: 'Heavy Hitter', description: 'Spend RM 5,000', category: 'spending', rarity: 'Rare', xp: 1000, metric: 'spend', threshold: 5000 },
  { key: 'spend_10000', name: 'Whale', description: 'Spend RM 10,000', category: 'spending', rarity: 'Epic', xp: 1000, metric: 'spend', threshold: 10000 },
  { key: 'spend_50000', name: 'High Roller', description: 'Spend RM 50,000', category: 'spending', rarity: 'Legendary', xp: 5000, metric: 'spend', threshold: 50000 },
];
