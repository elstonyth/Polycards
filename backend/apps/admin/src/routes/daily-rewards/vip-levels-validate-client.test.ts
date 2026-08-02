import { describe, expect, test } from 'vitest';
import {
  validateVipLevelsClient,
  type VipLevelRow,
} from './vip-levels-validate-client';

const row = (over: Partial<VipLevelRow> = {}): VipLevelRow => ({
  thresholdInput: '0',
  voucherInput: '0',
  boxTier: 'a',
  frameUnlock: false,
  referralInput: '1',
  ...over,
});

describe('validateVipLevelsClient', () => {
  test('accepts a valid 2-rung ladder', () => {
    expect(
      validateVipLevelsClient([row(), row({ thresholdInput: '100' })]),
    ).toEqual([]);
  });

  test('flags an empty ladder', () => {
    expect(validateVipLevelsClient([])).toContain(
      'The ladder must have at least 1 level.',
    );
  });

  test('flags a non-zero first threshold', () => {
    expect(validateVipLevelsClient([row({ thresholdInput: '5' })])).toContain(
      'Level 1: threshold must be 0.',
    );
  });

  test('flags a non-increasing threshold', () => {
    const errs = validateVipLevelsClient([row(), row({ thresholdInput: '0' })]);
    expect(errs.some((e) => /Level 2: threshold must exceed/.test(e))).toBe(true);
  });

  test('flags frame_unlock on a non-decade level', () => {
    expect(validateVipLevelsClient([row({ frameUnlock: true })])).toContain(
      'Level 1: a frame can only unlock on a decade level (10, 20, … 100).',
    );
  });

  test('flags a negative voucher / referral', () => {
    const errs = validateVipLevelsClient([
      row({ voucherInput: '-1', referralInput: '-2' }),
    ]);
    expect(errs.some((e) => /voucher/.test(e))).toBe(true);
    expect(errs.some((e) => /referral/.test(e))).toBe(true);
  });

  test('flags a voucher amount above the 10,000 ceiling, accepts the ceiling itself', () => {
    const errs = validateVipLevelsClient([row({ voucherInput: '10001' })]);
    expect(
      errs.some((e) => /voucher amount must be between 0 and 10,000/.test(e)),
    ).toBe(true);
    expect(validateVipLevelsClient([row({ voucherInput: '10000' })])).toEqual(
      [],
    );
  });

  test('flags a referral % above 100', () => {
    const errs = validateVipLevelsClient([row({ referralInput: '101' })]);
    expect(errs.some((e) => /referral % must be between 0 and 100/.test(e))).toBe(true);
    expect(validateVipLevelsClient([row({ referralInput: '100' })])).toEqual([]);
  });

  test('flags blank inputs instead of coercing them to 0', () => {
    const errs = validateVipLevelsClient([
      row(),
      row({ thresholdInput: '', voucherInput: ' ', referralInput: '' }),
    ]);
    expect(errs.some((e) => /Level 2: threshold must be a number/.test(e))).toBe(true);
    expect(errs.some((e) => /Level 2: voucher amount/.test(e))).toBe(true);
    expect(errs.some((e) => /Level 2: referral %/.test(e))).toBe(true);
  });
});
