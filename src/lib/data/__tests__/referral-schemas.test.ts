import { describe, expect, it } from 'vitest';
import {
  CREDIT_REASONS,
  ReferralSummarySchema,
  VipRebateSchema,
} from '@/lib/data/schemas';
import { reasonLabel } from '@/lib/transactions';

const historyRow = {
  week_start: '2026-08-18',
  basis_cents: 15_000,
  rate_bp: 50,
  amount_cents: 75,
  status: 'paid',
};

describe('ReferralSummarySchema', () => {
  const valid = {
    handle: 'collector-abc123',
    downline_count: 3,
    week: {
      start: '2026-08-25',
      turnover_cents: 100_000,
      rate_bp: 50,
      projected_cents: 500,
      partner: false,
    },
    history: [historyRow],
  };

  it('parses the backend payload', () => {
    const parsed = ReferralSummarySchema.parse(valid);
    expect(parsed.week.projected_cents).toBe(500);
    expect(parsed.history).toHaveLength(1);
  });

  it('tolerates extra keys (deploy-skew rule) but rejects missing ones', () => {
    expect(() =>
      ReferralSummarySchema.parse({ ...valid, future_field: 1 }),
    ).not.toThrow();
    const { week, ...withoutWeek } = valid;
    void week;
    expect(() => ReferralSummarySchema.parse(withoutWeek)).toThrow();
  });
});

describe('VipRebateSchema', () => {
  const valid = {
    level: 12,
    rebate_bp: 100,
    week: { start: '2026-08-25', turnover_cents: 50_000, projected_cents: 500 },
    history: [],
  };

  it('parses the backend payload', () => {
    expect(VipRebateSchema.parse(valid).level).toBe(12);
  });

  it('rejects a non-numeric level', () => {
    expect(() => VipRebateSchema.parse({ ...valid, level: 'x' })).toThrow();
  });
});

describe('the new credit reasons', () => {
  it('are in the known enum and carry labels', () => {
    expect(CREDIT_REASONS).toContain('referral_commission');
    expect(CREDIT_REASONS).toContain('vip_rebate');
    expect(reasonLabel('referral_commission')).toBe('Referral commission');
    expect(reasonLabel('vip_rebate')).toBe('VIP rebate');
  });
});
