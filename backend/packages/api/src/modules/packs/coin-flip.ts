import { MedusaError } from '@medusajs/framework/utils';
import type { OddsSet } from './odds-sets';
import { NO_TOPUP_MESSAGE } from './withdrawable';
import { MAX_ADMIN_TICKETS } from './lucky-draw';

export const COIN_FLIP_SCALE = 1_000_000;
export const COIN_FLIP_QUOTE_MS = 60_000;
export const COIN_FLIP_CONFIG_ID = 'coin-flip';
export const COIN_FLIP_MAX_CARDS = 20;
// A win mints this many tickets, so it keeps the admin ceiling's int4 protection.
export const COIN_FLIP_MAX_TICKETS = MAX_ADMIN_TICKETS;
export type CoinFlipSide = 'head' | 'tail';
export type CoinFlipQuoteInput = { customerId: string; chosenSide?: CoinFlipSide; tickets?: number } & (
  | { pullId: string; pullIds?: never }
  | { pullIds: string[]; pullId?: never }
  | { tickets: number; pullId?: never; pullIds?: never });

export type CoinFlipConfigValues = {
  enabled: boolean;
  win_units: number | null;
  win_units_2: number | null;
  win_units_3: number | null;
  published_win_units: number | null;
};

export type CoinFlipConfigRecord = CoinFlipConfigValues & { revision: number };

export type CoinFlipSettings = {
  enabled: boolean;
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

type CoinFlipTerms = {
  group_id: string | null;
  odds_set: OddsSet;
  actual_win_units: number;
  published_win_units: number;
  chosen_side?: CoinFlipSide;
};

export type CoinFlipSnapshot = CoinFlipTerms & {
  card: CoinFlipCard;
  valuation: { value_usd: number; multiplier: number; fx: number; quoted_at: string };
  source: string;
  bonus_bp: number;
  cards?: CoinFlipStake[];
};

// A flip with no cards in it. A flip with cards keeps CoinFlipSnapshot, and the
// tickets beside them live in ticket_stake.
export type CoinFlipTicketSnapshot = CoinFlipTerms & {
  source: 'tickets';
  bonus_bp: 0;
};

export type CoinFlipStake = Pick<CoinFlipSnapshot, 'card' | 'valuation' | 'source' | 'bonus_bp'> & {
  stake_cents: number;
  flip_version: number;
};

// A round stakes cards (pull_id + stake_cents), Lucky Draw tickets (ticket_stake)
// or both, and one toss decides all of it. See coin_flip_round_stake_kind_check.
export type CoinFlipRoundRecord = {
  id: string;
  customer_id: string;
  pull_id: string | null;
  status: 'quoted' | 'won' | 'lost';
  stake_cents: number;
  ticket_stake: number;
  flip_version: number;
  config_revision: number;
  expires_at: Date | string;
  settled_at: Date | string | null;
  snapshot: CoinFlipSnapshot | CoinFlipTicketSnapshot;
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
  card: CoinFlipCard | null;
  cards: (CoinFlipCard & { stake_amount: number })[];
  // Tickets staked; 0 when none. A win adds this many, a loss removes them.
  tickets: number;
  chosen_side: CoinFlipSide;
  landed_side: CoinFlipSide | null;
};

const invalid = (message: string): never => {
  throw new MedusaError(MedusaError.Types.INVALID_DATA, message);
};

export function coinFlipSelection(ids: unknown, side: unknown): { pullIds: string[]; chosenSide: CoinFlipSide } {
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > COIN_FLIP_MAX_CARDS ||
      ids.some(id => typeof id !== 'string' || !id.trim() || id !== id.trim() || id.length > 128 || id.includes('\u0000')) ||
      new Set(ids).size !== ids.length) {
    return invalid(`Select 1–${COIN_FLIP_MAX_CARDS} different cards from your Vault.`);
  }
  if (side !== 'head' && side !== 'tail') return invalid('Choose Head or Tail.');
  return { pullIds: [...ids].sort(), chosenSide: side };
}

export function coinFlipTicketSelection(tickets: unknown, side: unknown): { tickets: number; chosenSide: CoinFlipSide } {
  if (typeof tickets !== 'number' || !Number.isInteger(tickets) || tickets < 1 || tickets > COIN_FLIP_MAX_TICKETS) {
    return invalid(`Flip 1–${COIN_FLIP_MAX_TICKETS.toLocaleString('en-US')} tickets.`);
  }
  if (side !== 'head' && side !== 'tail') return invalid('Choose Head or Tail.');
  return { tickets, chosenSide: side };
}

