import {
  BONUS_BP_FULL,
  allocateBonusSen,
  bonusBpFor,
  bonusShareMyr,
  bonusShareSen,
  consumeBonusSen,
  normalSenSql,
  paidPullSource,
  reasonCashSenSql,
} from '../bonus-credit';

describe('bonus credit math', () => {
  it('consumes bonus first, never more than the total or the balance', () => {
    expect(consumeBonusSen(30000, 27000)).toBe(27000);
    expect(consumeBonusSen(30000, 50000)).toBe(30000);
    expect(consumeBonusSen(30000, 0)).toBe(0);
    expect(consumeBonusSen(30000, -5)).toBe(0);
    expect(consumeBonusSen(0, 100)).toBe(0);
  });

  it('allocates bonus row by row, at most one partial row', () => {
    expect(allocateBonusSen(30000, 2, 40000)).toEqual([30000, 10000]);
    expect(allocateBonusSen(30000, 3, 27000)).toEqual([27000, 0, 0]);
    expect(allocateBonusSen(30000, 1, 0)).toEqual([0]);
    expect(allocateBonusSen(30000, 0, 500)).toEqual([]);
  });

  it('turns bonus sen into basis points of the row price', () => {
    expect(bonusBpFor(27000, 30000)).toBe(9000);
    expect(bonusBpFor(30000, 30000)).toBe(BONUS_BP_FULL);
    // Rounded UP: a sliver of bonus never reads as an all-normal row.
    expect(bonusBpFor(10000, 30000)).toBe(3334);
    expect(bonusBpFor(1, 30000)).toBe(1);
    expect(bonusBpFor(100, 0)).toBe(0);
  });

  it('splits a sell-back by basis points', () => {
    expect(bonusShareSen(27000, 9000)).toBe(24300);
    expect(bonusShareSen(27000, BONUS_BP_FULL)).toBe(27000);
    expect(bonusShareSen(27000, 0)).toBe(0);
    expect(bonusShareSen(27000, 20000)).toBe(27000);
    expect(bonusShareSen(27001, 3334)).toBe(9003); // 9002.13 → up
    expect(bonusShareSen(1, 1)).toBe(1);
    expect(bonusShareMyr(270, 9000)).toBe(243);
    expect(bonusShareMyr(0.07, 5000)).toBe(0.04);
  });

  it('calls a paid row a bonus open only when bonus paid at least half', () => {
    // RM 5 of leftover bonus on a RM 300 open: still a real-money open.
    expect(paidPullSource(bonusBpFor(500, 30000))).toBe('pack');
    expect(paidPullSource(4999)).toBe('pack');
    expect(paidPullSource(5000)).toBe('bonus');
    expect(paidPullSource(BONUS_BP_FULL)).toBe('bonus');
    expect(paidPullSource(0)).toBe('pack');
  });

  it('spells the normal part of a ledger row one way', () => {
    expect(normalSenSql()).toBe('(ROUND(amount * 100) - COALESCE(bonus_cents, 0))');
    expect(normalSenSql('ct.')).toBe(
      '(ROUND(ct.amount * 100) - COALESCE(ct.bonus_cents, 0))',
    );
    // A bonus grant is all bonus: its own bucket keeps the whole amount.
    expect(reasonCashSenSql()).toContain("WHEN reason = 'bonus_grant' THEN ROUND(amount * 100)");
  });
});
