import { MedusaError } from '@medusajs/framework/utils';
import type { Context } from '@medusajs/framework/types';
import type PacksModuleService from './service';
import { coinFlipManager, lockCoinFlipCustomer } from './coin-flip-operations';
import { FREE_PULL_LOCKED_MESSAGE } from './free-pack';
import { buybackAmount, resolveBuybackRate, type BuybackRateType } from './buyback-rate';
import { DEFAULT_MARKET_MULTIPLIER, displayMarketPrice, resolveFxRateStrict } from './pricing';

export type BuybackSettlement = {
  pull: { id: string; card_id: string; stock_earmarked: boolean };
  amount: number; percent: number; rate_type: BuybackRateType; creditTransactionId: string;
};

export async function settleBuyback(
  service: PacksModuleService, input: { customerId: string; pullId: string }, context: Context,
): Promise<BuybackSettlement> {
  await lockCoinFlipCustomer(input.customerId, context);
  if (await service.isAccountDisabled(input.customerId, context)) {
    throw new MedusaError(MedusaError.Types.NOT_ALLOWED, 'This account is unavailable.');
  }
  await service.assertNotFrozen(input.customerId, context);
  await coinFlipManager(context).execute('SELECT id FROM pull WHERE id = ? AND customer_id = ? AND deleted_at IS NULL FOR UPDATE', [input.pullId, input.customerId]);
  const [pull] = await service.listPulls({ id: input.pullId, customer_id: input.customerId }, { take: 1 }, context);
  if (!pull) throw new MedusaError(MedusaError.Types.NOT_FOUND, `Pull '${input.pullId}' not found.`);
  if (pull.status !== 'vaulted') throw new MedusaError(MedusaError.Types.NOT_ALLOWED, 'This card is no longer available to sell.');
  if (pull.source === 'free' && !await service.hasPaidOpen(input.customerId, context)) {
    throw new MedusaError(MedusaError.Types.NOT_ALLOWED, FREE_PULL_LOCKED_MESSAGE);
  }
  const [card] = await service.listCards({ handle: pull.card_id }, { take: 1 }, context);
  if (!card || !Number.isFinite(Number(card.market_value)) || Number(card.market_value) < 0) {
    throw new MedusaError(MedusaError.Types.NOT_ALLOWED, 'This card has no valid market value and cannot be sold back.');
  }
  const [pack] = await service.listPacks({ slug: pull.pack_id }, { take: 1 }, context);
  const { percent, rate_type } = resolveBuybackRate(pack, pull);
  const fx = await resolveFxRateStrict({ listFxRates: () => service.listFxRates({ pair: 'USD_MYR' }, { take: 1 }, context) });
  const valueMyr = displayMarketPrice(Number(card.market_value), fx, Number(card.market_multiplier ?? DEFAULT_MARKET_MULTIPLIER));
  const amount = buybackAmount(valueMyr, percent);
  const [credit] = await service.recordBuybackCreditTransaction({
    customerId: input.customerId, pullId: pull.id, amount, valueMyr,
    cardHandle: pull.card_id, rate: percent / 100, openId: pull.open_id, bonusBp: pull.bonus_bp,
  }, context);
  await service.transitionPullStatus({ ids: [pull.id], from: 'vaulted', to: 'bought_back',
    set: { buyback_amount: amount, buyback_at: new Date() } }, context);
  return { pull: { id: pull.id, card_id: pull.card_id, stock_earmarked: pull.stock_earmarked },
    amount, percent, rate_type, creditTransactionId: credit.id };
}
