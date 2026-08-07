import {
  GLOBEPAY_STALE_AFTER_MS,
  classifyRequeryError,
  reconcileAction,
  unknownDepositAction,
  unknownWithdrawalAction,
} from '../globepay-reconcile';
import { GLOBEPAY_MAX_RM } from '../globepay-deposit';
import { GlobePayError } from '../globepay-client';

const now = new Date('2026-07-21T12:00:00Z');
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60 * 1000);

describe('reconcileAction', () => {
  it('settles with the amount the GATEWAY reports, not the one we requested', () => {
    expect(
      reconcileAction({
        state: 'success',
        amount: 30,
        createdAt: minutesAgo(5),
        now,
      }),
    ).toEqual({ kind: 'settle', amount: 30 });
  });

  it('settles a success no matter how old — money that landed is still owed', () => {
    // The stale window must never write off a deposit the gateway settled.
    expect(
      reconcileAction({
        state: 'success',
        amount: 50,
        createdAt: minutesAgo(60 * 24 * 7),
        now,
      }),
    ).toEqual({ kind: 'settle', amount: 50 });
  });

  // Same ceiling as the callback route, for the same reason: a requery amount
  // above what the submit path could ever have created converts 1:1 into
  // withdrawable balance. Quarantine, never settle and never write off.
  it('does NOT settle a success above the deposit ceiling', () => {
    const action = reconcileAction({
      state: 'success',
      amount: GLOBEPAY_MAX_RM + 1,
      createdAt: minutesAgo(5),
      now,
    });
    expect(action).toEqual({
      kind: 'quarantine',
      amount: GLOBEPAY_MAX_RM + 1,
    });
    // 'fail' and 'expire' are the write-off kinds — quarantine must be neither.
    expect(action.kind).not.toBe('fail');
    expect(action.kind).not.toBe('expire');
  });

  it('settles a success exactly AT the ceiling', () => {
    expect(
      reconcileAction({
        state: 'success',
        amount: GLOBEPAY_MAX_RM,
        createdAt: minutesAgo(5),
        now,
      }),
    ).toEqual({ kind: 'settle', amount: GLOBEPAY_MAX_RM });
  });

  it('closes a deposit the gateway reports as failed', () => {
    expect(
      reconcileAction({
        state: 'failed',
        amount: 50,
        createdAt: minutesAgo(5),
        now,
      }),
    ).toEqual({ kind: 'fail' });
  });

  it('waits on a recent non-final deposit — status 4 can still settle', () => {
    expect(
      reconcileAction({
        state: 'pending',
        amount: 50,
        createdAt: minutesAgo(5),
        now,
      }),
    ).toEqual({ kind: 'wait' });
  });

  it('expires a non-final deposit past the stale window', () => {
    expect(
      reconcileAction({
        state: 'pending',
        amount: 50,
        createdAt: new Date(now.getTime() - GLOBEPAY_STALE_AFTER_MS - 1000),
        now,
      }),
    ).toEqual({ kind: 'expire' });
  });

  it('does not expire exactly at the boundary', () => {
    expect(
      reconcileAction({
        state: 'pending',
        amount: 50,
        createdAt: new Date(now.getTime() - GLOBEPAY_STALE_AFTER_MS),
        now,
      }),
    ).toEqual({ kind: 'wait' });
  });
});

describe('unknownDepositAction', () => {
  const ancient = new Date(now.getTime() - GLOBEPAY_STALE_AFTER_MS - 1000);

  it('waits on a fresh unknown deposit — the submit may still be in flight', () => {
    expect(unknownDepositAction(minutesAgo(1), now, false)).toEqual({
      kind: 'wait',
    });
  });

  it('gives up on an old unknown deposit — nobody can ever pay it', () => {
    // The crash-recovery path: no gateway id means SubmitDeposit never
    // returned, so this row really is unpayable.
    expect(unknownDepositAction(ancient, now, false)).toEqual({
      kind: 'expire',
    });
  });

  // THE anti-write-off guard. Their D… id is on our row, so the deposit
  // provably exists at the gateway and "unknown" can only be our own config
  // being broken. Expiring here would write off every pending deposit the
  // moment a key rotated — including ones the customer already paid.
  it('never expires a deposit that HAS a gateway id, however old', () => {
    const action = unknownDepositAction(
      new Date(now.getTime() - GLOBEPAY_STALE_AFTER_MS * 1000),
      now,
      true,
    );
    expect(action).toEqual({ kind: 'wait' });
    expect(action.kind).not.toBe('expire');
  });
});

