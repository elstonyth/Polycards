import {
  depositAuditNote,
  ledgerTrail,
  stampNote,
  withdrawalAuditNote,
} from '../gateway-audit';

const paid = (amount: number) => ({
  kind: 'detail' as const,
  state: 'success' as const,
  amount,
});
const failed = { kind: 'detail' as const, state: 'failed' as const, amount: 0 };
const pending = {
  kind: 'detail' as const,
  state: 'pending' as const,
  amount: 0,
};
const missing = { kind: 'not-found' as const };

describe('depositAuditNote', () => {
  it('agrees when a settled row matches a paid gateway record to the cent', () => {
    expect(
      depositAuditNote({ status: 'settled', amount: 50 }, paid(50)),
    ).toBeNull();
    expect(
      depositAuditNote({ status: 'settled', amount: 50 }, paid(50.004)),
    ).toBeNull();
  });

  it('flags an amount mismatch, a failed/pending gateway state, and a missing record', () => {
    expect(
      depositAuditNote({ status: 'settled', amount: 50 }, paid(49)),
    ).toMatch(/paid 49\.00, row credited 50\.00/);
    expect(depositAuditNote({ status: 'settled', amount: 50 }, failed)).toMatch(
      /FAILED/,
    );
    expect(
      depositAuditNote({ status: 'settled', amount: 50 }, pending),
    ).toMatch(/pending/);
    expect(
      depositAuditNote({ status: 'settled', amount: 50 }, missing),
    ).toMatch(/NO record/);
  });

  // 2026-10-14 prod: 418 of 420 findings were this. The customer opened a
  // top-up and never paid; the gateway never closes the order. Not a
  // disagreement. If they pay later the gateway says PAID, which the 7-day
  // re-check reports below.
  it('an expired top-up the gateway still shows unpaid is no finding', () => {
    expect(
      depositAuditNote({ status: 'expired', amount: null }, pending),
    ).toBeNull();
  });

  it('a failed top-up the gateway now shows pending is still a finding', () => {
    expect(
      depositAuditNote({ status: 'failed', amount: null }, pending),
    ).toMatch(/pending for a row we marked failed/);
  });

  it('a written-off row the gateway says was PAID is the loudest finding', () => {
    expect(
      depositAuditNote({ status: 'expired', amount: null }, paid(50)),
    ).toMatch(/PAID.*not credited/);
    expect(
      depositAuditNote({ status: 'failed', amount: null }, failed),
    ).toBeNull();
    expect(
      depositAuditNote({ status: 'failed', amount: null }, missing),
    ).toBeNull();
  });
});

describe('withdrawalAuditNote', () => {
  it('agrees on a matched settled payout and on a failed row the gateway also failed', () => {
    expect(
      withdrawalAuditNote({ status: 'settled', amount: 100 }, paid(100)),
    ).toBeNull();
    expect(
      withdrawalAuditNote({ status: 'failed', amount: 100 }, failed),
    ).toBeNull();
    expect(
      withdrawalAuditNote({ status: 'failed', amount: 100 }, missing),
    ).toBeNull();
  });

  it('a refunded row the gateway paid out is a double-payment finding', () => {
    expect(
      withdrawalAuditNote({ status: 'failed', amount: 100 }, paid(100)),
    ).toMatch(/DOUBLE PAYMENT/);
    expect(
      withdrawalAuditNote({ status: 'settled', amount: 100 }, failed),
    ).toMatch(/not refunded/);
    expect(
      withdrawalAuditNote({ status: 'settled', amount: 100 }, paid(90)),
    ).toMatch(/paid out 90\.00, row debited 100\.00/);
    expect(
      withdrawalAuditNote({ status: 'settled', amount: 100 }, missing),
    ).toMatch(/NO record/);
  });
});