export function coinFlipStakeSelection(input: CoinFlipQuoteInput): { pullIds: string[]; tickets: number; chosenSide: CoinFlipSide } {
  const staked = input.tickets == null ? null : coinFlipTicketSelection(input.tickets, input.chosenSide);
  if (input.pullIds == null && input.pullId == null) {
    return staked ? { pullIds: [], ...staked } : invalid('Select cards or tickets to flip.');
  }
  // Existing single-card clients used the emblem (Head) implicitly.
  return { ...coinFlipSelection(input.pullIds ?? [input.pullId], input.chosenSide ?? 'head'), tickets: staked?.tickets ?? 0 };
}

export function coinFlipStakes(row: CoinFlipRoundRecord): CoinFlipStake[] {
  const { snapshot } = row;
  if (!('card' in snapshot)) return [];
  return snapshot.cards ?? [{
    card: snapshot.card, valuation: snapshot.valuation, source: snapshot.source,
    bonus_bp: snapshot.bonus_bp, stake_cents: Number(row.stake_cents), flip_version: row.flip_version,
  }];
}

function scaledValue(value: unknown, scale: number, max: number, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return invalid(`${name} must be a finite non-negative number.`);
  }
  const scaled = value * scale;
  const rounded = Math.round(scaled);
  // The tolerance grows with the value: floats are coarser than 1e-7 past about 1e9.
  const tolerance = Math.max(0.0000001, Math.abs(scaled) * Number.EPSILON * 2);
  if (!Number.isSafeInteger(rounded) || rounded > max || Math.abs(scaled - rounded) > tolerance) {
    return invalid(`${name} is outside its allowed range or precision.`);
  }
  return rounded;
}

export function coinFlipPercentUnits(value: unknown, name = 'Win chance'): number {
  return scaledValue(value, 10_000, COIN_FLIP_SCALE, name);
}

export function coinFlipStakeCents(value: unknown): number {
  // Keep exact sen within JavaScript's safe integer range; there is no configured stake cap.
  const cents = scaledValue(value, 100, Number.MAX_SAFE_INTEGER, 'Card value');
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
    win_units: percent('win_percent'),
    win_units_2: percent('win_percent_2'),
    win_units_3: percent('win_percent_3'),
    published_win_units: percent('published_win_percent'),
  };
  if (config.enabled && [config.win_units, config.published_win_units].some((v) => v === null)) {
    return invalid('Set the set 1 chance and published chance before enabling coin flips.');
  }
  return config;
}

export function coinFlipSettingsView(config: CoinFlipConfigRecord | null): CoinFlipSettings {
  const pct = (units: number | null | undefined) => units == null ? null : units / 10_000;
  return {
    enabled: config?.enabled ?? false,
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
}, group: { withdrawals_blocked: boolean } | null = null): void {
  if (wallet.isFrozen) throw new MedusaError(MedusaError.Types.NOT_ALLOWED, 'Coin flips are unavailable while your account is under review.');
  // `group` is the effective player group's policy, null for DEFAULT or no group.
  // A withdrawal-blocked group can never cash out (blockGroupWithdrawals), so its
  // members skip both cash-out gates. Any other real group skips only the top-up
  // (owner 2026-11-04, the Lucky Draw's rule): only DEFAULT must have topped up.
  if (group?.withdrawals_blocked) return;
  if (!group && !wallet.hasTopup) throw new MedusaError(MedusaError.Types.NOT_ALLOWED, NO_TOPUP_MESSAGE);
  if (!Number.isFinite(wallet.playthrough.remaining) || wallet.playthrough.remaining > 0) {
    throw new MedusaError(MedusaError.Types.NOT_ALLOWED, 'Complete your deposit playthrough before flipping a card.');
  }
}

export function publicCoinFlipRound(row: CoinFlipRoundRecord): CoinFlipPublicRound {
  const { snapshot } = row;
  const chosenSide = snapshot.chosen_side ?? 'head';
  const publicCard = (c: CoinFlipCard): CoinFlipCard => ({
    pull_id: c.pull_id, name: c.name, image: c.image, grader: c.grader, grade: c.grade,
  });
  return {
    id: row.id,
    status: row.status,
    expires_at: new Date(row.expires_at).toISOString(),
    settled_at: row.settled_at ? new Date(row.settled_at).toISOString() : null,
    stake_amount: row.stake_cents / 100,
    win_amount: row.status === 'won' ? row.stake_cents / 100 : 0,
    published_win_percent: snapshot.published_win_units / 10_000,
    card: 'card' in snapshot ? publicCard(snapshot.card) : null,
    cards: coinFlipStakes(row).map(stake => ({ ...publicCard(stake.card), stake_amount: stake.stake_cents / 100 })),
    tickets: row.ticket_stake,
    chosen_side: chosenSide,
    landed_side: row.status === 'quoted' ? null : row.status === 'won' ? chosenSide : chosenSide === 'head' ? 'tail' : 'head',
  };
}
