import { randomInt } from 'node:crypto';
import { MedusaError } from '@medusajs/framework/utils';
import type { Context } from '@medusajs/framework/types';
import type PacksModuleService from './service';
import type { LedgerSqlManager } from './claim';
import { coerceOddsSet, EFFECTIVE_GROUP_SQL } from './odds-sets';
import { DEFAULT_MARKET_MULTIPLIER, displayMarketPrice, resolveFxRateStrict } from './pricing';
import { FREE_PULL_LOCKED_MESSAGE } from './free-pack';
import { groupPolicyOf } from './group-policy';
import {
  assertCoinFlipEligible, COIN_FLIP_CONFIG_ID, COIN_FLIP_QUOTE_MS, COIN_FLIP_SCALE,
  coinFlipSettingsView, coinFlipStakeCents, coinFlipWins, effectiveCoinWinUnits,
  publicCoinFlipRound, type CoinFlipConfigRecord, type CoinFlipPublicRound,
  type CoinFlipRoundRecord, type CoinFlipSnapshot,
} from './coin-flip';

const refuse = (message: string): never => { throw new MedusaError(MedusaError.Types.NOT_ALLOWED, message); };
const notFound = (): never => { throw new MedusaError(MedusaError.Types.NOT_FOUND, 'Coin flip not found.'); };
export const coinFlipManager = (context: Context): LedgerSqlManager =>
  (context.transactionManager ?? context.manager) as unknown as LedgerSqlManager;

