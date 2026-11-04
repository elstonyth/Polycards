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
  coinFlipSettingsView, coinFlipStakeCents, coinFlipWins, effectiveCoinWinUnits, coinFlipSelection, coinFlipStakes,
  coinFlipStakeSelection, publicCoinFlipRound, type CoinFlipConfigRecord, type CoinFlipPublicRound,
  type CoinFlipRoundRecord, type CoinFlipSnapshot, type CoinFlipStake, type CoinFlipQuoteInput,
  type CoinFlipTicketSnapshot,
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
  const [group] = await coinFlipManager(context).execute<{ name: string | null; metadata: Record<string, unknown> | null }[]>(
    `SELECT cg.name, cg.metadata FROM (${EFFECTIVE_GROUP_SQL}) g JOIN customer_group cg ON cg.id = g.group_id WHERE g.customer_id = ?`, [customerId]);
  assertCoinFlipEligible(await service.walletSummary(customerId, undefined, context), group ? groupPolicyOf(group) : null);
}

async function cardForFlip(service: PacksModuleService, customerId: string, pullId: string, context: Context) {
  // Credit lock precedes row locks everywhere that can release this card.
  await coinFlipManager(context).execute('SELECT id FROM pull WHERE id = ? AND customer_id = ? AND deleted_at IS NULL FOR UPDATE', [pullId, customerId]);
  const [pull] = await service.listPulls({ id: pullId, customer_id: customerId }, { take: 1 }, context);
  if (!pull) return notFound();
  if (pull.status !== 'vaulted') refuse('This card is no longer available in your Vault.');
  if (!pull.flip_eligible_at) {
    const [card] = await service.listCards({ handle: pull.card_id }, { take: 1 }, context);
    refuse(`${card?.name ?? 'This card'} is still processing. Please try again later.`);
  }
  if ((await service.lockedPullIds(customerId, [pull], context)).size) refuse(FREE_PULL_LOCKED_MESSAGE);
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
  if (row.published_win_units == null) return refuse('Coin flip is not configured.');
  const set = coerceOddsSet(row.odds_set);
  return { config: row, groupId: row.group_id, set, actual: effectiveCoinWinUnits(row, set), now: new Date(row.db_now) };
}

// The live terms, refused unless they are still the ones this quote showed.
async function termsForQuote(round: CoinFlipRoundRecord, customerId: string, context: Context) {
  const stake = round.stake_cents > 0 ? 'card' : 'tickets';
  const current = await terms(customerId, context);
  if (new Date(round.expires_at).getTime() <= current.now.getTime()) refuse(`Quote expired. Select your ${stake} again.`);
  if (current.config.revision !== round.config_revision ||
      current.groupId !== round.snapshot.group_id || current.set !== round.snapshot.odds_set ||
      current.actual !== round.snapshot.actual_win_units || current.config.published_win_units !== round.snapshot.published_win_units) {
    refuse(`Your ${stake} or coin flip settings changed. Please confirm a new quote.`);
  }
  return current;
}

const NOT_ENOUGH_TICKETS = 'You do not have enough tickets for this flip.';

const coinFlipFx = (service: PacksModuleService, context: Context) =>
  resolveFxRateStrict({ listFxRates: () => service.listFxRates({ pair: 'USD_MYR' }, { take: 1 }, context) });

async function valueCard(service: PacksModuleService, cardId: string, fx: number, context: Context) {
  const [card] = await service.listCards({ handle: cardId }, { take: 1 }, context);
  if (!card) return refuse('This card is no longer available for valuation.');
  const valueUsd = Number(card.market_value);
  const multiplier = Number(card.market_multiplier ?? DEFAULT_MARKET_MULTIPLIER);
  return { card, valueUsd, multiplier, stakeCents: coinFlipStakeCents(displayMarketPrice(valueUsd, fx, multiplier)) };
}

