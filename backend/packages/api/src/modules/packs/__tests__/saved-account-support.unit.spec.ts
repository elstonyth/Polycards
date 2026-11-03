import { MedusaError } from '@medusajs/framework/utils';
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
    ).rejects.toThrow(/already has an RM bank account/);
    expect(writes).toEqual([]);
    expect(audits).toEqual([]);
  });

  it("adds a Touch 'n Go beside an RM bank, but never a second one", async () => {
    const tng = { ...ACCOUNT, id: 'acc_tng', bankCode: 'TNGMY', bankName: "Touch 'n Go eWallet" };
    const beside = fakeService({ bank_accounts: [OTHER] });
    await beside.svc.addSavedBankAccount({ ...base, account: tng, verify: false }, beside.ctx);
    expect(beside.writes[0].bank_accounts).toEqual([OTHER, tng]);
    const second = fakeService({ bank_accounts: [OTHER, tng] });
    await expect(
      second.svc.addSavedBankAccount(
        { ...base, account: { ...tng, id: 'acc_tng2' }, verify: false },
        second.ctx,
      ),
    ).rejects.toThrow(/already has a Touch 'n Go account/);
  });

  it('is the way past the one-name rule: it saves a bank under another spelling', async () => {
    const tng = {
      ...ACCOUNT,
      id: 'acc_tng',
      bankCode: 'TNGMY',
      bankName: "Touch 'n Go eWallet",
      accountHolderName: 'Tan Bin Abu',
    };
    const { svc, writes, ctx } = fakeService({ bank_accounts: [OTHER] });
    await svc.addSavedBankAccount({ ...base, account: tng, verify: false }, ctx);
    expect(writes[0].bank_accounts).toEqual([OTHER, tng]);
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

describe('setHolderNameCleared', () => {
  const input = {
    customerId: 'cus_1',
    adminId: 'user_1',
    holderName: 'Tan Ah Kow',
    cleared: true,
    reason: 'two people, checked their banks',
  };
  const withHolders = (
    metadata: Record<string, unknown>,
    holders: string[] = ['cus_2'],
  ) => {
    const made = fakeService(metadata);
    Object.assign(made.svc, {
      holderNameHolders: jest.fn(async () => holders),
    });
    return made;
  };

  it('stamps the name with the accounts holding it now, keeps the rest, audits them', async () => {
    const { svc, writes, audits, ctx } = withHolders({ avatar_url: 'a' });
    await svc.setHolderNameCleared(input, ctx);
    expect(svc.holderNameHolders).toHaveBeenCalledWith(
      'cus_1',
      'Tan Ah Kow',
      ctx,
    );
    expect(writes[0]).toMatchObject({
      avatar_url: 'a',
      holder_name_cleared: {
        tanahkow: { name: 'Tan Ah Kow', with: ['cus_2'] },
      },
    });
    expect(audits[0][0]).toMatchObject({
      entity_id: 'cus_1',
      action: 'edit',
      after: { holder_name: 'Tan Ah Kow', cleared: true, with: ['cus_2'] },
    });
  });

  it('refuses a name no other account holds: there is nothing to clear', async () => {
    const { svc, writes, ctx } = withHolders({}, []);
    await expect(svc.setHolderNameCleared(input, ctx)).rejects.toThrow(
      /nothing to clear/,
    );
    expect(writes).toEqual([]);
  });

  it('refuses a name on more than one other account', async () => {
    const { svc, writes, ctx } = withHolders({}, ['cus_2', 'cus_3']);
    await expect(svc.setHolderNameCleared(input, ctx)).rejects.toThrow(
      /2 other accounts use this name/,
    );
    expect(writes).toEqual([]);
  });

  it('takes it back, and writes nothing when there is nothing to change', async () => {
    const stamped = withHolders({
      holder_name_cleared: {
        tanahkow: { name: 'Tan Ah Kow', at: STAMP, with: ['cus_2'] },
      },
    });
    await stamped.svc.setHolderNameCleared(
      { ...input, holderName: 'TAN AH-KOW', cleared: false },
      stamped.ctx,
    );
    expect(stamped.writes[0].holder_name_cleared).toBeUndefined();

    const never = withHolders({});
    await never.svc.setHolderNameCleared(
      { ...input, cleared: false },
      never.ctx,
    );
    expect(never.writes).toEqual([]);
    expect(never.audits).toEqual([]);

    const same = withHolders({
      holder_name_cleared: {
        tanahkow: { name: 'Tan Ah Kow', at: STAMP, with: ['cus_2'] },
      },
    });
    await same.svc.setHolderNameCleared(input, same.ctx);
    expect(same.writes).toEqual([]);
    expect(same.audits).toEqual([]);
  });
});

describe('holderNameHeldByAnother — a name support cleared', () => {
  const service = (metadata: Record<string, unknown>, holders: string[]) => {
    const svc = Object.create(PacksModuleService.prototype) as PacksModuleService;
    const execute = jest.fn(async (query: string) =>
      query.startsWith('SELECT metadata')
        ? [{ metadata }]
        : holders.map((customer_id) => ({ customer_id })),
    );
    const em = { execute };
    return { svc, ctx: { transactionManager: em, manager: em } as never };
  };
  const cleared = {
    holder_name_cleared: {
      tanahkow: { name: 'Tan Ah Kow', at: STAMP, with: ['cus_2'] },
    },
  };

  it('does not count the account support checked', async () => {
    const { svc, ctx } = service(cleared, ['cus_2']);
    await expect(
      svc.holderNameHeldByAnother('cus_1', 'TAN AH-KOW', ctx),
    ).resolves.toBe(false);
  });

  it('still counts an account that holds the name and was not checked', async () => {
    const { svc, ctx } = service(cleared, ['cus_2', 'cus_3']);
    await expect(
      svc.holderNameHeldByAnother('cus_1', 'Tan Ah Kow', ctx),
    ).resolves.toBe(true);
  });

  it('still counts any holder of another name, or with no clearing', async () => {
    const other = service(cleared, ['cus_2']);
    await expect(
      other.svc.holderNameHeldByAnother('cus_1', 'Lim Mei Ling', other.ctx),
    ).resolves.toBe(true);
    const none = service({}, ['cus_2']);
    await expect(
      none.svc.holderNameHeldByAnother('cus_1', 'Tan Ah Kow', none.ctx),
    ).resolves.toBe(true);
  });

  it('is held by no one when no other account uses the name', async () => {
    const { svc, ctx } = service({}, []);
    await expect(
      svc.holderNameHeldByAnother('cus_1', 'Tan Ah Kow', ctx),
    ).resolves.toBe(false);
  });
});

describe('unbanning a bank number for one player', () => {
  const OWN = '512345670001';
  const service = (
    banned: { account_key: string; bank_code: string | null }[],
    metadata: Record<string, unknown> = { bank_accounts: [ACCOUNT] },
  ) => {
    const svc = Object.create(PacksModuleService.prototype) as PacksModuleService;
    const audits: Record<string, unknown>[][] = [];
    const writes: Record<string, unknown>[] = [];
    const execute = jest.fn(async (query: string, params: unknown[] = []) => {
      if (query.startsWith('SELECT metadata')) return [{ metadata }];
      if (query.startsWith('SELECT bank_code, account_number')) {
        return [
          { bank_code: 'MBBEMYKL', account_number: OWN },
          // A cut row keeps its last 4 only.
          { bank_code: 'MBBEMYKL', account_number: '9999' },
        ];
      }
      if (query.startsWith('SELECT account_key FROM banned_payout_account WHERE account_key')) {
        const asked = String(params[0]).split(',');
        return banned.filter((b) => asked.includes(b.account_key));
      }
      if (query.startsWith('SELECT account_key, bank_code FROM banned_payout_account')) {
        return banned.filter((b) => b.account_key.endsWith(String(params[0])));
      }
      if (query.startsWith('SELECT 1 FROM banned_payout_account')) {
        return banned.some((b) => b.account_key === params[0]) ? [{}] : [];
      }
      if (query.startsWith('UPDATE customer')) {
        writes.push(JSON.parse(params[0] as string));
      }
      return [];
    });
    Object.assign(svc, {
      createAdminActionAudits: jest.fn(async (rows: Record<string, unknown>[]) => {
        audits.push(rows);
      }),
    });
    const em = { execute };
    return { svc, audits, writes, ctx: { transactionManager: em, manager: em } as never };
  };
  const input = {
    customerId: 'cus_1',
    adminId: 'user_1',
    last4: '0001',
    lifted: true,
    reason: 'owner approved',
  };

  it("lists the player's banned numbers, skipping cut rows", async () => {
    const { svc, ctx } = service([{ account_key: OWN, bank_code: 'MBBEMYKL' }]);
    await expect(svc.bannedPayoutAccountsOf('cus_1', ctx)).resolves.toEqual([
      { account_key: OWN, bank_code: 'MBBEMYKL', last4: '0001', lifted_for_player: false },
    ]);
  });

  it('stamps the lift on this player only, audited with bank and last 4', async () => {
    const { svc, audits, writes, ctx } = service([{ account_key: OWN, bank_code: 'MBBEMYKL' }]);
    await expect(svc.setPayoutBanLifted(input, ctx)).resolves.toMatchObject({
      bank_code: 'MBBEMYKL',
      last4: '0001',
      lifted: true,
      changed: true,
    });
    expect(writes[0]).toMatchObject({
      payout_ban_lifted: { [OWN]: { bank_code: 'MBBEMYKL' } },
    });
    expect(audits[0][0]).toMatchObject({
      entity_id: 'cus_1',
      after: { lifted_for_player: true, found_on: 'player' },
    });
    expect(JSON.stringify(audits)).not.toContain(OWN);
  });

  it('finds a number the player never held on the ban list, for an admin only', async () => {
    const viewer = service(
      [{ account_key: '777777770001', bank_code: 'PBBEMYKL' }],
      {},
    );
    await expect(viewer.svc.setPayoutBanLifted(input, viewer.ctx)).rejects.toMatchObject({
      type: MedusaError.Types.NOT_FOUND,
      message: expect.stringMatching(/An admin can unban one from the ban list/),
    });
    expect(viewer.writes).toEqual([]);
    const { svc, writes, audits, ctx } = service(
      [{ account_key: '777777770001', bank_code: 'PBBEMYKL' }],
      {},
    );
    await svc.setPayoutBanLifted({ ...input, fromBanList: true }, ctx);
    expect(writes[0]).toMatchObject({
      payout_ban_lifted: { '777777770001': { bank_code: 'PBBEMYKL' } },
    });
    expect(audits[0][0]).toMatchObject({ after: { found_on: 'ban_list' } });
  });

  it('uses the bank only to break a tie, and names the banks when it cannot', async () => {
    const two = [
      { account_key: '111111110001', bank_code: 'MBBEMYKL' },
      { account_key: '222222220001', bank_code: 'PBBEMYKL' },
    ];
    const tie = service(two, {});
    await expect(
      svc(tie).setPayoutBanLifted({ ...input, fromBanList: true }, tie.ctx),
    ).rejects.toMatchObject({
      type: MedusaError.Types.NOT_ALLOWED,
      message: expect.stringMatching(/2 banned numbers end 0001 \(Maybank, Public Bank\)/),
    });
    const picked = service(two, {});
    await picked.svc.setPayoutBanLifted(
      { ...input, bankCode: 'PBBEMYKL', fromBanList: true },
      picked.ctx,
    );
    expect(Object.keys(picked.writes[0].payout_ban_lifted as object)).toEqual(['222222220001']);
  });

  it('refuses when nothing ends that way', async () => {
    const { svc: s, writes, ctx } = service([], {});
    await expect(
      s.setPayoutBanLifted({ ...input, fromBanList: true }, ctx),
    ).rejects.toMatchObject({
      type: MedusaError.Types.NOT_FOUND,
    });
    expect(writes).toEqual([]);
  });

  it('bans it again for the player, and a second tap changes nothing', async () => {
    const lifted = { payout_ban_lifted: { [OWN]: { bank_code: 'MBBEMYKL', at: STAMP } } };
    const again = service([{ account_key: OWN, bank_code: 'MBBEMYKL' }], { ...lifted });
    await expect(
      again.svc.setPayoutBanLifted({ ...input, lifted: true }, again.ctx),
    ).resolves.toMatchObject({ changed: false });
    expect(again.writes).toEqual([]);
    const back = service([{ account_key: OWN, bank_code: 'MBBEMYKL' }], { ...lifted });
    await back.svc.setPayoutBanLifted({ ...input, lifted: false }, back.ctx);
    expect(back.writes[0].payout_ban_lifted).toBeUndefined();
  });

  it('payoutAccountBanned: not banned for the player it was lifted for, banned for anyone else', async () => {
    const banned = [{ account_key: OWN, bank_code: 'MBBEMYKL' }];
    const lifted = service(banned, {
      payout_ban_lifted: { [OWN]: { bank_code: 'MBBEMYKL', at: STAMP } },
    });
    await expect(lifted.svc.payoutAccountBanned(OWN, false, 'cus_1', lifted.ctx)).resolves.toBe(false);
    const other = service(banned, {});
    await expect(other.svc.payoutAccountBanned(OWN, false, 'cus_2', other.ctx)).resolves.toBe(true);
    await expect(other.svc.payoutAccountBanned(OWN, false, null, other.ctx)).resolves.toBe(true);
  });
});
const svc = (made: { svc: PacksModuleService }) => made.svc;
