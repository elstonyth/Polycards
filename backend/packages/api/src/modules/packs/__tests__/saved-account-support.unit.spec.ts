import PacksModuleService from '../service';
import {
  anySavedAccountShared,
  blocksNewSave,
  heldByAnother,
  savedBankAccountId,
  verifiedBankAccounts,
  verifiedElsewhere,
  withBankShareStamp,
} from '../saved-accounts';

// Support is the only way a tied bank account changes (ADR 0015): removing one,
// adding one, and verifying a shared one. Same fake-`this` technique as
// customer-metadata-lock.unit.spec.ts: the real mutator on a fake `em`, so what
// lands in the UPDATE and the audit row is what these assert.

const ACCOUNT = {
  id: savedBankAccountId('MBBEMYKL', '123456789012'),
  bankCode: 'MBBEMYKL',
  bankName: 'Maybank',
  accountNumber: '123456789012',
  accountHolderName: 'Tan',
  savedAt: '2026-01-01T00:00:00.000Z',
};
const OTHER = {
  ...ACCOUNT,
  id: savedBankAccountId('MBBEMYKL', '999999999999'),
  accountNumber: '999999999999',
};
const STAMP = '2026-11-03T00:00:00.000Z';

const fakeService = (metadata: Record<string, unknown> | null) => {
  const svc = Object.create(PacksModuleService.prototype) as PacksModuleService;
  const writes: Record<string, unknown>[] = [];
  const em = {
    execute: jest.fn(async (query: string, params: unknown[] = []) => {
      if (query.startsWith('SELECT metadata')) {
        return metadata === null ? [] : [{ metadata }];
      }
      if (query.startsWith('UPDATE customer')) {
        writes.push(JSON.parse(params[0] as string));
      }
      return [];
    }),
  };
  const audits: Record<string, unknown>[][] = [];
  Object.assign(svc, {
    createAdminActionAudits: jest.fn(
      async (rows: Record<string, unknown>[]) => {
        audits.push(rows);
      },
    ),
  });
  return {
    svc,
    writes,
    audits,
    ctx: { transactionManager: em, manager: em } as never,
  };
};

describe('removeSavedBankAccount', () => {
  const input = {
    customerId: 'cus_1',
    adminId: 'user_1',
    accountId: ACCOUNT.id,
    reason: 'customer changed bank',
  };

  it('removes it with its own verification, keeps the rest, audits last 4 only', async () => {
    const { svc, writes, audits, ctx } = fakeService({
      avatar_url: 'a',
      bank_accounts: [ACCOUNT, OTHER],
      bank_share_verified: { [ACCOUNT.id]: STAMP, [OTHER.id]: STAMP },
    });
    const removed = await svc.removeSavedBankAccount(input, ctx);
    expect(removed?.id).toBe(ACCOUNT.id);
    expect(writes).toEqual([
      {
        avatar_url: 'a',
        bank_accounts: [OTHER],
        bank_share_verified: { [OTHER.id]: STAMP },
      },
    ]);
    expect(audits).toHaveLength(1);
    expect(audits[0][0]).toMatchObject({
      admin_id: 'user_1',
      entity_id: 'cus_1',
      action: 'edit',
      before: { bank_name: 'Maybank', account_last4: '9012' },
      after: { removed: true },
      reason: 'Removed saved bank account: customer changed bank',
    });
    expect(JSON.stringify(audits)).not.toContain('123456789012');
  });

  it('leaves no stamp key behind when the last one goes', async () => {
    const { svc, writes, ctx } = fakeService({
      bank_accounts: [ACCOUNT],
      bank_share_verified: { [ACCOUNT.id]: STAMP },
    });
    await svc.removeSavedBankAccount(input, ctx);
    expect(writes).toEqual([{ bank_accounts: [] }]);
  });

  it('is a no-op on an account already gone: no write, no audit row', async () => {
    const { svc, writes, audits, ctx } = fakeService({ bank_accounts: [] });
    expect(await svc.removeSavedBankAccount(input, ctx)).toBeNull();
    expect(writes).toEqual([]);
    expect(audits).toEqual([]);
  });
});

