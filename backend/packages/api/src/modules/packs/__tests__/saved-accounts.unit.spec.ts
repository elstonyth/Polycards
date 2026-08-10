import { MedusaError } from '@medusajs/framework/utils';
import {
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