// A 400 is not evidence of anything on its own: a rotated key, a wrong
// merchant code and an IP de-whitelisting all produce one, and staging's real
// not-found came back as a plain-text 400 WITHOUT the documented PMT10016
// (docs/payments/globepay365-setup.md:124). Until the provider supplies the
// taxonomy, only an explicit code may authorise an action.
describe('classifyRequeryError', () => {
  it('acts only on the explicit not-found code', () => {
    expect(
      classifyRequeryError(
        new GlobePayError('nope', ['PMT10016'], 400, true),
      ),
    ).toEqual({ kind: 'not-found' });
  });

  it('honours the not-found code at any HTTP status', () => {
    expect(
      classifyRequeryError(
        new GlobePayError('nope', ['PMT10016'], 200, true),
      ),
    ).toEqual({ kind: 'not-found' });
  });

  it('treats a 400 with no not-found code as ambiguous, never not-found', () => {
    const refusal = classifyRequeryError(
      new GlobePayError('Invalid merchant', ['PMT10006'], 400, true),
    );
    expect(refusal).toEqual({ kind: 'ambiguous' });
    expect(refusal.kind).not.toBe('not-found');
  });

  it('treats a bare 400 with NO codes as ambiguous — this is the real staging shape', () => {
    expect(
      classifyRequeryError(
        new GlobePayError('non-JSON response (HTTP 400): Not found', [], 400),
      ),
    ).toEqual({ kind: 'ambiguous' });
  });

  it('rethrows anything that is not a gateway refusal', () => {
    expect(classifyRequeryError(new Error('socket hang up'))).toEqual({
      kind: 'rethrow',
    });
    expect(classifyRequeryError(undefined)).toEqual({ kind: 'rethrow' });
  });

  it('rethrows a non-400 refusal — a 500 is their outage, not our answer', () => {
    expect(
      classifyRequeryError(new GlobePayError('boom', [], 500)),
    ).toEqual({ kind: 'rethrow' });
  });
});

// The end-to-end invariant both sweeps encode: an ambiguous refusal never
// moves money and never closes a row. Asserted against the classifier's own
// output, because that is the only value the jobs branch on.
describe('an ambiguous 400 can never reach a money-moving action', () => {
  const ambiguous400s = [
    new GlobePayError('non-JSON response (HTTP 400): Not found', [], 400),
    new GlobePayError('Invalid merchant', ['PMT10006'], 400, true),
    new GlobePayError('unknown error', [], 400, true),
  ];
  const ancient = new Date(now.getTime() - GLOBEPAY_STALE_AFTER_MS * 1000);

  it.each(ambiguous400s)('deposit sweep: %s cannot expire', (error) => {
    const refusal = classifyRequeryError(error);
    expect(refusal.kind).toBe('ambiguous');
    // The job answers 'wait' directly for this kind — unknownDepositAction is
    // never even reached. Pin that: were it reached, it must not expire either
    // once a gateway id is on the row.
    expect(unknownDepositAction(ancient, now, true).kind).not.toBe('expire');
  });

  it.each(ambiguous400s)('withdrawal sweep: %s cannot refund', (error) => {
    const refusal = classifyRequeryError(error);
    expect(refusal.kind).toBe('ambiguous');
    // Even with NO gateway id — the case that used to auto-refund — an
    // ambiguous refusal must never select the refund branch.
    expect(refusal.kind).not.toBe('not-found');
    // And the explicit not-found path still refunds that same row, so this is
    // a narrowing of the trigger, not a removal of crash recovery.
    expect(unknownWithdrawalAction(ancient, now, false)).toEqual({
      kind: 'refund',
    });
  });
});
