import { savedBankAccountId } from '../../../../../../modules/packs/saved-accounts';
import { GET } from '../route';
import { POST as ADD } from '../add/route';
import { POST as REMOVE } from '../remove/route';
import { POST as VERIFY } from '../verify/route';
import { POST as NAME_CLASH } from '../name-clash/route';
import { POST as UNBAN_NUMBER } from '../unban-number/route';

// Role policies for the unban fallback (assistant/access.ts reads them): a
// super admin's every permission, an editor's customer:update, the Support
// viewer's unban without it, and a role whose lookup fails.
jest.mock('@medusajs/framework', () => ({
  ...jest.requireActual('@medusajs/framework'),
  hasPermission: jest.fn(
    async ({
      roles,
      actions,
    }: {
      roles: string[];
      actions: { resource: string; operation: string };
    }) => {
      if (roles.includes('broken_role')) throw new Error('policy store down');
      const policies: Record<string, string[]> = {
        role_super_admin: ['*:*'],
        customer_editor: ['customer:update'],
        support_viewer: ['customer:read', 'assistant_unban:update'],
      };
      return roles.some((r) =>
        (policies[r] ?? []).some((p) => {
          const [res, op] = p.split(':');
          return (
            (res === '*' || res === actions.resource) &&
            (op === '*' || op === actions.operation)
          );
        }),
      );
    },
  ),
}));

// What support sees and does for a tied bank account (ADR 0015). The service
// methods are pinned in modules/packs/__tests__/saved-account-support; these pin
// the routes around them. All details here are made up: the repo is public.

const ACCOUNT = {
  id: savedBankAccountId('MBBEMYKL', '512345678901'),
  bankCode: 'MBBEMYKL',
  bankName: 'Maybank',
  accountNumber: '512345678901',
  accountHolderName: 'Test Holder',
  savedAt: '2026-10-24T00:00:00.000Z',
};
const STAMP = '2026-11-03T00:00:00.000Z';
// Saved without its 65; another account holds it with it.
const PAYNOW = {
  ...ACCOUNT,
  id: savedBankAccountId('PAYNOWSG', '91234567'),
  bankCode: 'PAYNOWSG',
  bankName: 'PayNow (mobile number)',
  accountNumber: '91234567',
};
/** A Payout Destination standing (payout-destination.ts): what the routes
 *  read about a number. Its spellings, bank scope and verified holders are
 *  pinned in payout-destination.integration.spec. */
const standing = (
  holders: { customerId: string; paid?: boolean; verified?: boolean }[] = [],
  over: Record<string, unknown> = {},
) => ({
  bankId: 'MBBEMYKL',
  key: '512345678901',
  forms: ['512345678901'],
  banned: false,
  bannedForPlayer: false,
  holders: holders.map((h) => ({ paid: false, verified: false, ...h })),
  ...over,
});

const packs = {
  getVerificationState: jest.fn(),
  payoutNumberStanding: jest.fn(),
  createAdminActionAudits: jest.fn(),
  removeSavedBankAccount: jest.fn(),
  setBankShareVerified: jest.fn(),
  addSavedBankAccount: jest.fn(),
  setHolderNameCleared: jest.fn(),
  bannedPayoutAccountsOf: jest.fn(),
  setPayoutBanLifted: jest.fn(),
};
const customers = { retrieveCustomer: jest.fn(), listCustomers: jest.fn() };
const notifications = { createNotifications: jest.fn() };

const scope = {
  resolve: (key: string) => {
    if (key === 'packs') return packs;
    if (key === 'customer') return customers;
    if (key === 'notification') return notifications;
    return { error: jest.fn(), warn: jest.fn(), info: jest.fn() };
  },
};

const mkReq = (body: unknown = {}) =>
  ({
    params: { id: 'cus_1' },
    auth_context: { actor_id: 'user_1' },
    body,
    scope,
  }) as never;
const mkRes = () => {
  const res = { json: jest.fn(), setHeader: jest.fn() };
  return res as never as { json: jest.Mock; setHeader: jest.Mock };
};
/** Another account on the number, paid to it. */
const heldBy = (customerId: string, verified = false) =>
  standing([{ customerId, paid: true, verified }]);

