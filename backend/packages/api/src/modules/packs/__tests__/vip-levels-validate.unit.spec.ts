import { validateVipLevels } from '../vip-levels-validate';
import { MAX_VOUCHER_MYR } from '../voucher-ranges';

const rung = (over: Partial<Record<string, unknown>> = {}) => ({
  level: 1,
  spend_threshold: 0,
  voucher_amount: 0,
  box_tier: 'a',
  frame_unlock: false,
  ...over,
});

const ladder = (rungs: Record<string, unknown>[]) => ({ levels: rungs });

describe('validateVipLevels', () => {
  it('accepts a minimal 1-rung ladder with threshold 0', () => {
    const out = validateVipLevels(ladder([rung()]));
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      level: 1,
      spend_threshold: 0,
      voucher_amount: 0,
      box_tier: 'a',
      frame_unlock: false,
    });
  });

  it('accepts a decade-10 rung carrying frame_unlock', () => {
    const rungs = Array.from({ length: 10 }, (_, i) =>
      rung({
        level: i + 1,
        spend_threshold: i * 100,
        frame_unlock: i + 1 === 10,
      }),
    );
    expect(validateVipLevels(ladder(rungs))).toHaveLength(10);
  });

  it('rejects a non-array / empty ladder', () => {
    expect(() => validateVipLevels({ levels: 'x' })).toThrow(/must be an array/);
    expect(() => validateVipLevels(ladder([]))).toThrow(/at least 1 level/);
  });

  it('rejects a level gap or duplicate (non-contiguous 1..N)', () => {
    expect(() =>
      validateVipLevels(ladder([rung(), rung({ level: 3, spend_threshold: 5 })])),
    ).toThrow(/must be 2 \(contiguous/);
    expect(() =>
      validateVipLevels(ladder([rung(), rung({ level: 1, spend_threshold: 5 })])),
    ).toThrow(/must be 2 \(contiguous/);
  });

  it('requires rung 1 threshold to be exactly 0', () => {
    expect(() => validateVipLevels(ladder([rung({ spend_threshold: 5 })]))).toThrow(
      /level 1: spend_threshold must be 0/,
    );
  });

  it('requires strictly-increasing thresholds', () => {
    expect(() =>
      validateVipLevels(
        ladder([rung(), rung({ level: 2, spend_threshold: 0 })]),
      ),
    ).toThrow(/level 2: spend_threshold must exceed level 1's/);
  });

  it('rejects frame_unlock on a non-decade level', () => {
    expect(() => validateVipLevels(ladder([rung({ frame_unlock: true })]))).toThrow(
      /decade levels/,
    );
  });

  it('rejects negative voucher_amount', () => {
    expect(() => validateVipLevels(ladder([rung({ voucher_amount: -1 })]))).toThrow(
      /voucher_amount must be between 0 and/,
    );
  });

  it('rejects frame_unlock above level 100 but accepts the ladder without it', () => {
    const rungs = (frameAt110: boolean) =>
      Array.from({ length: 110 }, (_, i) =>
        rung({
          level: i + 1,
          spend_threshold: i * 100,
          frame_unlock: frameAt110 && i + 1 === 110,
        }),
      );
    expect(() => validateVipLevels(ladder(rungs(true)))).toThrow(/decade levels/);
    expect(validateVipLevels(ladder(rungs(false)))).toHaveLength(110);
  });

  it('accepts voucher_amount exactly at the cap but rejects one above it', () => {
    expect(
      validateVipLevels(ladder([rung({ voucher_amount: MAX_VOUCHER_MYR })])),
    ).toHaveLength(1);
    expect(() =>
      validateVipLevels(ladder([rung({ voucher_amount: MAX_VOUCHER_MYR + 1 })])),
    ).toThrow(/voucher_amount must be between 0 and/);
  });

  it('rejects a spend_threshold above the sanity ceiling', () => {
    expect(() =>
      validateVipLevels(
        ladder([rung(), rung({ level: 2, spend_threshold: 100_000_001 })]),
      ),
    ).toThrow(/spend_threshold must be <=/);
  });

  it('rejects a blank box_tier', () => {
    expect(() => validateVipLevels(ladder([rung({ box_tier: '  ' })]))).toThrow(
      /box_tier is required/,
    );
  });
});