describe('setBankShareVerified', () => {
  const base = {
    customerId: 'cus_1',
    adminId: 'user_1',
    accountId: ACCOUNT.id,
    reason: 'checked ID',
  };

  it('stamps one account and audits, leaving the rest of the blob', async () => {
    const { svc, writes, audits, ctx } = fakeService({
      bank_accounts: [ACCOUNT, OTHER],
    });
    await svc.setBankShareVerified({ ...base, verified: true }, ctx);
    expect(writes[0].bank_accounts).toEqual([ACCOUNT, OTHER]);
    expect(Object.keys(writes[0].bank_share_verified as object)).toEqual([
      ACCOUNT.id,
    ]);
    expect(audits[0][0]).toMatchObject({
      action: 'edit',
      after: { account_last4: '9012', verified: true },
      reason: 'Verified shared bank account: checked ID',
    });
    expect(JSON.stringify(audits)).not.toContain('123456789012');
  });

  it('clears only that account', async () => {
    const { svc, writes, audits, ctx } = fakeService({
      bank_accounts: [ACCOUNT, OTHER],
      bank_share_verified: { [ACCOUNT.id]: STAMP, [OTHER.id]: STAMP },
    });
    await svc.setBankShareVerified({ ...base, verified: false }, ctx);
    expect(writes[0].bank_share_verified).toEqual({ [OTHER.id]: STAMP });
    expect(audits[0][0].reason).toBe(
      'Unverified shared bank account: checked ID',
    );
  });

  it('writes nothing when it is already in that state', async () => {
    const { svc, writes, audits, ctx } = fakeService({
      bank_accounts: [ACCOUNT],
    });
    await svc.setBankShareVerified({ ...base, verified: false }, ctx);
    expect(writes).toEqual([]);
    expect(audits).toEqual([]);
  });

  it('refuses an account no longer on the list', async () => {
    const { svc, writes, ctx } = fakeService({ bank_accounts: [] });
    await expect(
      svc.setBankShareVerified({ ...base, verified: true }, ctx),
    ).rejects.toThrow(/no longer on this player/);
    expect(writes).toEqual([]);
  });
});

describe('addSavedBankAccount', () => {
  const base = {
    customerId: 'cus_1',
    adminId: 'user_1',
    account: ACCOUNT,
    reason: 'owner proved it is theirs',
  };

  it('adds to an empty list, stamps it when asked, audits last 4 only', async () => {
    const { svc, writes, audits, ctx } = fakeService({ avatar_url: 'a' });
    await svc.addSavedBankAccount({ ...base, verify: true }, ctx);
    expect(writes[0]).toMatchObject({
      avatar_url: 'a',
      bank_accounts: [ACCOUNT],
    });
    expect(Object.keys(writes[0].bank_share_verified as object)).toEqual([
      ACCOUNT.id,
    ]);
    expect(audits[0][0]).toMatchObject({
      after: { account_last4: '9012', verified: true },
      reason: 'Added saved bank account: owner proved it is theirs',
    });
    expect(JSON.stringify(audits)).not.toContain('123456789012');
  });

  it('adds no stamp for a number nobody else holds', async () => {
    const { svc, writes, ctx } = fakeService({});
    await svc.addSavedBankAccount({ ...base, verify: false }, ctx);
    expect(writes[0].bank_share_verified).toBeUndefined();
  });

  it('refuses when the player already has one, and audits nothing', async () => {
    const { svc, writes, audits, ctx } = fakeService({
      bank_accounts: [OTHER],
    });
    await expect(
      svc.addSavedBankAccount({ ...base, verify: false }, ctx),
    ).rejects.toThrow(/already has a bank account/);
    expect(writes).toEqual([]);
    expect(audits).toEqual([]);
  });
});

describe('bankShareVerifiedFor', () => {
  it('reads the stamps', async () => {
    const stamped = fakeService({
      bank_share_verified: { [ACCOUNT.id]: STAMP },
    });
    expect(
      await stamped.svc.bankShareVerifiedFor('cus_1', stamped.ctx),
    ).toEqual({ [ACCOUNT.id]: STAMP });
  });

  it('a customer with no row, or no stamps, has none', async () => {
    const missing = fakeService(null);
    expect(
      await missing.svc.bankShareVerifiedFor('cus_x', missing.ctx),
    ).toEqual({});
    const plain = fakeService({});
    expect(await plain.svc.bankShareVerifiedFor('cus_1', plain.ctx)).toEqual(
      {},
    );
  });
});

