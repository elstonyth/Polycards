import { MedusaError } from '@medusajs/framework/utils';
import type { OddsSet } from './odds-sets';
import { NO_TOPUP_MESSAGE } from './withdrawable';

export const COIN_FLIP_SCALE = 1_000_000;
export const COIN_FLIP_QUOTE_MS = 60_000;
export const COIN_FLIP_CONFIG_ID = 'coin-flip';

export type CoinFlipConfigValues = {
  enabled: boolean;
  max_stake_cents: number | null;
  win_units: number | null;
  win_units_2: number | null;
  win_units_3: number | null;
  published_win_units: number | null;
};

export type CoinFlipConfigRecord = CoinFlipConfigValues & { revision: number };

export type CoinFlipSettings = {
  enabled: boolean;
  max_stake_amount: number | null;
  win_percent: number | null;
  win_percent_2: number | null;
  win_percent_3: number | null;
  published_win_percent: number | null;
  revision: number;
};

export type CoinFlipCard = {
  pull_id: string;
  name: string;
  image: string | null;
  grader: string | null;
  grade: string | null;
};

export type CoinFlipSnapshot = {
  card: CoinFlipCard;
  valuation: { value_usd: number; multiplier: number; fx: number; quoted_at: string };
  group_id: string | null;
  odds_set: OddsSet;
  actual_win_units: number;
  published_win_units: number;
  source: string;
  bonus_bp: number;
};

export type CoinFlipRoundRecord = {
  id: string;
  customer_id: string;
  pull_id: string;
  status: 'quoted' | 'won' | 'lost';
  stake_cents: number;
  flip_version: number;
  config_revision: number;
  expires_at: Date | string;
  settled_at: Date | string | null;
  snapshot: CoinFlipSnapshot;
  roll: number | null;
  credit_transaction_id: string | null;
};

export type CoinFlipPublicRound = {
  id: string;
  status: CoinFlipRoundRecord['status'];
  expires_at: string;
  settled_at: string | null;
  stake_amount: number;
  win_amount: number;
  published_win_percent: number;
  card: CoinFlipCard;
};

const invalid = (message: string): never => {
  throw new MedusaError(MedusaError.Types.INVALID_DATA, message);
};

function scaledValue(value: unknown, scale: number, max: number, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return invalid(`${name} must be a finite non-negative number.`);
  }
  const scaled = value * scale;
  const rounded = Math.round(scaled);
  if (!Number.isSafeInteger(rounded) || rounded > max || Math.abs(scaled - rounded) > 0.0000001) {
    return invalid(`${name} is outside its allowed range or precision.`);
  }
  return rounded;
}

export function coinFlipPercentUnits(value: unknown, name = 'Win chance'): number {
  return scaledValue(value, 10_000, COIN_FLIP_SCALE, name);
}

export function coinFlipStakeCents(value: unknown): number {
  // The model stores sen in a PostgreSQL integer, never a floating money column.
  const cents = scaledValue(value, 100, 2_147_483_647, 'Card value');
  if (cents === 0) return invalid('Card value must be greater than RM 0.');
  return cents;
}

export function parseCoinFlipSettings(raw: unknown): CoinFlipConfigValues {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return invalid('Settings are required.');
  const input = raw as Record<string, unknown>;
  if (typeof input.enabled !== 'boolean') return invalid('Enabled must be a boolean.');
  const percent = (key: string) =>
    input[key] == null ? null : coinFlipPercentUnits(input[key], key);
  const config: CoinFlipConfigValues = {
    enabled: input.enabled,
    max_stake_cents: input.max_stake_amount == null ? null : coinFlipStakeCents(input.max_stake_amount),
    win_units: percent('win_percent'),
    win_units_2: percent('win_percent_2'),
    win_units_3: percent('win_percent_3'),
    published_win_units: percent('published_win_percent'),
  };
  if (config.enabled && [config.max_stake_cents, config.win_units, config.published_win_units].some((v) => v === null)) {
    return invalid('Set the maximum card value, set 1 chance and published chance before enabling coin flips.');
  }
  return config;
}

export function coinFlipSettingsView(config: CoinFlipConfigRecord | null): CoinFlipSettings {
  const pct = (units: number | null | undefined) => units == null ? null : units / 10_000;
  return {
    enabled: config?.enabled ?? false,
    max_stake_amount: config?.max_stake_cents == null ? null : config.max_stake_cents / 100,
    win_percent: pct(config?.win_units),
    win_percent_2: pct(config?.win_units_2),
    win_percent_3: pct(config?.win_units_3),
    published_win_percent: pct(config?.published_win_units),
    revision: config?.revision ?? 0,
  };
}

export function effectiveCoinWinUnits(config: CoinFlipConfigValues, set: OddsSet): number {
  const units = set === 3
    ? (config.win_units_3 ?? config.win_units_2 ?? config.win_units)
    : set === 2 ? (config.win_units_2 ?? config.win_units) : config.win_units;
  if (units == null) return invalid('Coin flip odds are not configured.');
  return units;
}

export function coinFlipWins(roll: number, winUnits: number): boolean {
  if (!Number.isInteger(roll) || roll < 0 || roll >= COIN_FLIP_SCALE ||
      !Number.isInteger(winUnits) || winUnits < 0 || winUnits > COIN_FLIP_SCALE) {
    return invalid('Invalid coin flip draw.');
  }
  return roll < winUnits;
}

export function assertCoinFlipEligible(wallet: {
  isFrozen: boolean;
  hasTopup: boolean;
  playthrough: { remaining: number };
}): void {
  if (wallet.isFrozen) throw new MedusaError(MedusaError.Types.NOT_ALLOWED, 'Coin flips are unavailable while your account is under review.');
  if (!wallet.hasTopup) throw new MedusaError(MedusaError.Types.NOT_ALLOWED, NO_TOPUP_MESSAGE);
  if (!Number.isFinite(wallet.playthrough.remaining) || wallet.playthrough.remaining > 0) {
    throw new MedusaError(MedusaError.Types.NOT_ALLOWED, 'Complete your deposit playthrough before flipping a card.');
  }
}

export function publicCoinFlipRound(row: CoinFlipRoundRecord): CoinFlipPublicRound {
  const card = row.snapshot.card;
  return {
    id: row.id,
    status: row.status,
    expires_at: new Date(row.expires_at).toISOString(),
    settled_at: row.settled_at ? new Date(row.settled_at).toISOString() : null,
    stake_amount: row.stake_cents / 100,
    win_amount: row.status === 'won' ? row.stake_cents / 100 : 0,
    published_win_percent: row.snapshot.published_win_units / 10_000,
    card: { pull_id: card.pull_id, name: card.name, image: card.image, grader: card.grader, grade: card.grade },
  };
}