beforeEach(() => {
  jest.clearAllMocks();
  packs.getVerificationState.mockResolvedValue({
    phoneVerified: true,
    realName: ' Test Holder ',
  });
  packs.payoutNumberStanding.mockResolvedValue(standing());
  packs.createAdminActionAudits.mockResolvedValue(undefined);
  customers.retrieveCustomer.mockResolvedValue({
    metadata: { bank_accounts: [ACCOUNT] },
    email: 'a@b.test',
  });
  customers.listCustomers.mockResolvedValue([]);
  packs.bannedPayoutAccountsOf.mockResolvedValue([]);
  packs.setPayoutBanLifted.mockResolvedValue({
    bank_code: 'MBBEMYKL',
    last4: '8901',
    lifted: true,
    changed: true,
  });
});

describe('GET bank-accounts', () => {
  it('names who else is on the number, and never caches', async () => {
    packs.payoutNumberStanding.mockResolvedValue(heldBy('cus_2'));
    customers.listCustomers.mockResolvedValue([
      { id: 'cus_2', metadata: { handle: 'Collector2' } },
    ]);
    const res = mkRes();
    await GET(mkReq(), res as never);
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(packs.payoutNumberStanding).toHaveBeenCalledWith('cus_1', {
      bankCode: 'MBBEMYKL',
      accountNumber: '512345678901',
    });
    const body = res.json.mock.calls[0][0];
    expect(body.accounts).toEqual([
      expect.objectContaining({
        id: ACCOUNT.id,
        account_number: '512345678901',
        verified_at: null,
        linked: [{ customer_id: 'cus_2', handle: 'Collector2' }],
      }),
    ]);
  });

  it('asks about a PayNow mobile as saved; its spellings are the module\'s', async () => {
    customers.retrieveCustomer.mockResolvedValue({
      metadata: { bank_accounts: [PAYNOW] },
    });
    packs.payoutNumberStanding.mockResolvedValue(heldBy('cus_2'));
    const res = mkRes();
    await GET(mkReq(), res as never);
    expect(packs.payoutNumberStanding).toHaveBeenCalledWith('cus_1', {
      bankCode: 'PAYNOWSG',
      accountNumber: '91234567',
    });
    expect(res.json.mock.calls[0][0].accounts[0].linked).toEqual([
      { customer_id: 'cus_2', handle: null },
    ]);
  });

  it('reports the stamp per account, and what support can add', async () => {
    customers.retrieveCustomer.mockResolvedValue({
      metadata: {
        bank_accounts: [ACCOUNT],
        bank_share_verified: { [ACCOUNT.id]: STAMP },
      },
    });
    const res = mkRes();
    await GET(mkReq(), res as never);
    const body = res.json.mock.calls[0][0];
    expect(body.accounts[0].verified_at).toBe(STAMP);
    expect(body.banks.map((b: { id: string }) => b.id)).toContain('MBBEMYKL');
    expect(body.banks.map((b: { id: string }) => b.id)).not.toContain(
      'USDTTRC20',
    );
  });

  it('records the reveal with the last 4 only, and an audit outage does not deny the read', async () => {
    const res = mkRes();
    await GET(mkReq(), res as never);
    const [[row]] = packs.createAdminActionAudits.mock.calls[0];
    expect(row.action).toBe('reveal');
    expect(JSON.stringify(row)).not.toContain('512345678901');

    packs.createAdminActionAudits.mockRejectedValue(new Error('down'));
    const res2 = mkRes();
    await GET(mkReq(), res2 as never);
    expect(res2.json).toHaveBeenCalled();
  });

  it('reveals nothing, so audits nothing, for an empty list', async () => {
    customers.retrieveCustomer.mockResolvedValue({ metadata: {} });
    await GET(mkReq(), mkRes() as never);
    expect(packs.createAdminActionAudits).not.toHaveBeenCalled();
  });
});

