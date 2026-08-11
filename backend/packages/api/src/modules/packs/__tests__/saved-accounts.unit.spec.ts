import { MedusaError } from '@medusajs/framework/utils';
import {
  payoutDestinationCooldownHours,
  resolveWithdrawalDestination,
  savedBankAccountId,
  type SavedBankAccount,
} from '../saved-accounts';

// resolveWithdrawalDestination is the ONLY place the payout path learns a bank
// code and an account number — POST /store/credits/withdraw submits an
// `account_id` and no bank fields at all. So the id→account binding IS the
// destination control, and it rests entirely on
// id === sha256(bankCode, accountNumber).
//
// Every writer computes that id today, which makes the invariant a convention.
// These cases pin the READ-side enforcement, so a future writer that forgets
// savedBankAccountId (or anything that reaches customer.metadata directly)
// cannot turn a stored row into an arbitrary payout destination.

const OWNER_BANK = 'MBB';
const OWNER_NUMBER = '1234567890';
// Far enough in the past that the cooling-off window is never what refuses
// below — every refusal in this file must come from the id check.
const SAVED_AT = '2020-01-01T00:00:00.000Z';
const NOW = new Date('2020-06-01T00:00:00.000Z');

const genuine = (): SavedBankAccount => ({
  id: savedBankAccountId(OWNER_BANK, OWNER_NUMBER),
  bankCode: OWNER_BANK,
  bankName: 'Maybank',
  accountNumber: OWNER_NUMBER,
  accountHolderName: 'Real Owner',
  savedAt: SAVED_AT,
});

const resolve = (accounts: SavedBankAccount[], accountId: string) =>
  resolveWithdrawalDestination({ accounts, accountId, now: NOW });

/** Assert-and-return the refusal. A bare `toThrow` would also pass if the call
 *  threw for an unrelated reason (a stale fixture date, a cooldown change), and
 *  a call that RESOLVES must fail loudly — that is the regression these cases
 *  exist to catch. */
const refusal = (accounts: SavedBankAccount[], accountId: string) => {
  try {
    resolve(accounts, accountId);
  } catch (e) {
    return e as MedusaError;
  }
  throw new Error('expected resolveWithdrawalDestination to refuse, but it resolved');
};

describe('resolveWithdrawalDestination — the id binds the destination', () => {
  // Control. Without it, both tamper cases below would still pass if resolve
  // refused EVERYTHING (a broken fixture, a cooldown default change) — the
  // classic vacuous-guard test.
  it('resolves an untampered, cooled-off account', () => {
    const account = genuine();
    expect(resolve([account], account.id)).toEqual(account);
  });

  // THE attack the derivation prevents: keep an id that has ALREADY cleared the
  // cooling-off window, and repoint it at a different account number. Without
  // the recompute this resolves, and the gateway is paid the attacker's number
  // under the owner's aged id — no fresh 24h wait, no add-a-destination notice.
  it('refuses a row whose account number no longer matches its id', () => {
    const tampered: SavedBankAccount = {
      ...genuine(),
      accountNumber: '9999999999',
    };

    const error = refusal([tampered], tampered.id);

    expect(error.type).toBe(MedusaError.Types.INVALID_DATA);
    // Indistinguishable from an unknown id — the refusal is not a tampering
    // oracle.
    expect(error.message).toBe('Select a saved bank account.');
  });

  // Same account number at a DIFFERENT institution is its own destination, so
  // bankCode is in the hash too. Separate case because a recompute narrowed to
  // the account number alone would pass the one above and let this through.
  it('refuses a row whose bank code no longer matches its id', () => {
    const tampered: SavedBankAccount = { ...genuine(), bankCode: 'CIMB' };

    const error = refusal([tampered], tampered.id);

    expect(error.type).toBe(MedusaError.Types.INVALID_DATA);
    expect(error.message).toBe('Select a saved bank account.');
  });
});

// The cooling-off window is the control that stops a stolen token from adding a
// bank account and cashing out in one sitting, so the ONLY thing allowed to
// disarm it is an operator typing an explicit `0`. These cases pin both halves:
// what parses as "off", and that everything else still lands on 24.
describe('payoutDestinationCooldownHours — 0 is the only off switch', () => {
  const ORIGINAL = process.env.PAYOUT_DESTINATION_COOLDOWN_HOURS;
  afterEach(() => {
    if (ORIGINAL === undefined) {
      delete process.env.PAYOUT_DESTINATION_COOLDOWN_HOURS;
    } else {
      process.env.PAYOUT_DESTINATION_COOLDOWN_HOURS = ORIGINAL;
    }
    jest.restoreAllMocks();
  });

  it('defaults to 24 hours when unset', () => {
    delete process.env.PAYOUT_DESTINATION_COOLDOWN_HOURS;
    expect(payoutDestinationCooldownHours()).toBe(24);
  });

  it('accepts an explicit 0', () => {
    process.env.PAYOUT_DESTINATION_COOLDOWN_HOURS = '0';
    expect(payoutDestinationCooldownHours()).toBe(0);
  });

  // '0.5' is the one that matters: floored, it would read as "off" — a typo
  // silently disarming a money control. A negative would do the same by making
  // usableAt earlier than savedAt.
  it.each(['0.5', '-1', '-0.5', 'off', 'true', 'NaN'])(
    'falls back to 24 for %p',
    (raw) => {
      jest.spyOn(console, 'warn').mockImplementation(() => {});
      process.env.PAYOUT_DESTINATION_COOLDOWN_HOURS = raw;
      expect(payoutDestinationCooldownHours()).toBe(24);
    },
  );

  // Parsing 0 is only half of it — this is the behaviour the setting exists to
  // produce: an account saved THIS INSTANT is payable, at the exact boundary.
  it('pays an account saved this instant when the wait is off', () => {
    const account: SavedBankAccount = {
      ...genuine(),
      savedAt: NOW.toISOString(),
    };

    expect(
      resolveWithdrawalDestination({
        accounts: [account],
        accountId: account.id,
        now: NOW,
        cooldownHours: 0,
      }),
    ).toEqual(account);
  });

  // The control for the case above: the same account under the DEFAULT window
  // must still be refused, or that test would pass against a cooling-off check
  // that had stopped working altogether.
  it('still refuses that same account under the default window', () => {
    delete process.env.PAYOUT_DESTINATION_COOLDOWN_HOURS;
    const account: SavedBankAccount = {
      ...genuine(),
      savedAt: NOW.toISOString(),
    };

    const error = refusal([account], account.id);

    expect(error.type).toBe(MedusaError.Types.NOT_ALLOWED);
    expect(error.message).toMatch(/not available for withdrawals yet/i);
  });
});
