import { MedusaError } from '@medusajs/framework/utils';
import {
  HOLDER_NAME_CLEARED_KEY,
  anySavedAccountShared,
  clearedHolderNames,
  holderNameInvalid,
  holderNameKey,
  holderUnlikeSaved,
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

// ---------------------------------------------------------------------------
// Bank preservation across gateways (plan 130 §bank preservation)

import {
  bankSupportedBy,
  parseSavedBankAccounts,
  savedBankAccountViews,
} from '../saved-accounts';

describe('parseSavedBankAccounts — legacy gateway codes read as the canonical bank', () => {
  const legacy = {
    // Written while GlobePay was the only gateway: its code, its name, an id
    // derived from that code.
    id: savedBankAccountId('MYMB2U', OWNER_NUMBER),
    bankCode: 'MYMB2U',
    bankName: 'Maybank Berhad',
    accountNumber: OWNER_NUMBER,
    accountHolderName: 'Real Owner',
    savedAt: SAVED_AT,
  };

  it('canonicalises the bank and recomputes the id, keeping everything else', () => {
    const [account] = parseSavedBankAccounts([legacy]);
    expect(account).toEqual({
      id: savedBankAccountId('MBBEMYKL', OWNER_NUMBER),
      bankCode: 'MBBEMYKL',
      bankName: 'Maybank',
      accountNumber: OWNER_NUMBER,
      accountHolderName: 'Real Owner',
      savedAt: SAVED_AT,
    });
    // …and the money path still accepts it: the id matches its derivation.
    expect(resolve([account], account.id).bankCode).toBe('MBBEMYKL');
  });

  it('leaves a code the registry does not know untouched (nothing to convert)', () => {
    const [account] = parseSavedBankAccounts([genuine()]);
    expect(account).toEqual(genuine());
  });

  it('an already-canonical entry is a no-op', () => {
    const canonical = { ...legacy, id: savedBankAccountId('MBBEMYKL', OWNER_NUMBER), bankCode: 'MBBEMYKL', bankName: 'Maybank' };
    expect(parseSavedBankAccounts([canonical])).toEqual([canonical]);
  });
});

describe('bankSupportedBy / savedBankAccountViews — the same account across gateways', () => {
  it('a bank TGPay pays to is supported, a wallet it has no code for is not, whichever alias saved it', () => {
    expect(bankSupportedBy('MBBEMYKL', 'tgpay')).toBe(true);
    // Saved under the retired gateway's code: still the same bank.
    expect(bankSupportedBy('MYMB2U', 'tgpay')).toBe(true);
    expect(bankSupportedBy('BOOSTMY', 'tgpay')).toBe(false);
  });

  it('a code no registry entry knows is unsupported — nothing could pay to it', () => {
    expect(bankSupportedBy('MBB', 'tgpay')).toBe(false);
  });

  it('the sandbox dummy bank is payable only while the sandbox is configured', () => {
    const sandbox = { TGPAY_API_BASE: 'https://sandbox-api.tgpay365.com/api/v2' };
    const production = { TGPAY_API_BASE: 'https://api.tgpay365.com/api/v2' };
    expect(bankSupportedBy('DUMMYBANKVERIFIED', 'tgpay', sandbox)).toBe(true);
    expect(bankSupportedBy('DUMMYBANKVERIFIED', 'tgpay', production)).toBe(false);
  });

  it('views carry the verdict for the gateway they are rendered under', () => {
    const boost: SavedBankAccount = {
      ...genuine(),
      id: savedBankAccountId('BOOSTMY', OWNER_NUMBER),
      bankCode: 'BOOSTMY',
      bankName: 'Boost',
    };
    expect(savedBankAccountViews([boost], 'tgpay', 0)[0].supported).toBe(false);
    const maybank: SavedBankAccount = {
      ...genuine(),
      id: savedBankAccountId('MBBEMYKL', OWNER_NUMBER),
      bankCode: 'MBBEMYKL',
      bankName: 'Maybank',
    };
    expect(savedBankAccountViews([maybank], 'tgpay', 0)[0].supported).toBe(true);
  });
});

// One person, one name: a holder name dressed up with digits, brackets, an
// ampersand, accents or small capitals is still the plain name.
describe('holder names compare by their letters', () => {
  it.each([
    ['TAN AH KOW&'],
    ['TAN AH KOW (1)'],
    ['TAN AH KÓW'],
    ['ᴛᴀɴ ᴀʜ ᴋᴏᴡ'],
    ['Tan Ah-Kow 2'],
  ])('%j keys as "Tan Ah Kow"', (name) => {
    expect(holderNameKey(name)).toBe(holderNameKey('Tan Ah Kow'));
    expect(holderNameInvalid(name)).toBe(false);
  });

  it('keeps different names apart', () => {
    expect(holderNameKey('Tan Ah Kow')).not.toBe(holderNameKey('Lim Mei Ling'));
  });

  it.each([['TAN ɑH KOW'], ['TAN AH KıW'], ['TAN AH KØW']])(
    '%j folds to the plain name: a look-alike is not a new name',
    (name) => {
      expect(holderNameInvalid(name)).toBe(false);
      expect(holderNameKey(name)).toBe(holderNameKey(name.replace(/[ɑıØ]/u, (c) => ({ ɑ: 'A', ı: 'I', Ø: 'O' })[c]!)));
    },
  );

  it('reads letters NFKD keeps, as a Vietnamese or German name spells them', () => {
    expect(holderNameKey('Nguyễn Văn Đức')).toBe(holderNameKey('NGUYEN VAN DUC'));
    expect(holderNameKey('Strauß')).toBe('strauss');
    expect(holderNameInvalid('Nguyễn Văn Đức')).toBe(false);
  });

  it('refuses a letter it cannot read as an English one', () => {
    expect(holderNameInvalid('TAN AH ŊOW')).toBe(true);
  });

  it('holds a name saved with no English letters to its old key', () => {
    const saved = [
      {
        id: 'old',
        bankCode: 'MBBEMYKL',
        accountNumber: '123456789012',
        accountHolderName: '陈亚高',
      },
    ] as Parameters<typeof holderUnlikeSaved>[0];
    expect(holderUnlikeSaved(saved, 'MBBEMYKL', 'TAN AH KOW')).toBe(true);
  });

  it('one name on every bank: a variant of the saved name is that name', () => {
    const saved = [
      {
        id: 'x',
        bankCode: 'MBBEMYKL',
        bankName: 'Maybank',
        accountNumber: '123456789012',
        accountHolderName: 'Tan Ah Kow',
      },
    ];
    expect(holderUnlikeSaved(saved, 'TNGMY', 'TAN AH KÓW (1)')).toBe(false);
    expect(holderUnlikeSaved(saved, 'TNGMY', 'Lim Mei Ling')).toBe(true);
  });

  it('a clearing stamped under an older key still matches, merged with its twin', () => {
    const cleared = clearedHolderNames({
      [HOLDER_NAME_CLEARED_KEY]: {
        'tanahkow&': { name: 'TAN AH KOW&', at: 'a', with: ['cus_2'] },
        tanahkow: { name: 'Tan Ah Kow', at: 'b', with: ['cus_3'] },
      },
    });
    expect(Object.keys(cleared)).toEqual(['tanahkow']);
    expect(cleared[holderNameKey('TAN AH KOW&')]?.with.sort()).toEqual([
      'cus_2',
      'cus_3',
    ]);
  });
});

describe('anySavedAccountShared — a PayNow mobile with or without its 65', () => {
  it('asks for both spellings, so an old row in the other one still holds it', async () => {
    const otherPayoutAccountHolders = jest.fn(
      async (_customerId: string, accountNumber: string) =>
        accountNumber === '6591234567' ? [{ bank_code: 'PAYNOWSG' }] : [],
    );
    const paynow: SavedBankAccount = {
      id: savedBankAccountId('PAYNOWSG', '91234567'),
      bankCode: 'PAYNOWSG',
      bankName: 'PayNow (mobile number)',
      accountNumber: '91234567',
      accountHolderName: 'Tan Ah Kow',
    };
    await expect(
      anySavedAccountShared({ otherPayoutAccountHolders }, 'cus_1', [paynow], {}),
    ).resolves.toBe(true);
    expect(otherPayoutAccountHolders.mock.calls.map((c) => c[1])).toEqual([
      '91234567',
      '6591234567',
    ]);
  });
});