describe('POST bank-accounts/remove', () => {
  it('needs an account and a reason', async () => {
    await expect(
      REMOVE(mkReq({ reason: 'x' }), mkRes() as never),
    ).rejects.toThrow(/which saved account/);
    await expect(
      REMOVE(mkReq({ account_id: ACCOUNT.id, reason: ' ' }), mkRes() as never),
    ).rejects.toThrow(/reason/i);
    expect(packs.removeSavedBankAccount).not.toHaveBeenCalled();
  });

  it('takes the admin from the token and tells the customer, last 4 only', async () => {
    packs.removeSavedBankAccount.mockResolvedValue(ACCOUNT);
    const res = mkRes();
    await REMOVE(
      mkReq({
        account_id: ACCOUNT.id,
        reason: ' changed bank ',
        adminId: 'evil',
      }),
      res as never,
    );
    expect(packs.removeSavedBankAccount).toHaveBeenCalledWith({
      customerId: 'cus_1',
      adminId: 'user_1',
      accountId: ACCOUNT.id,
      reason: 'changed bank',
    });
    expect(res.json).toHaveBeenCalledWith({ removed: true });
    const sent = JSON.stringify(notifications.createNotifications.mock.calls);
    expect(sent).toContain('8901');
    expect(sent).not.toContain('512345678901');
  });

  it('stays silent when it was already gone', async () => {
    packs.removeSavedBankAccount.mockResolvedValue(null);
    const res = mkRes();
    await REMOVE(mkReq({ account_id: ACCOUNT.id, reason: 'x' }), res as never);
    expect(res.json).toHaveBeenCalledWith({ removed: false });
    expect(notifications.createNotifications).not.toHaveBeenCalled();
  });
});

describe('POST bank-accounts/verify', () => {
  const verify = (over: Record<string, unknown> = {}) =>
    mkReq({ account_id: ACCOUNT.id, verified: true, reason: 'x', ...over });

  it('needs an account, a boolean and a reason', async () => {
    await expect(
      VERIFY(verify({ account_id: undefined }), mkRes() as never),
    ).rejects.toThrow(/which saved account/);
    await expect(
      VERIFY(verify({ verified: 'yes' }), mkRes() as never),
    ).rejects.toThrow(/true or false/);
    await expect(
      VERIFY(verify({ reason: undefined }), mkRes() as never),
    ).rejects.toThrow(/reason/i);
    expect(packs.setBankShareVerified).not.toHaveBeenCalled();
  });

  it('refuses an account no longer on the player', async () => {
    customers.retrieveCustomer.mockResolvedValue({ metadata: {} });
    await expect(VERIFY(verify(), mkRes() as never)).rejects.toThrow(
      /no longer on this player/,
    );
    expect(packs.setBankShareVerified).not.toHaveBeenCalled();
  });

  it('refuses a number nobody else holds, so a stamp cannot sit waiting', async () => {
    await expect(VERIFY(verify(), mkRes() as never)).rejects.toThrow(
      /nothing to verify/,
    );
    expect(packs.setBankShareVerified).not.toHaveBeenCalled();
  });

  it('one person, one account: refuses a second account on the number', async () => {
    packs.payoutNumberStanding.mockResolvedValue(heldBy('cus_2', true));
    customers.listCustomers.mockResolvedValue([
      { id: 'cus_2', metadata: { handle: 'Collector2' } },
    ]);
    await expect(VERIFY(verify(), mkRes() as never)).rejects.toThrow(
      /Collector2 is already verified/,
    );
    expect(packs.setBankShareVerified).not.toHaveBeenCalled();
  });

  it('a holder not verified on this number does not count', async () => {
    packs.payoutNumberStanding.mockResolvedValue(heldBy('cus_2'));
    await VERIFY(verify(), mkRes() as never);
    expect(packs.setBankShareVerified).toHaveBeenCalledTimes(1);
  });

  it('asks about a PayNow mobile as saved', async () => {
    customers.retrieveCustomer.mockResolvedValue({
      metadata: { bank_accounts: [PAYNOW] },
    });
    packs.payoutNumberStanding.mockResolvedValue(heldBy('cus_2'));
    await VERIFY(verify({ account_id: PAYNOW.id }), mkRes() as never);
    expect(packs.payoutNumberStanding).toHaveBeenCalledWith('cus_1', {
      bankCode: 'PAYNOWSG',
      accountNumber: '91234567',
    });
    expect(packs.setBankShareVerified).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: PAYNOW.id, verified: true }),
    );
  });

  it('verifies with the admin from the token, for this account', async () => {
    packs.payoutNumberStanding.mockResolvedValue(heldBy('cus_2'));
    const res = mkRes();
    await VERIFY(verify({ reason: ' checked ' }), res as never);
    expect(packs.setBankShareVerified).toHaveBeenCalledWith({
      customerId: 'cus_1',
      adminId: 'user_1',
      accountId: ACCOUNT.id,
      verified: true,
      reason: 'checked',
    });
    expect(res.json).toHaveBeenCalledWith({ verified: true });
  });

  it('undo goes straight through, shared or not', async () => {
    const res = mkRes();
    await VERIFY(verify({ verified: false }), res as never);
    expect(packs.setBankShareVerified).toHaveBeenCalledWith(
      expect.objectContaining({ verified: false, accountId: ACCOUNT.id }),
    );
    expect(res.json).toHaveBeenCalledWith({ verified: false });
    expect(packs.payoutNumberStanding).not.toHaveBeenCalled();
  });
});

