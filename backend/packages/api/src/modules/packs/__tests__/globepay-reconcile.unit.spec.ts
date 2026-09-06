import {
  GLOBEPAY_AMBIGUOUS_GIVEUP_DEFAULT_MS,
  GLOBEPAY_FULL_SWEEP_EVERY_MIN,
  GLOBEPAY_STALE_AFTER_MS,
  ambiguousGiveUpMs,
  ambiguousRefusalAction,
  classifyRequeryError,
  isFullSweepDue,
  reconcileAction,
  unknownDepositAction,
  unknownWithdrawalAction,
} from '../globepay-reconcile';
import { GLOBEPAY_MAX_RM } from '../globepay-deposit';
import { GatewayError } from '../gateway-types';
import { TGPAY_NOT_FOUND } from '../tgpay-client';

const now = new Date('2026-07-21T12:00:00Z');
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60 * 1000);

describe('isFullSweepDue', () => {
  const at = (iso: string) => new Date(iso);

  it('runs a full sweep on the first run after boot', () => {
    // null marker = we have never covered every tier in this process. Erring
    // toward MORE coverage is the whole point of resetting on restart.
    expect(isFullSweepDue(at('2026-08-11T09:04:11Z'), null)).toBe(true);
  });

  it('keeps the fast tier until the interval has elapsed', () => {
    const last = at('2026-08-11T09:10:00Z');
    // The property the job depends on: a run that is NOT a full sweep still
    // runs, it just narrows to the fast window. A regression that made every
    // run a full sweep would requery week-old rows sixty times an hour.
    expect(isFullSweepDue(at('2026-08-11T09:11:00Z'), last)).toBe(false);
    expect(isFullSweepDue(at('2026-08-11T09:19:59Z'), last)).toBe(false);
  });

  it('runs a full sweep once the interval has elapsed, to the millisecond', () => {
    const last = at('2026-08-11T09:10:00Z');
    expect(isFullSweepDue(at('2026-08-11T09:20:00Z'), last)).toBe(true);
    expect(isFullSweepDue(at('2026-08-11T09:20:01Z'), last)).toBe(true);
  });

  it('still covers a run that arrives LATE — the bug this replaced', () => {
    // The old predicate keyed on minute-of-hour, so a run picked up at :11
    // instead of :10 skipped that decade's full sweep entirely, with no
    // catch-up and no log. Every scheduled job shares one BullMQ worker at
    // concurrency 1, so a late pickup does not even require this handler to be
    // slow. Elapsed-time asks "has it been long enough", so lateness delays the
    // sweep, it never cancels it.
    const last = at('2026-08-11T09:10:00Z');
    for (const late of ['09:21:00', '09:37:00', '11:02:00']) {
      expect(isFullSweepDue(at(`2026-08-11T${late}Z`), last)).toBe(true);
    }
  });

  it('honours GLOBEPAY_FULL_SWEEP_EVERY_MIN rather than a hardcoded ten', () => {
    const last = at('2026-08-11T09:00:00Z');
    const justUnder = new Date(
      last.getTime() + GLOBEPAY_FULL_SWEEP_EVERY_MIN * 60 * 1000 - 1,
    );
    const exactly = new Date(
      last.getTime() + GLOBEPAY_FULL_SWEEP_EVERY_MIN * 60 * 1000,
    );
    expect(isFullSweepDue(justUnder, last)).toBe(false);
    expect(isFullSweepDue(exactly, last)).toBe(true);
  });
});

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
// merchant id and an IP de-whitelisting all produce one. Only the explicit
// not-found code (minted by the client on the gateway's own "transaction
// not found" answer) may authorise an action.
describe('classifyRequeryError', () => {
  it('acts only on the explicit not-found code', () => {
    expect(
      classifyRequeryError(
        new GatewayError('nope', [TGPAY_NOT_FOUND], 404, true),
      ),
    ).toEqual({ kind: 'not-found' });
  });

  it('honours the not-found code at any HTTP status', () => {
    expect(
      classifyRequeryError(
        new GatewayError('nope', [TGPAY_NOT_FOUND], 200, true),
      ),
    ).toEqual({ kind: 'not-found' });
  });

  it('treats a 400 with no not-found code as ambiguous, never not-found', () => {
    const refusal = classifyRequeryError(
      new GatewayError('Invalid merchant', ['SOME_OTHER_CODE'], 400, true),
    );
    expect(refusal).toEqual({ kind: 'ambiguous' });
    expect(refusal.kind).not.toBe('not-found');
  });

  it('treats a bare 400 with NO codes as ambiguous — this is the real staging shape', () => {
    expect(
      classifyRequeryError(
        new GatewayError('non-JSON response (HTTP 400): Not found', [], 400),
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
      classifyRequeryError(new GatewayError('boom', [], 500)),
    ).toEqual({ kind: 'rethrow' });
  });
});

// Waiting forever is its own outage: these rows sit in a 50-row, oldest-first
// window and would starve the sweep of fresh deposits whose callback was
// dropped. The bound ends that WITHOUT writing anything off.
describe('ambiguousRefusalAction', () => {
  it('waits while the row is younger than the give-up bound', () => {
    expect(
      ambiguousRefusalAction(
        new Date(now.getTime() - GLOBEPAY_AMBIGUOUS_GIVEUP_DEFAULT_MS + 1000),
        now,
      ),
    ).toEqual({ kind: 'wait' });
  });

  it('waits well past the ordinary stale window — an outage lasts days', () => {
    // The whole point of the bound being a week: a two-day credential breakage
    // must not sweep the live queue out of 'pending'.
    expect(
      ambiguousRefusalAction(
        new Date(now.getTime() - GLOBEPAY_STALE_AFTER_MS * 48),
        now,
      ),
    ).toEqual({ kind: 'wait' });
  });

  it('expires — never fails — once past the bound', () => {
    const action = ambiguousRefusalAction(
      new Date(now.getTime() - GLOBEPAY_AMBIGUOUS_GIVEUP_DEFAULT_MS - 1000),
      now,
    );
    expect(action).toEqual({ kind: 'expire' });
    // 'expired' stays requeryable and callback-recoverable; 'fail' would not.
    expect(action.kind).not.toBe('fail');
  });

  it('honours the env override without touching process.env', () => {
    const env = { GLOBEPAY_AMBIGUOUS_GIVEUP_MS: '1000' };
    expect(
      ambiguousRefusalAction(new Date(now.getTime() - 2000), now, env),
    ).toEqual({ kind: 'expire' });
    expect(ambiguousGiveUpMs(env)).toBe(1000);
  });

  it('falls back to the default on junk or non-positive env values', () => {
    expect(ambiguousGiveUpMs({ GLOBEPAY_AMBIGUOUS_GIVEUP_MS: 'soon' })).toBe(
      GLOBEPAY_AMBIGUOUS_GIVEUP_DEFAULT_MS,
    );
    expect(ambiguousGiveUpMs({ GLOBEPAY_AMBIGUOUS_GIVEUP_MS: '0' })).toBe(
      GLOBEPAY_AMBIGUOUS_GIVEUP_DEFAULT_MS,
    );
    expect(ambiguousGiveUpMs({})).toBe(GLOBEPAY_AMBIGUOUS_GIVEUP_DEFAULT_MS);
  });
});

// The end-to-end invariant both sweeps encode: an ambiguous refusal never
// moves money and never closes a row. Asserted against the classifier's own
// output, because that is the only value the jobs branch on.
describe('an ambiguous 400 can never reach a money-moving action', () => {
  const ambiguous400s = [
    new GatewayError('non-JSON response (HTTP 400): Not found', [], 400),
    new GatewayError('Invalid merchant', ['PMT10006'], 400, true),
    new GatewayError('unknown error', [], 400, true),
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