// The note tells an operator what to do with money, so it must say what the
// ledger holds. Written from the row alone it told staff to refund a payout
// already refunded by hand (PC-4081a243…, 2026-10-18).
describe('a note that knows what the ledger holds', () => {
  const nothing = { anchored: false, hand: false };
  const settledPayout = { status: 'settled', amount: 100 };
  const writtenOff = { status: 'expired', amount: null };

  it('a settled payout refunded by hand says so and warns against refunding', () => {
    const note = withdrawalAuditNote(settledPayout, failed, {
      anchored: false,
      hand: true,
    });
    expect(note).toMatch(/gateway says the payout FAILED/);
    expect(note).toMatch(/hand adjustment names this payout/);
    expect(note).toMatch(/do not refund again/);
    expect(note).not.toMatch(/not refunded/);
  });

  it('a settled payout whose refund is on the ledger says so', () => {
    const note = withdrawalAuditNote(settledPayout, failed, {
      anchored: true,
      hand: false,
    });
    expect(note).toMatch(/refund is already on the ledger/);
    expect(note).not.toMatch(/not refunded/);
  });

  it('only a payout with nothing on the ledger reads "not refunded"', () => {
    expect(withdrawalAuditNote(settledPayout, failed, nothing)).toMatch(
      /not refunded/,
    );
  });

  it('a written-off deposit whose credit is on the ledger says not to credit again', () => {
    const note = depositAuditNote(writtenOff, paid(50), {
      anchored: true,
      hand: false,
    });
    expect(note).toMatch(/gateway says PAID \(50\.00\)/);
    expect(note).toMatch(/credit is already on the ledger/);
    expect(note).not.toMatch(/not credited/);
  });

  it('a written-off deposit credited by hand says not to credit again', () => {
    const note = depositAuditNote(writtenOff, paid(50), {
      anchored: false,
      hand: true,
    });
    expect(note).toMatch(/hand adjustment names this deposit/);
    expect(note).not.toMatch(/not credited/);
  });

  it('a written-off deposit with nothing on the ledger points at the safe credit', () => {
    const note = depositAuditNote(writtenOff, paid(50), nothing);
    expect(note).toMatch(/not credited/);
    expect(note).toMatch(/Credit deposit/);
    expect(note).toMatch(/never a hand adjustment/);
  });

  // A settled deposit the gateway failed still carries its credit, by design.
  it('leaves other findings as they were', () => {
    expect(
      depositAuditNote({ status: 'settled', amount: 50 }, failed, {
        anchored: true,
        hand: false,
      }),
    ).toBe(
      'gateway says FAILED but the row is settled — credit issued without gateway confirmation, investigate',
    );
    expect(
      withdrawalAuditNote({ status: 'failed', amount: 100 }, paid(100), nothing),
    ).toMatch(/DOUBLE PAYMENT/);
  });
});

describe('ledgerTrail', () => {
  type Row = { id?: string; reference?: string | null };
  const packs = (anchored: Row[], hand: Row[]) => ({
    listCreditTransactions: jest.fn(
      async (f: { customer_id: string; source_transaction_id?: string }) =>
        f.source_transaction_id ? anchored : hand,
    ),
  });
  const lookup = {
    customerId: 'cus_1',
    anchor: 'wd-refund:abc',
    refs: ['PC-4081', 'W2026101700000029', null],
  };

  it('finds the anchor', async () => {
    await expect(
      ledgerTrail(packs([{ id: 'ct_1' }], []), lookup),
    ).resolves.toEqual({ anchored: true, hand: false });
  });

  it('finds a hand adjustment that names either reference', async () => {
    // The reference on the real 10-18 refund, shortened.
    const refund = {
      reference:
        'Refund RM100 for returned A3Pay payout W2026101700000029; merchant PC-4081',
    };
    await expect(
      ledgerTrail(packs([], [{ reference: 'wy' }, refund]), lookup),
    ).resolves.toEqual({ anchored: false, hand: true });
  });

  it('ignores adjustments that name something else, and rows with no reference', async () => {
    await expect(
      ledgerTrail(
        packs([], [{ reference: 'Goodwill' }, { reference: null }]),
        lookup,
      ),
    ).resolves.toEqual({ anchored: false, hand: false });
  });

  it('reads only this customer', async () => {
    const p = packs([], []);
    await ledgerTrail(p, lookup);
    for (const [filter] of p.listCreditTransactions.mock.calls as unknown as [
      { customer_id: string },
    ][]) {
      expect(filter.customer_id).toBe('cus_1');
    }
  });
});

// Every writer of audit_note goes through stampNote (the audit job, the
// TGPay-family and A3Pay payout callbacks): an acknowledgement covers the note
// it was given for, nothing after it.
describe('stampNote', () => {
  const acked = { audit_ack_note: 'old note' };
  it('keeps an acknowledgement while the note is the one acknowledged', () => {
    expect(stampNote(acked, 'old note')).toEqual({ audit_note: 'old note' });
  });
  it('drops it for any other note, agreement included', () => {
    const cleared = {
      audit_ack_note: null,
      audit_ack_by: null,
      audit_ack_at: null,
    };
    expect(stampNote(acked, 'new note')).toEqual({
      audit_note: 'new note',
      ...cleared,
    });
    expect(stampNote(acked, null)).toEqual({ audit_note: null, ...cleared });
  });
  it('writes only the note on a row nobody acknowledged', () => {
    expect(stampNote({ audit_ack_note: null }, 'n')).toEqual({ audit_note: 'n' });
    expect(stampNote({}, null)).toEqual({ audit_note: null });
  });
});