export async function quoteCoinFlipOperation(
  service: PacksModuleService, input: CoinFlipQuoteInput, context: Context,
): Promise<CoinFlipPublicRound> {
  const selection = coinFlipStakeSelection(input);
  await lockCoinFlipCustomer(input.customerId, context);
  await eligible(service, input.customerId, context);
  const pulls: Awaited<ReturnType<typeof cardForFlip>>[] = [];
  for (const id of selection.pullIds) pulls.push(await cardForFlip(service, input.customerId, id, context));
  const current = await terms(input.customerId, context);
  // A quote holds nothing, as with cards: settling checks the balance again.
  if (await service.luckyDrawBalance(input.customerId, context) < selection.tickets) refuse(NOT_ENOUGH_TICKETS);
  const fx = pulls.length ? await coinFlipFx(service, context) : 0;
  const cards: CoinFlipStake[] = [];
  for (const pull of pulls) {
    const { card, valueUsd, multiplier, stakeCents } = await valueCard(service, pull.card_id, fx, context);
    cards.push({
      card: { pull_id: pull.id, name: card.name, image: card.slab_image || card.image, grader: card.grader, grade: card.grade },
      valuation: { value_usd: valueUsd, multiplier, fx, quoted_at: current.now.toISOString() },
      stake_cents: stakeCents,
      flip_version: pull.flip_version, source: pull.source, bonus_bp: pull.bonus_bp,
    });
  }
  const stake = cards.reduce((sum, card) => sum + card.stake_cents, 0);
  if (!Number.isSafeInteger(stake)) return refuse('This card value cannot be represented accurately.');
  const first = cards.at(0);
  const quoteTerms = {
    chosen_side: selection.chosenSide, group_id: current.groupId, odds_set: current.set,
    actual_win_units: current.actual, published_win_units: current.config.published_win_units!,
  };
  const snapshot: CoinFlipSnapshot | CoinFlipTicketSnapshot = first ? {
    ...quoteTerms, card: first.card, valuation: first.valuation, cards,
    source: cards.every(card => card.source === first.source) ? first.source : 'mixed', bonus_bp: first.bonus_bp,
  } : { ...quoteTerms, source: 'tickets', bonus_bp: 0 };
  const [round] = await service.createCoinFlipRounds([{
    customer_id: input.customerId, pull_id: first?.card.pull_id ?? null, stake_cents: stake,
    ticket_stake: selection.tickets, status: 'quoted',
    flip_version: first?.flip_version ?? 0, config_revision: current.config.revision,
    expires_at: new Date(current.now.getTime() + COIN_FLIP_QUOTE_MS), snapshot,
  }], context);
  return publicCoinFlipRound(round as unknown as CoinFlipRoundRecord);
}

export async function getCoinFlipRoundOperation(
  input: { customerId: string; roundId: string }, context: Context,
): Promise<CoinFlipRoundRecord> {
  // Postgres rejects a NUL in a bound value; no round has one, so it is simply not found.
  if (input.roundId.includes('\u0000')) return notFound();
  const [round] = await coinFlipManager(context).execute<CoinFlipRoundRecord[]>(
    'SELECT * FROM coin_flip_round WHERE id = ? AND customer_id = ? AND deleted_at IS NULL', [input.roundId, input.customerId]);
  return round ? { ...round, stake_cents: Number(round.stake_cents) } : notFound();
}

