import type { PricingIssue } from './admin-rest';

export const PRICING_FILTERS = [
  'all',
  'attention',
  'pending_confirmation',
  'sync_error',
  'never_synced',
  'stale',
  'unlinked',
  'missing_product',
] as const;

export type PricingFilter = (typeof PRICING_FILTERS)[number];

export const pricingFilterFromParam = (value: string | null): PricingFilter =>
  PRICING_FILTERS.find((filter) => filter === value) ?? 'all';

export const matchesPricingFilter = (
  issue: PricingIssue | undefined,
  filter: PricingFilter,
): boolean =>
  filter === 'all' ||
  (!!issue && (filter === 'attention' || issue.reason === filter));
