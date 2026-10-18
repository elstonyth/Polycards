import {
  depositAuditNote,
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
