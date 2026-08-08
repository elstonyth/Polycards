import { planPcListingPriceBackfill } from '../backfill-pc-listing-prices.helpers';

const row = (
  over: Partial<Parameters<typeof planPcListingPriceBackfill>[0][number]> = {},
) => ({
  product_id: 'prod_1',
  handle: 'h1',
  is_card: false,
  fmv_usd: 100,
  variant_id: 'var_1',
  current_myr: 400,
  ...over,
});

describe('planPcListingPriceBackfill', () => {
  it('plans FMV × fx × 1.2 for a pre-fix listing', () => {
    // 100 USD × 4.0 × 1.2 = 480; the pre-fix listing sits at 400.
    const plan = planPcListingPriceBackfill([row()], 4.0);
    expect(plan.actions).toEqual([
      {
        product_id: 'prod_1',
        handle: 'h1',
        variant_id: 'var_1',
        from: 400,
        to: 480,
      },
    ]);
  });

  it('is idempotent: a row already at target plans nothing', () => {
    const plan = planPcListingPriceBackfill([row({ current_myr: 480 })], 4.0);
    expect(plan.actions).toEqual([]);
    expect(plan.skippedCurrent).toBe(1);
  });

  it('never touches card-managed products', () => {
    const plan = planPcListingPriceBackfill([row({ is_card: true })], 4.0);
    expect(plan.actions).toEqual([]);
    expect(plan.skippedCard).toBe(1);
  });

  it('skips rows with no FMV or no variant rather than defaulting', () => {
    const plan = planPcListingPriceBackfill(
      [row({ fmv_usd: null }), row({ variant_id: null })],
      4.0,
    );
    expect(plan.actions).toEqual([]);
    expect(plan.skippedNoFmv).toBe(1);
    expect(plan.skippedNoVariant).toBe(1);
  });

  it('updates a variant that somehow has no MYR price at all', () => {
    const plan = planPcListingPriceBackfill([row({ current_myr: null })], 4.0);
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0].from).toBeNull();
    expect(plan.actions[0].to).toBe(480);
  });
});