export async function acceptCoinFlipOperation(
  service: PacksModuleService, input: { customerId: string; roundId: string }, context: Context,
): Promise<CoinFlipPublicRound> {
  await lockCoinFlipCustomer(input.customerId, context);
  const round = await getCoinFlipRoundOperation(input, context);
  if (round.status !== 'quoted') return publicCoinFlipRound(round);
  await eligible(service, input.customerId, context);
  // Serialises with Lucky Draw entries and admin grants. Taken after the credit
  // lock; nothing holds the ticket lock while waiting for the credit one.
  if (round.ticket_stake > 0) {
    await coinFlipManager(context).execute('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [`tickets:${input.customerId}`]);
  }
  const stakes = coinFlipStakes(round);
  const chosenSide = round.snapshot.chosen_side ?? 'head';
  const selection = stakes.length
    ? coinFlipSelection(stakes.map(stake => stake.card.pull_id), chosenSide)
    : { pullIds: [], chosenSide };
  const pulls: { pull: Awaited<ReturnType<typeof cardForFlip>>; stake: CoinFlipStake }[] = [];
  for (const id of selection.pullIds) {
    const pull = await cardForFlip(service, input.customerId, id, context);
    const stake = stakes.find(stake => stake.card.pull_id === id)!;
    if (pull.flip_version !== stake.flip_version) refuse('Your cards changed. Please confirm a new quote.');
    pulls.push({ pull, stake });
  }
  const current = await termsForQuote(round, input.customerId, context);
  if (await service.luckyDrawBalance(input.customerId, context) < round.ticket_stake) refuse(NOT_ENOUGH_TICKETS);
  if (!Number.isSafeInteger(round.stake_cents) || (stakes.length > 0 && round.stake_cents <= 0) ||
      stakes.some(stake => !Number.isSafeInteger(stake.stake_cents) || stake.stake_cents <= 0) ||
      stakes.reduce((sum, stake) => sum + stake.stake_cents, 0) !== round.stake_cents) {
    refuse('This quote has an invalid card value.');
  }
  // A win pays the quoted value, so it must not outrun a price that fell during the quote.
  if (pulls.length) {
    const fx = await coinFlipFx(service, context);
    let live = 0;
    for (const { pull } of pulls) live += (await valueCard(service, pull.card_id, fx, context)).stakeCents;
    if (live < round.stake_cents) refuse('Your cards changed. Please confirm a new quote.');
  }
  const roll = randomInt(COIN_FLIP_SCALE);
  const status = coinFlipWins(roll, current.actual) ? 'won' : 'lost';
  const amount = round.stake_cents / 100;
  const em = coinFlipManager(context);
  for (const { pull, stake } of pulls) {
    const claimed = await em.execute<{ id: string }[]>(`UPDATE pull SET status = ?, flip_version = flip_version + 1,
    showcased = CASE WHEN ? = 'lost' THEN false ELSE showcased END,
    updated_at = CASE WHEN ? = 'lost' THEN now() ELSE updated_at END
    WHERE id = ? AND customer_id = ? AND status = 'vaulted' AND flip_version = ? AND deleted_at IS NULL RETURNING id`,
      // A win changes nothing the customer sees in the Vault, and /store/vault/latest
      // reads updated_at on a held card as a new event, so it leaves that alone.
      [status === 'won' ? 'vaulted' : 'forfeited', status, status, pull.id, input.customerId, stake.flip_version]);
    if (claimed.length !== 1) refuse('Your cards changed. Please select them again.');
  }
  let creditId: string | null = null;
  if (status === 'won' && amount > 0) {
    const [credit] = await service.createCreditTransactions([{
      customer_id: input.customerId, amount, reason: 'coin_flip_win', pull_id: null,
      source_transaction_id: `coin-flip:${round.id}`, reference: round.id,
      bonus_cents: 0, external_funded_cents: 0,
    }], context);
    creditId = credit.id;
  }
  // Reward mints add no tracked vault liability; forfeiture cannot remove any.
  if (pulls.length) {
    await service.recordLedgerEntry({ type: 'CF', customerId: input.customerId, refId: round.id,
      walletDelta: status === 'won' ? amount : 0,
      vaultDelta: status === 'lost' ? -pulls.reduce((sum, { pull, stake }) => sum + (pull.source === 'reward' ? 0 : stake.stake_cents), 0) / 100 : 0,
      payload: { type: 'CF', round_id: round.id, pull_id: pulls[0].pull.id, card_handle: pulls[0].pull.card_id,
        cards: pulls.map(({ pull, stake }) => ({ pull_id: pull.id, card_handle: pull.card_id, value: stake.stake_cents / 100 })),
        chosen_side: selection.chosenSide,
        landed_side: status === 'won' ? selection.chosenSide : selection.chosenSide === 'head' ? 'tail' : 'head',
        outcome: status, value: amount, published_win_percent: round.snapshot.published_win_units / 10000 },
    }, context);
  }
  // Tickets are not money, so no Credit and no CF ledger row for them: their own
  // ledger is the record, and (reason, ref) keeps it to one row per round.
  if (round.ticket_stake > 0) {
    await service.createLuckyDrawTickets([{
      customer_id: input.customerId, delta: status === 'won' ? round.ticket_stake : -round.ticket_stake,
      reason: 'coin_flip' as const, ref: round.id,
    }], context);
  }
  await service.updateCoinFlipRounds([{ id: round.id, status, roll, settled_at: current.now, credit_transaction_id: creditId }], context);
  return publicCoinFlipRound({ ...round, status, roll, settled_at: current.now, credit_transaction_id: creditId });
}

export async function readCoinFlipSettings(context: Context) {
  const [config] = await coinFlipManager(context).execute<CoinFlipConfigRecord[]>(
    'SELECT * FROM coin_flip_config WHERE id = ? AND deleted_at IS NULL', [COIN_FLIP_CONFIG_ID]);
  return coinFlipSettingsView(config ?? null);
}