describe('POST bank-accounts/add', () => {
  const body = (over: Record<string, unknown> = {}) => ({
    bank_code: 'MBBEMYKL',
    account_number: '512345678901',
    reason: 'owner proved it',
    ...over,
  });

  it('needs a reason and valid details, and refuses a bank nothing can pay', async () => {
    await expect(
      ADD(mkReq(body({ reason: ' ' })), mkRes() as never),
    ).rejects.toThrow(/reason/i);
    await expect(
      ADD(mkReq(body({ account_number: '123' })), mkRes() as never),
    ).rejects.toThrow();
    await expect(
      ADD(mkReq(body({ bank_code: 'NOTABANK' })), mkRes() as never),
    ).rejects.toThrow();
    expect(packs.addSavedBankAccount).not.toHaveBeenCalled();
  });

  it('adds a number nobody else holds, unverified, and tells the owner', async () => {
    const res = mkRes();
    await ADD(mkReq(body()), res as never);
    expect(packs.addSavedBankAccount).toHaveBeenCalledWith({
      customerId: 'cus_1',
      adminId: 'user_1',
      account: expect.objectContaining({
        id: ACCOUNT.id,
        bankCode: 'MBBEMYKL',
        accountHolderName: 'Test Holder',
      }),
      verify: false,
      reason: 'owner proved it',
    });
    expect(res.json).toHaveBeenCalledWith({ added: true });
    const sent = JSON.stringify(notifications.createNotifications.mock.calls);
    expect(sent).not.toContain('512345678901');
  });

  // One name per account (owner, 2026-11-16): support adds in the real name
  // only, and corrects the real name first to fix a spelling.
  it('adds in the real name, never a typed holder name', async () => {
    await ADD(
      mkReq(body({ account_holder_name: 'Someone Else' })),
      mkRes() as never,
    );
    expect(packs.getVerificationState).toHaveBeenCalledWith('cus_1');
    expect(packs.addSavedBankAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        account: expect.objectContaining({ accountHolderName: 'Test Holder' }),
      }),
    );
  });

  it('refuses with no real name on file, or one not in English letters', async () => {
    packs.getVerificationState.mockResolvedValue({
      phoneVerified: true,
      realName: null,
    });
    await expect(ADD(mkReq(body()), mkRes() as never)).rejects.toThrow(
      /no real name on file/,
    );
    packs.getVerificationState.mockResolvedValue({
      phoneVerified: true,
      realName: '陈大文',
    });
    await expect(ADD(mkReq(body()), mkRes() as never)).rejects.toThrow(
      /not in English letters.*Correct the real name first/,
    );
    expect(packs.payoutNumberStanding).not.toHaveBeenCalled();
    expect(packs.addSavedBankAccount).not.toHaveBeenCalled();
  });

  // Read before the add's lock: a correction landing in between must not leave
  // the bank in the old name.
  it('takes the add back when the real name changes during it', async () => {
    packs.getVerificationState
      .mockResolvedValueOnce({ phoneVerified: true, realName: 'Test Holder' })
      .mockResolvedValueOnce({ phoneVerified: true, realName: 'Test Holdre' });
    await expect(ADD(mkReq(body()), mkRes() as never)).rejects.toThrow(
      /real name changed.*try again/i,
    );
    expect(packs.addSavedBankAccount).toHaveBeenCalledTimes(1);
    expect(packs.removeSavedBankAccount).toHaveBeenCalledWith({
      customerId: 'cus_1',
      adminId: 'user_1',
      accountId: ACCOUNT.id,
      reason: expect.stringMatching(/real name changed/),
    });
    expect(notifications.createNotifications).not.toHaveBeenCalled();
  });

  it('a wallet needs no real name', async () => {
    packs.getVerificationState.mockResolvedValue({
      phoneVerified: true,
      realName: null,
    });
    await ADD(
      mkReq(
        body({
          bank_code: 'USDTTRC20',
          account_number: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
        }),
      ),
      mkRes() as never,
    );
    expect(packs.getVerificationState).not.toHaveBeenCalled();
    expect(packs.addSavedBankAccount).toHaveBeenCalledTimes(1);
  });

  it('refuses a banned number, asked for this player', async () => {
    packs.payoutNumberStanding.mockResolvedValue(
      standing([], { banned: true, bannedForPlayer: true }),
    );
    await expect(
      ADD(
        mkReq(body({ bank_code: 'PAYNOWSG', account_number: '91234567' })),
        mkRes() as never,
      ),
    ).rejects.toThrow(/cannot be used on Polycards/);
    expect(packs.payoutNumberStanding).toHaveBeenCalledWith('cus_1', {
      bankCode: 'PAYNOWSG',
      accountNumber: '91234567',
    });
    expect(packs.addSavedBankAccount).not.toHaveBeenCalled();
  });

  it('adds a number support unbanned for this player', async () => {
    packs.payoutNumberStanding.mockResolvedValue(
      standing([], { banned: true, bannedForPlayer: false }),
    );
    await ADD(mkReq(body()), mkRes() as never);
    expect(packs.addSavedBankAccount).toHaveBeenCalledTimes(1);
  });

  it('vouches for a shared number by adding it', async () => {
    packs.payoutNumberStanding.mockResolvedValue(
      standing([{ customerId: 'cus_2', paid: false }]),
    );
    await ADD(mkReq(body()), mkRes() as never);
    expect(packs.addSavedBankAccount).toHaveBeenCalledWith(
      expect.objectContaining({ verify: true }),
    );
  });

  it('one person, one account: refuses while another account is verified on it', async () => {
    packs.payoutNumberStanding.mockResolvedValue(heldBy('cus_2', true));
    customers.listCustomers.mockResolvedValue([
      { id: 'cus_2', metadata: { handle: 'Collector2' } },
    ]);
    await expect(ADD(mkReq(body()), mkRes() as never)).rejects.toThrow(
      /Collector2 is already verified/,
    );
    expect(packs.addSavedBankAccount).not.toHaveBeenCalled();
  });
});

