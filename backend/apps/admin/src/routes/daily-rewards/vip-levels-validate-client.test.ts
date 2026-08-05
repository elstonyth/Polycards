import { describe, expect, test } from 'vitest';
import {
  validateVipLevelsClient,
  voucherOutOfRange,
  type VipLevelRow,
} from './vip-levels-validate-client';
import { decadesWithErrors } from './vip-ladder-shape';

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
    expect(errs.some((e) => /Level 2: threshold must exceed/.test(e))).toBe(
      true,
    );
  });

  test('flags frame_unlock on a non-decade level', () => {
    expect(validateVipLevelsClient([row({ frameUnlock: true })])).toContain(
      'Level 1: a frame can only unlock on a decade level (10, 20, … 100).',
    );
  });

  // Referral % and box tier have no editor on the tab any more, and neither
  // bound is reachable from shipped data, so a client error on either would be
  // an uncorrectable block on saving the WHOLE ladder. Both stay enforced
  // server-side; this pins that the CLIENT stays quiet about them.
  test('does not block the ladder on referral % or box tier', () => {
    expect(
      validateVipLevelsClient([row({ referralInput: '101', boxTier: '' })]),
    ).toEqual([]);
    expect(
      validateVipLevelsClient([row({ referralInput: '', boxTier: '   ' })]),
    ).toEqual([]);
  });

  // Voucher is the exception, and the reason is live data: the shipped ladder
  // carries L90=12000 and L100=15000 against a 10,000 cap the server enforces
  // on every save. Staying quiet here would let the tab look saveable and then
  // fail server-side naming a column the admin no longer renders — bricking
  // Threshold and Frame too. The tab keys its repair input off the SAME
  // predicate, so anything flagged here is reachable and fixable.
  test('flags an over-cap voucher so the tab can offer a repair input', () => {
    const errs = validateVipLevelsClient([row({ voucherInput: '12000' })]);
    expect(
      errs.some((e) => /Level 1: voucher must be between 0 and 10,000/.test(e)),
    ).toBe(true);
    expect(voucherOutOfRange('12000')).toBe(true);
    // The real L90/L100 values, and the boundary itself.
    expect(voucherOutOfRange('15000')).toBe(true);
    expect(voucherOutOfRange('10000')).toBe(false);
    expect(voucherOutOfRange('-1')).toBe(true);
    // Blank is not a silent 0 — same rule as every other money field here.
    expect(voucherOutOfRange('')).toBe(true);
  });

  // decadesWithErrors regexes `Level (\d+)` out of these strings to force the
  // owning decade open. A voucher message that lost that prefix would leave the
  // only fixable row collapsed — the exact dead end this check exists to avoid.
  test('over-cap voucher message carries a parseable level prefix', () => {
    const ladder = Array.from({ length: 10 }, (_, i) =>
      row({
        thresholdInput: String(i * 100),
        voucherInput: i === 9 ? '12000' : '0',
      }),
    );
    const errs = validateVipLevelsClient(ladder);
    const voucherErr = errs.find((e) => /voucher/.test(e));
    expect(voucherErr).toBeDefined();
    expect(/Level (\d+)/.exec(voucherErr as string)?.[1]).toBe('10');
    // And the consumer actually resolves it to a decade to force open. L10 is
    // decade 0; the real offenders (L90, L100) land in decades 8 and 9.
    expect(decadesWithErrors([voucherErr as string])).toEqual(new Set([0]));
    expect(
      decadesWithErrors([
        'Level 90: voucher must be between 0 and 10,000 — lower it below, or have the cap raised if this rung is correct.',
        'Level 100: voucher must be between 0 and 10,000 — lower it below, or have the cap raised if this rung is correct.',
      ]),
    ).toEqual(new Set([8, 9]));
  });

  // Threshold is the one money-shaped field still edited here, so its
  // blank-is-not-zero guard has to survive the other three losing theirs.
  test('flags a blank threshold instead of coercing it to 0', () => {
    const errs = validateVipLevelsClient([row(), row({ thresholdInput: '' })]);
    expect(
      errs.some((e) => /Level 2: threshold must be a number/.test(e)),
    ).toBe(true);
  });
});