export async function lockCoinFlipCustomer(customerId: string, context: Context): Promise<void> {
  await coinFlipManager(context).execute('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [`credit:${customerId}`]);
}

async function eligible(service: PacksModuleService, customerId: string, context: Context): Promise<void> {
  if (await service.isAccountDisabled(customerId, context)) refuse('This account is unavailable.');
  assertCoinFlipEligible(await service.walletSummary(customerId, undefined, context));
}

async function cardForFlip(service: PacksModuleService, customerId: string, pullId: string, context: Context) {
  // Credit lock precedes row locks everywhere that can release this card.
  await coinFlipManager(context).execute('SELECT id FROM pull WHERE id = ? AND customer_id = ? AND deleted_at IS NULL FOR UPDATE', [pullId, customerId]);
  const [pull] = await service.listPulls({ id: pullId, customer_id: customerId }, { take: 1 }, context);
  if (!pull) return notFound();
  if (pull.status !== 'vaulted') refuse('This card is no longer available in your Vault.');
  if (!pull.flip_eligible_at) refuse('This card is still processing. Please try again later.');
  if (pull.source === 'free' && !await service.hasPaidOpen(customerId, context)) refuse(FREE_PULL_LOCKED_MESSAGE);
  return pull;
}

async function terms(customerId: string, context: Context) {
  // One statement is the group/config serialization point; a config writer waits
  // for this transaction. Group changes afterwards apply to the next quote.
  const [row] = await coinFlipManager(context).execute<(CoinFlipConfigRecord & {
    group_id: string | null; group_name: string | null; group_metadata: Record<string, unknown> | null; odds_set: unknown; db_now: Date;
  })[]>(`SELECT c.*, g.group_id, cg.name AS group_name, cg.metadata AS group_metadata, cg.metadata->>'odds_set' AS odds_set, clock_timestamp() AS db_now
    FROM coin_flip_config c
    LEFT JOIN (${EFFECTIVE_GROUP_SQL}) g ON g.customer_id = ?
    LEFT JOIN customer_group cg ON cg.id = g.group_id
    WHERE c.id = ? AND c.deleted_at IS NULL FOR SHARE OF c`, [customerId, COIN_FLIP_CONFIG_ID]);
  if (!row?.enabled) return refuse('Coin flip is currently paused.');
  if (!row.max_stake_cents || row.published_win_units == null) return refuse('Coin flip is not configured.');
  if (groupPolicyOf({ name: row.group_name, metadata: row.group_metadata }).withdrawals_blocked) return refuse('Withdrawals are not available on this account.');
  const set = coerceOddsSet(row.odds_set);
  return { config: row, groupId: row.group_id, set, actual: effectiveCoinWinUnits(row, set), now: new Date(row.db_now) };
}

export async function quoteCoinFlipOperation(
  service: PacksModuleService, input: { customerId: string; pullId: string }, context: Context,
): Promise<CoinFlipPublicRound> {
  await lockCoinFlipCustomer(input.customerId, context);
  await eligible(service, input.customerId, context);
  const pull = await cardForFlip(service, input.customerId, input.pullId, context);
  const current = await terms(input.customerId, context);
  const [card] = await service.listCards({ handle: pull.card_id }, { take: 1 }, context);
  if (!card) return refuse('This card is no longer available for valuation.');
  const fx = await resolveFxRateStrict({ listFxRates: () => service.listFxRates({ pair: 'USD_MYR' }, { take: 1 }, context) });
  const valueUsd = Number(card.market_value);
  const multiplier = Number(card.market_multiplier ?? DEFAULT_MARKET_MULTIPLIER);
  const stake = coinFlipStakeCents(displayMarketPrice(valueUsd, fx, multiplier));
  if (stake > current.config.max_stake_cents!) return refuse('This card exceeds the maximum coin flip value.');
  const snapshot: CoinFlipSnapshot = {
    card: { pull_id: pull.id, name: card.name, image: card.slab_image || card.image, grader: card.grader, grade: card.grade },
    valuation: { value_usd: valueUsd, multiplier, fx, quoted_at: current.now.toISOString() },
    group_id: current.groupId, odds_set: current.set, actual_win_units: current.actual,
    published_win_units: current.config.published_win_units!, source: pull.source, bonus_bp: pull.bonus_bp,
  };
  const [round] = await service.createCoinFlipRounds([{
    customer_id: input.customerId, pull_id: pull.id, stake_cents: stake,
    status: 'quoted',
    flip_version: pull.flip_version, config_revision: current.config.revision,
    expires_at: new Date(current.now.getTime() + COIN_FLIP_QUOTE_MS), snapshot,
  }], context);
  return publicCoinFlipRound(round as unknown as CoinFlipRoundRecord);
}

export async function getCoinFlipRoundOperation(
  input: { customerId: string; roundId: string }, context: Context,
): Promise<CoinFlipRoundRecord> {
  const [round] = await coinFlipManager(context).execute<CoinFlipRoundRecord[]>(
    'SELECT * FROM coin_flip_round WHERE id = ? AND customer_id = ? AND deleted_at IS NULL', [input.roundId, input.customerId]);
  return round ?? notFound();
}

export async function acceptCoinFlipOperation(
  service: PacksModuleService, input: { customerId: string; roundId: string }, context: Context,
): Promise<CoinFlipPublicRound> {
  await lockCoinFlipCustomer(input.customerId, context);
  const round = await getCoinFlipRoundOperation(input, context);
  if (round.status !== 'quoted') return publicCoinFlipRound(round);
  await eligible(service, input.customerId, context);
  const pull = await cardForFlip(service, input.customerId, round.pull_id, context);
  const current = await terms(input.customerId, context);
  if (new Date(round.expires_at).getTime() <= current.now.getTime()) refuse('Quote expired. Select your card again.');
  if (pull.flip_version !== round.flip_version || current.config.revision !== round.config_revision ||
      current.groupId !== round.snapshot.group_id || current.set !== round.snapshot.odds_set ||
      current.actual !== round.snapshot.actual_win_units || current.config.published_win_units !== round.snapshot.published_win_units) {
    refuse('Your card or coin flip settings changed. Please confirm a new quote.');
  }
  if (!Number.isSafeInteger(round.stake_cents) || round.stake_cents <= 0 || round.stake_cents > current.config.max_stake_cents!) {
    refuse('This quote has an invalid card value.');
  }
  const roll = randomInt(COIN_FLIP_SCALE);
  const status = coinFlipWins(roll, current.actual) ? 'won' : 'lost';
  const amount = round.stake_cents / 100;
  const em = coinFlipManager(context);
  const claimed = await em.execute<{ id: string }[]>(`UPDATE pull SET status = ?, flip_version = flip_version + 1,
    showcased = CASE WHEN ? = 'lost' THEN false ELSE showcased END, updated_at = now()
    WHERE id = ? AND customer_id = ? AND status = 'vaulted' AND flip_version = ? AND deleted_at IS NULL RETURNING id`,
    [status === 'won' ? 'vaulted' : 'forfeited', status, pull.id, input.customerId, round.flip_version]);
  if (claimed.length !== 1) refuse('Your card changed. Please select it again.');
  let creditId: string | null = null;
  if (status === 'won') {
    const [credit] = await service.createCreditTransactions([{
      customer_id: input.customerId, amount, reason: 'coin_flip_win', pull_id: null,
      source_transaction_id: `coin-flip:${round.id}`, reference: round.id,
      bonus_cents: 0, external_funded_cents: 0,
    }], context);
    creditId = credit.id;
  }
  await service.recordLedgerEntry({ type: 'CF', customerId: input.customerId, refId: round.id,
    walletDelta: status === 'won' ? amount : 0, vaultDelta: status === 'lost' ? -amount : 0,
    payload: { type: 'CF', round_id: round.id, pull_id: pull.id, card_handle: pull.card_id,
      outcome: status, value: amount, published_win_percent: round.snapshot.published_win_units / 10000 },
  }, context);
  await service.updateCoinFlipRounds([{ id: round.id, status, roll, settled_at: current.now, credit_transaction_id: creditId }], context);
  return publicCoinFlipRound({ ...round, status, roll, settled_at: current.now, credit_transaction_id: creditId });
}

export async function readCoinFlipSettings(context: Context) {
  const [config] = await coinFlipManager(context).execute<CoinFlipConfigRecord[]>(
    'SELECT * FROM coin_flip_config WHERE id = ? AND deleted_at IS NULL', [COIN_FLIP_CONFIG_ID]);
  return coinFlipSettingsView(config ?? null);
}