describe('POST bank-accounts/name-clash', () => {
  const body = { holder_name: '  Tan  Ah Kow ', cleared: true, reason: 'checked' };

  it('clears the stored form of the name for this player, as the admin', async () => {
    const res = mkRes();
    await NAME_CLASH(mkReq(body), res as never);
    expect(packs.setHolderNameCleared).toHaveBeenCalledWith({
      customerId: 'cus_1',
      adminId: 'user_1',
      holderName: 'Tan Ah Kow',
      cleared: true,
      reason: 'checked',
    });
    expect(res.json).toHaveBeenCalledWith({ cleared: true });
  });

  it.each([
    [{ ...body, holder_name: '' }, /English letters/],
    [{ ...body, holder_name: '陈大文' }, /English letters/],
    [{ ...body, cleared: 'yes' }, /true or false/],
    [{ ...body, reason: ' ' }, /reason/],
  ])('refuses %j', async (bad, message) => {
    await expect(NAME_CLASH(mkReq(bad), mkRes() as never)).rejects.toThrow(message);
    expect(packs.setHolderNameCleared).not.toHaveBeenCalled();
  });
});

describe('GET bank-accounts — cleared names', () => {
  it('lists the names support cleared for this player', async () => {
    customers.retrieveCustomer.mockResolvedValue({
      metadata: {
        bank_accounts: [ACCOUNT],
        holder_name_cleared: {
          testholder: { name: 'Test Holder', at: STAMP, with: ['cus_2'] },
        },
      },
    });
    customers.listCustomers.mockResolvedValue([
      { id: 'cus_2', metadata: { handle: 'Collector2' } },
    ]);
    const res = mkRes();
    await GET(mkReq(), res as never);
    expect(res.json.mock.calls[0][0].cleared_names).toEqual([
      {
        name: 'Test Holder',
        cleared_at: STAMP,
        with: [{ customer_id: 'cus_2', handle: 'Collector2' }],
      },
    ]);
  });
});

