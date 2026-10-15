import {
  BONUS_BP_FULL,
  allocateBonusSen,
  bonusBpFor,
  bonusShareMyr,
  bonusShareSen,
  consumeBonusSen,
  normalSenSql,
  openBonusBp,
  paidPullSource,
  reasonCashSenSql,
  releasableRewardHoldSen,
  sellbackHoldBp,
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

  it('gives the free welcome pull a full bonus share, a paid open its own', () => {
    expect(openBonusBp(true, 0, 0)).toBe(BONUS_BP_FULL);
    expect(openBonusBp(false, 0, 3000)).toBe(0);
    expect(openBonusBp(false, 1500, 3000)).toBe(5000);
  });

  it('spells the normal part of a ledger row one way', () => {
    expect(normalSenSql()).toBe('(ROUND(amount * 100) - COALESCE(bonus_cents, 0))');
    expect(normalSenSql('ct.')).toBe(
      '(ROUND(ct.amount * 100) - COALESCE(ct.bonus_cents, 0))',
    );
    // A bonus grant is all bonus: its own bucket keeps the whole amount.
    // So is a task / challenge prize (2026-10-11): its reward bucket keeps the
    // whole amount instead of reading RM 0.
    expect(reasonCashSenSql()).toContain(
      "WHEN reason IN ('bonus_grant', 'reward_credit', 'voucher_claim') THEN ROUND(amount * 100)",
    );
  });
});

describe('sellbackHoldBp: the share of a sale held for packs (2026-10-15)', () => {
  const pull = (source: string, pack_id: string, bonus_bp: number | null) => ({
    source,
    pack_id,
    bonus_bp,
  });

  it('holds nothing of a task or challenge reward: its sale is withdrawable', () => {
    expect(sellbackHoldBp(pull('reward', 'task-reward', BONUS_BP_FULL))).toBe(0);
    expect(
      sellbackHoldBp(pull('reward', 'challenge-2026-10-12', BONUS_BP_FULL)),
    ).toBe(0);
    // A free rip (task pack reward) opens a REAL pack: a reward all the same.
    expect(sellbackHoldBp(pull('reward', 'bronze', BONUS_BP_FULL))).toBe(0);
    expect(
      sellbackHoldBp(pull('reward', 'challenge-cup-2026', BONUS_BP_FULL)),
    ).toBe(0);
  });

  it('holds nothing of an admin gift pack pull', () => {
    expect(sellbackHoldBp(pull('gift', 'bronze', BONUS_BP_FULL))).toBe(0);
  });

  it('keeps the bonus share of the welcome pull and bonus opens', () => {
    expect(sellbackHoldBp(pull('free', 'welcome', BONUS_BP_FULL))).toBe(
      BONUS_BP_FULL,
    );
    expect(sellbackHoldBp(pull('bonus', 'bronze', 3334))).toBe(3334);
    expect(sellbackHoldBp(pull('pack', 'bronze', 0))).toBe(0);
    expect(sellbackHoldBp({ bonus_bp: null })).toBe(0);
  });
});

describe('releasableRewardHoldSen: releasing old reward / gift holds once', () => {
  // Rows newest first, as the service reads them.
  const rows = [
    { id: 'new', heldSen: 1500 },
    { id: 'old', heldSen: 3000 },
  ];

  it('releases nothing when nothing is held', () => {
    expect(releasableRewardHoldSen({ remainingSen: 0, rows })).toEqual([]);
    expect(releasableRewardHoldSen({ remainingSen: -50, rows })).toEqual([]);
    expect(releasableRewardHoldSen({ remainingSen: 2000, rows: [] })).toEqual(
      [],
    );
  });

  it('releases every stamp when they are all still held', () => {
    expect(releasableRewardHoldSen({ remainingSen: 4500, rows })).toEqual([
      { id: 'new', releaseSen: 1500 },
      { id: 'old', releaseSen: 3000 },
    ]);
  });

  it('releases only what is still held, newest rows first', () => {
    // Opens already spent RM 25 of the RM 45 stamped.
    expect(releasableRewardHoldSen({ remainingSen: 2000, rows })).toEqual([
      { id: 'new', releaseSen: 1500 },
      { id: 'old', releaseSen: 500 },
    ]);
  });

  it('never releases a top-up hold beyond the stamps', () => {
    // RM 100 still held, RM 45 of it from reward stamps: RM 55 of top-up stays.
    const out = releasableRewardHoldSen({ remainingSen: 10000, rows });
    expect(out.reduce((t, r) => t + r.releaseSen, 0)).toBe(4500);
  });

  it('ignores a row with no stamp left', () => {
    expect(
      releasableRewardHoldSen({
        remainingSen: 4500,
        rows: [{ id: 'spent', heldSen: 0 }, ...rows],
      }),
    ).toEqual([
      { id: 'new', releaseSen: 1500 },
      { id: 'old', releaseSen: 3000 },
    ]);
  });
});
