import { describe, expect, it } from 'vitest';
import type { PricingIssue } from './admin-rest';
import { matchesPricingFilter, pricingFilterFromParam } from './pricing-filter';

const issue: PricingIssue = {
  handle: 'mewtwo',
  name: 'Mewtwo',
  pc_product_id: '157',
  pc_grade: 'Ungraded',
  market_value: 875,
  last_synced_at: null,
  reason: 'pending_confirmation',
  proposed_value: 47.5,
  first_seen_at: '2026-10-16T08:00:00Z',
  message: null,
};

describe('pricing attention filter', () => {
  it('opens the dashboard deep link and defaults invalid filters to all', () => {
    expect(
      pricingFilterFromParam(
        new URLSearchParams('pricing=attention').get('pricing'),
      ),
    ).toBe('attention');
    expect(pricingFilterFromParam(null)).toBe('all');
    expect(pricingFilterFromParam('unknown')).toBe('all');
  });

  it('includes pending and source failures, and excludes healthy cards', () => {
    expect(matchesPricingFilter(issue, 'attention')).toBe(true);
    expect(
      matchesPricingFilter({ ...issue, reason: 'sync_error' }, 'attention'),
    ).toBe(true);
    expect(matchesPricingFilter(undefined, 'attention')).toBe(false);
    expect(matchesPricingFilter(undefined, 'all')).toBe(true);
  });

  it('keeps individual reasons separate', () => {
    expect(matchesPricingFilter(issue, 'pending_confirmation')).toBe(true);
    expect(matchesPricingFilter(issue, 'stale')).toBe(false);
    expect(
      matchesPricingFilter({ ...issue, reason: 'unlinked' }, 'unlinked'),
    ).toBe(true);
    expect(
      matchesPricingFilter({ ...issue, reason: 'missing_product' }, 'unlinked'),
    ).toBe(false);
  });
});