describe('POST bank-accounts/unban-number', () => {
  it('lifts the named number for this player, as the admin', async () => {
    const res = mkRes();
    await UNBAN_NUMBER(mkReq({ last4: '8901', reason: ' owner ok ' }), res as never);
    expect(packs.setPayoutBanLifted).toHaveBeenCalledWith({
      customerId: 'cus_1',
      adminId: 'user_1',
      last4: '8901',
      bankCode: null,
      lifted: true,
      reason: 'owner ok',
      // No roles on this request: never the ban-list fallback.
      fromBanList: false,
    });
    expect(res.json).toHaveBeenCalledWith({
      bank_code: 'MBBEMYKL',
      last4: '8901',
      lifted: true,
      changed: true,
    });
  });

  it.each([
    [['role_super_admin'], true],
    [['customer_editor'], true],
    [['support_viewer'], false],
    // The lookup failing refuses the fallback, not the unban.
    [['broken_role'], false],
  ])('roles %j: from the ban list %s', async (roles, fromBanList) => {
    const req = mkReq({ last4: '8901', reason: 'x' }) as unknown as {
      auth_context: Record<string, unknown>;
    };
    req.auth_context = { ...req.auth_context, app_metadata: { roles } };
    await UNBAN_NUMBER(req as never, mkRes() as never);
    expect(packs.setPayoutBanLifted).toHaveBeenCalledWith(
      expect.objectContaining({ fromBanList }),
    );
  });

  it.each([
    [{ last4: '89', reason: 'x' }, /last 4/],
    [{ last4: 'AB01', reason: 'x' }, /last 4/],
    [{ last4: '8901', reason: '' }, /reason/],
    [{ last4: '8901', bank_code: 7, reason: 'x' }, /bank/],
    [{ last4: '8901', lifted: 'yes', reason: 'x' }, /true or false/],
  ])('refuses %j', async (bad, message) => {
    await expect(UNBAN_NUMBER(mkReq(bad), mkRes() as never)).rejects.toThrow(message);
    expect(packs.setPayoutBanLifted).not.toHaveBeenCalled();
  });

  it("GET lists the player's banned numbers by bank name and last 4", async () => {
    packs.bannedPayoutAccountsOf.mockResolvedValue([
      {
        account_key: '512345678901',
        bank_code: 'MBBEMYKL',
        last4: '8901',
        lifted_for_player: true,
      },
    ]);
    const res = mkRes();
    await GET(mkReq(), res as never);
    expect(res.json.mock.calls[0][0].banned_numbers).toEqual([
      {
        bank_code: 'MBBEMYKL',
        bank_name: 'Maybank',
        last4: '8901',
        lifted_for_player: true,
      },
    ]);
    expect(JSON.stringify(res.json.mock.calls[0][0].banned_numbers)).not.toContain(
      '512345678901',
    );
  });
});
