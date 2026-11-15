import {
  holdsPayout,
  saveVerdict,
  savedListHeld,
  spellings,
  type Holder,
  type NameStanding,
  type NumberStanding,
} from '../payout-destination';
import { savedBankAccountId, type SavedBankAccount } from '../saved-accounts';

// The pure half of Payout Destination identity: the save's verdict and the
// payout hold, from standings the reads produce. The reads themselves run on
// real Postgres in payout-destination.integration.spec.ts.

const TRON = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

const standing = (over: Partial<NumberStanding> = {}): NumberStanding => ({
  bankId: 'MBBEMYKL',
  key: '123456789012',
  forms: ['123456789012'],
  banned: false,
  bannedForPlayer: false,
  holders: [],
  ...over,
});
const holder = (over: Partial<Holder> = {}): Holder => ({
  customerId: 'cus_2',
  paid: false,
  verified: false,
  ...over,
});
const name = (blocking: string[]): NameStanding => ({
  holders: blocking,
  blocking,
});
const saved = (over: Partial<SavedBankAccount> = {}): SavedBankAccount => ({
  id: savedBankAccountId('MBBEMYKL', '999999999999'),
  bankCode: 'MBBEMYKL',
  bankName: 'Maybank',
  accountNumber: '999999999999',
  accountHolderName: 'Tan Ah Kow',
  savedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});
const NEW_ID = savedBankAccountId('MBBEMYKL', '123456789012');

describe('saveVerdict', () => {
  it('a clean save has no blocks', () => {
    expect(
      saveVerdict({
        number: standing(),
        name: name([]),
        saved: [],
        accountId: NEW_ID,
        holderName: 'Tan Ah Kow',
      }),
    ).toEqual({ alreadySaved: false, blocks: [] });
  });

  it("lists every block in the save's order", () => {
    expect(
      saveVerdict({
        number: standing({
          banned: true,
          bannedForPlayer: true,
          holders: [holder()],
        }),
        name: name(['cus_3']),
        saved: [saved()],
        accountId: NEW_ID,
        holderName: 'Lim Mei Ling',
      }).blocks,
    ).toEqual(['banned', 'name_linked', 'slot_full', 'name_unlike_saved', 'shared']);
  });

  it('already saved drops the slot, the name rule and the holders, never the ban or a linked name', () => {
    const already = saved({ id: NEW_ID, accountNumber: '123456789012' });
    expect(
      saveVerdict({
        number: standing({ bannedForPlayer: true, holders: [holder()] }),
        name: name(['cus_3']),
        saved: [already],
        accountId: NEW_ID,
        holderName: 'Lim Mei Ling',
      }),
    ).toEqual({ alreadySaved: true, blocks: ['banned', 'name_linked'] });
    expect(
      saveVerdict({
        number: standing({ holders: [holder()] }),
        name: null,
        saved: [already],
        accountId: NEW_ID,
        holderName: 'Tan Ah Kow',
      }),
    ).toEqual({ alreadySaved: true, blocks: [] });
  });

  it('banned for anyone but lifted for this player does not block', () => {
    expect(
      saveVerdict({
        number: standing({ banned: true, bannedForPlayer: false }),
        name: null,
        saved: [],
        accountId: NEW_ID,
        holderName: 'Tan Ah Kow',
      }).blocks,
    ).toEqual([]);
  });

  it('a name support cleared for this player does not block', () => {
    expect(
      saveVerdict({
        number: standing(),
        name: { holders: ['cus_3'], blocking: [] },
        saved: [],
        accountId: NEW_ID,
        holderName: 'Tan Ah Kow',
      }).blocks,
    ).toEqual([]);
  });

  it('any holder of a bank number blocks, saved or paid', () => {
    for (const paid of [false, true]) {
      expect(
        saveVerdict({
          number: standing({ holders: [holder({ paid })] }),
          name: null,
          saved: [],
          accountId: NEW_ID,
          holderName: 'Tan Ah Kow',
        }).blocks,
      ).toEqual(['shared']);
    }
  });

  it('a wallet another account only saved does not block; one it was paid to does', () => {
    const wallet = (h: Holder) =>
      saveVerdict({
        number: standing({
          bankId: 'USDTTRC20',
          key: TRON,
          forms: [TRON],
          holders: [h],
        }),
        name: null,
        saved: [],
        accountId: savedBankAccountId('USDTTRC20', TRON),
        holderName: 'USDT · TRC20 (Tron)',
      }).blocks;
    expect(wallet(holder({ paid: false }))).toEqual([]);
    expect(wallet(holder({ paid: true }))).toEqual(['shared']);
  });

  it("Touch 'n Go has its own slot beside an RM bank", () => {
    expect(
      saveVerdict({
        number: standing({ bankId: 'TNGMY' }),
        name: null,
        saved: [saved()],
        accountId: savedBankAccountId('TNGMY', '120000000001'),
        holderName: 'Tan Ah Kow',
      }).blocks,
    ).toEqual([]);
  });

  it('an unknown bank checks no slot and no name rule', () => {
    expect(
      saveVerdict({
        number: standing({ bankId: null }),
        name: null,
        saved: [saved()],
        accountId: NEW_ID,
        holderName: 'Lim Mei Ling',
      }).blocks,
    ).toEqual([]);
  });
});

