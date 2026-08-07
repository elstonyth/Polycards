import {
  GLOBEPAY_STALE_AFTER_MS,
  reconcileAction,
  unknownDepositAction,
} from '../globepay-reconcile';
import { GLOBEPAY_MAX_RM } from '../globepay-deposit';

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
  it('waits on a fresh unknown deposit — the submit may still be in flight', () => {
    expect(unknownDepositAction(minutesAgo(1), now)).toEqual({ kind: 'wait' });
  });

  it('gives up on an old unknown deposit — nobody can ever pay it', () => {
    expect(
      unknownDepositAction(
        new Date(now.getTime() - GLOBEPAY_STALE_AFTER_MS - 1000),
        now,
      ),
    ).toEqual({ kind: 'expire' });
  });
});
