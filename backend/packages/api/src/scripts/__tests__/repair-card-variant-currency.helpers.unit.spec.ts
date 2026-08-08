import { planCardVariantCurrencyRepair } from '../repair-card-variant-currency.helpers';

const row = (
  over: Partial<
    Parameters<typeof planCardVariantCurrencyRepair>[0][number]
  > = {},
) => ({
  product_id: 'prod_1',
  handle: 'h1',
  variant_id: 'var_1',
  has_myr: false,
  card_price_myr: null,
  market_value_usd: 25,
  market_multiplier: 1.2,
  ...over,
});

describe('planCardVariantCurrencyRepair', () => {
  it('restores a usd-only variant at the FMV-derived display price', () => {
    // 25 USD × 4.5 × 1.2 = 135 — the same amount the fixed edit path writes.
    const plan = planCardVariantCurrencyRepair([row()], 4.5);
    expect(plan.actions).toEqual([
      { product_id: 'prod_1', handle: 'h1', variant_id: 'var_1', to: 135 },
    ]);
  });

  it('a stored MYR card price wins over the FMV fallback', () => {
    const plan = planCardVariantCurrencyRepair(
      [row({ card_price_myr: 99 })],
      4.5,
    );
    expect(plan.actions[0].to).toBe(99);
  });

  it('is idempotent: a variant that already has myr is never touched', () => {
    const plan = planCardVariantCurrencyRepair([row({ has_myr: true })], 4.5);
    expect(plan.actions).toEqual([]);
    expect(plan.skippedHealthy).toBe(1);
  });

  it('skips a product with no variant rather than throwing', () => {
    const plan = planCardVariantCurrencyRepair([row({ variant_id: null })], 4.5);
    expect(plan.actions).toEqual([]);
    expect(plan.skippedNoVariant).toBe(1);
  });

  it('honours the card multiplier in the fallback', () => {
    const plan = planCardVariantCurrencyRepair(
      [row({ market_multiplier: 2 })],
      4.5,
    );
    // 25 × 4.5 × 2 = 225
    expect(plan.actions[0].to).toBe(225);
  });
});