describe('holdsPayout', () => {
  it('any holder holds, a wallet someone only saved included', () => {
    expect(holdsPayout(standing(), false)).toBe(false);
    expect(holdsPayout(standing({ holders: [holder()] }), false)).toBe(true);
    expect(
      holdsPayout(
        standing({ bankId: 'USDTTRC20', holders: [holder({ paid: false })] }),
        false,
      ),
    ).toBe(true);
  });

  it("support's verification of this player lifts it", () => {
    expect(holdsPayout(standing({ holders: [holder()] }), true)).toBe(false);
  });
});

describe('savedListHeld', () => {
  const held = saved({ id: 'held', accountNumber: '123456789012' });
  const free = saved({ id: 'free', accountNumber: '999999999999' });
  const standingOf = jest.fn(async (n: { accountNumber: string }) =>
    standing({
      holders: n.accountNumber === '123456789012' ? [holder()] : [],
    }),
  );
  beforeEach(() => standingOf.mockClear());

  it('one held number holds the whole list', async () => {
    expect(await savedListHeld(standingOf, [free, held], {})).toBe(true);
    expect(await savedListHeld(standingOf, [free], {})).toBe(false);
  });

  it('a verified number is not looked up; another one still holds', async () => {
    expect(
      await savedListHeld(standingOf, [held], { held: '2026-11-03T00:00:00Z' }),
    ).toBe(false);
    expect(standingOf).not.toHaveBeenCalled();
    expect(
      await savedListHeld(
        standingOf,
        [free, held],
        { free: '2026-11-03T00:00:00Z' },
      ),
    ).toBe(true);
  });

  it('asks with the saved bank and number', async () => {
    await savedListHeld(standingOf, [held], {});
    expect(standingOf).toHaveBeenCalledWith({
      bankCode: 'MBBEMYKL',
      accountNumber: '123456789012',
    });
  });
});

describe('spellings', () => {
  it('a PayNow mobile with or without its 65 is one number; other banks keep theirs', () => {
    expect(spellings('PAYNOWSG', '91234567')).toEqual([
      '91234567',
      '6591234567',
    ]);
    expect(spellings('PAYNOWSG', '6591234567')).toEqual([
      '91234567',
      '6591234567',
    ]);
    // Typed with spaces, a dash or a plus, it is the same number.
    expect(spellings('PAYNOWSG', '65 9123-4567')).toEqual([
      '91234567',
      '6591234567',
    ]);
    expect(spellings('PAYNOWSG', '+65 9123 4567')).toEqual([
      '91234567',
      '6591234567',
    ]);
    // A foreign mobile carries its own country code: no 65 to add or strip.
    expect(spellings('PAYNOWSG', '60123456789')).toEqual(['60123456789']);
    expect(spellings('PBBEMYKL', '6591234567')).toEqual(['6591234567']);
  });

  it('an unknown or missing bank keeps the number as given', () => {
    expect(spellings(null, '91234567')).toEqual(['91234567']);
    expect(spellings('NOPE', '91234567')).toEqual(['91234567']);
  });
});