describe('the stamp helpers', () => {
  it('ignores a malformed stamp', () => {
    expect(verifiedBankAccounts({ bank_share_verified: 'yes' })).toEqual({});
    expect(
      verifiedBankAccounts({ bank_share_verified: { a: STAMP, b: 1 } }),
    ).toEqual({ a: STAMP });
  });

  it('clearing the last stamp removes the key', () => {
    expect(
      withBankShareStamp(
        { x: 1, bank_share_verified: { a: STAMP } },
        'a',
        null,
      ),
    ).toEqual({ x: 1 });
  });

  it('verifiedElsewhere matches digits at the same bank, not a stranger', () => {
    const elsewhere = (accountNumber: string, bankCode = 'MBBEMYKL') => {
      const a = {
        ...ACCOUNT,
        id: savedBankAccountId(bankCode, accountNumber),
        bankCode,
        accountNumber,
      };
      return {
        bank_accounts: [a],
        bank_share_verified: { [a.id]: STAMP },
      };
    };
    expect(verifiedElsewhere(elsewhere('123456789012'), ACCOUNT)).toBe(true);
    expect(verifiedElsewhere(elsewhere('0123456789012'), ACCOUNT)).toBe(true);
    expect(verifiedElsewhere(elsewhere('999999999999'), ACCOUNT)).toBe(false);
    expect(
      verifiedElsewhere(elsewhere('123456789012', 'PBBEMYKL'), ACCOUNT),
    ).toBe(false);
    expect(verifiedElsewhere({ bank_accounts: [ACCOUNT] }, ACCOUNT)).toBe(
      false,
    );
  });
});

describe('who holds a destination', () => {
  it('heldByAnother counts any holder at the same bank, under a retired code too', () => {
    expect(heldByAnother([{ bank_code: 'MYMB2U' }], 'MBBEMYKL')).toBe(true);
    expect(heldByAnother([{ bank_code: 'PBBEMYKL' }], 'MBBEMYKL')).toBe(false);
    expect(heldByAnother([], 'MBBEMYKL')).toBe(false);
  });

  it('heldByAnother counts a wallet someone only saved, so sharing one cannot race a payout', () => {
    expect(heldByAnother([{ bank_code: 'USDTTRC20' }], 'USDTTRC20')).toBe(true);
  });

  it('blocksNewSave: any holder of a bank number', () => {
    expect(
      blocksNewSave(
        [{ bank_code: 'MYMB2U', holder_name: 'Anyone' }],
        'MBBEMYKL',
      ),
    ).toBe(true);
    expect(
      blocksNewSave([{ bank_code: 'PBBEMYKL', holder_name: null }], 'MBBEMYKL'),
    ).toBe(false);
  });

  it('blocksNewSave: only a wallet someone was already paid to', () => {
    expect(
      blocksNewSave(
        [{ bank_code: 'USDTTRC20', holder_name: 'USDT' }],
        'USDTTRC20',
      ),
    ).toBe(false);
    expect(
      blocksNewSave(
        [{ bank_code: 'USDTTRC20', holder_name: null }],
        'USDTTRC20',
      ),
    ).toBe(true);
  });
});

describe('anySavedAccountShared', () => {
  const holders = (shared: string[]) => ({
    otherPayoutAccountHolders: jest.fn(async (_id: string, number: string) =>
      shared.includes(number) ? [{ bank_code: 'MBBEMYKL' }] : [],
    ),
  });

  it('one shared number on the list holds the whole list', async () => {
    const packs = holders([OTHER.accountNumber]);
    expect(
      await anySavedAccountShared(packs, 'cus_1', [ACCOUNT, OTHER], {}),
    ).toBe(true);
  });

  it('verifying one number does not vouch for another on the list', async () => {
    const packs = holders([ACCOUNT.accountNumber, OTHER.accountNumber]);
    expect(
      await anySavedAccountShared(packs, 'cus_1', [ACCOUNT, OTHER], {
        [ACCOUNT.id]: STAMP,
      }),
    ).toBe(true);
    expect(
      await anySavedAccountShared(packs, 'cus_1', [ACCOUNT, OTHER], {
        [ACCOUNT.id]: STAMP,
        [OTHER.id]: STAMP,
      }),
    ).toBe(false);
  });

  it('an empty or clean list is not held', async () => {
    const packs = holders([]);
    expect(await anySavedAccountShared(packs, 'cus_1', [], {})).toBe(false);
    expect(await anySavedAccountShared(packs, 'cus_1', [ACCOUNT], {})).toBe(
      false,
    );
  });
});
