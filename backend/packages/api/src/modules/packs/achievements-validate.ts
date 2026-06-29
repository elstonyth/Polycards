import { MedusaError } from '@medusajs/framework/utils';

const METRICS = ['spend', 'cases_opened', 'collection_size'];
const RARITIES = ['Common', 'Uncommon', 'Rare', 'Epic', 'Legendary'];

export type AchievementDefBody = {
  name: string;
  description: string;
  category: string;
  rarity: string;
  xp: number;
  metric: string;
  threshold: number;
};

export function validateAchievementDef(raw: unknown): AchievementDefBody {
  const b = (raw ?? {}) as Record<string, unknown>;
  const str = (v: unknown, f: string) => {
    if (typeof v !== 'string' || v.trim() === '')
      throw new MedusaError(MedusaError.Types.INVALID_DATA, `${f} is required`);
    return v;
  };
  const num = (v: unknown, f: string) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0)
      throw new MedusaError(MedusaError.Types.INVALID_DATA, `${f} must be a non-negative number`);
    return n;
  };
  const metric = str(b['metric'], 'metric');
  if (!METRICS.includes(metric))
    throw new MedusaError(MedusaError.Types.INVALID_DATA, `metric must be one of ${METRICS.join(', ')}`);
  const rarity = str(b['rarity'], 'rarity');
  if (!RARITIES.includes(rarity))
    throw new MedusaError(MedusaError.Types.INVALID_DATA, `rarity must be one of ${RARITIES.join(', ')}`);
  return {
    name: str(b['name'], 'name'),
    description: str(b['description'], 'description'),
    category: str(b['category'], 'category'),
    rarity,
    xp: num(b['xp'], 'xp'),
    metric,
    threshold: num(b['threshold'], 'threshold'),
  };
}
