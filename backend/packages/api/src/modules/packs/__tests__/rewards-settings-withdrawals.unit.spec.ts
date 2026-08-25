import { validateRewardsPatch } from '../rewards-settings-validate';

describe('validateRewardsPatch — withdrawals_per_day', () => {
  test('rejects withdrawals_per_day: 0 (must be >= 1)', () => {
    expect(() => validateRewardsPatch({ withdrawals_per_day: 0 })).toThrow(/withdrawals_per_day/i);
  });

  test('rejects withdrawals_per_day: -1', () => {
    expect(() => validateRewardsPatch({ withdrawals_per_day: -1 })).toThrow(/withdrawals_per_day/i);
  });

  test('rejects non-integer withdrawals_per_day', () => {
    expect(() => validateRewardsPatch({ withdrawals_per_day: 1.5 })).toThrow(/withdrawals_per_day/i);
  });

  test('rejects string withdrawals_per_day (typeof guard)', () => {
    expect(() => validateRewardsPatch({ withdrawals_per_day: '2' })).toThrow(/withdrawals_per_day/i);
  });

  test('accepts withdrawals_per_day: 1', () => {
    expect(validateRewardsPatch({ withdrawals_per_day: 1 })).toEqual({ withdrawals_per_day: 1 });
  });

  test('accepts withdrawals_per_day: 2', () => {
    expect(validateRewardsPatch({ withdrawals_per_day: 2 })).toEqual({ withdrawals_per_day: 2 });
  });

  test('ignores an unknown key alongside a valid one', () => {
    const result = validateRewardsPatch({ withdrawals_per_day: 3, nonsense: 5 });
    expect(result).toEqual({ withdrawals_per_day: 3 });
  });

  test('rejects a patch with no recognised key', () => {
    expect(() => validateRewardsPatch({ nonsense: 5 })).toThrow(
      /No valid settings to update/i,
    );
  });
});
