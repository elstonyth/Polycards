import { savedBankAccountId } from '../../../../../../modules/packs/saved-accounts';
import { GET } from '../route';
import { POST as ADD } from '../add/route';
import { POST as REMOVE } from '../remove/route';
import { POST as VERIFY } from '../verify/route';

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

const packs = {
  otherPayoutAccountHolders: jest.fn(),
  createAdminActionAudits: jest.fn(),
  removeSavedBankAccount: jest.fn(),
  setBankShareVerified: jest.fn(),
  addSavedBankAccount: jest.fn(),
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
const holderOn = (customer: string, bank = 'MBBEMYKL') => ({
  customer_id: customer,
  bank_code: bank,
  holder_name: null,
});

beforeEach(() => {
  jest.clearAllMocks();
  packs.otherPayoutAccountHolders.mockResolvedValue([]);
  packs.createAdminActionAudits.mockResolvedValue(undefined);
  customers.retrieveCustomer.mockResolvedValue({
    metadata: { bank_accounts: [ACCOUNT] },
    email: 'a@b.test',
  });
  customers.listCustomers.mockResolvedValue([]);
});

describe('GET bank-accounts', () => {
  it('names who else is on the number, once each, and never caches', async () => {
    packs.otherPayoutAccountHolders.mockResolvedValue([
      { customer_id: 'cus_2', bank_code: 'MBBEMYKL', holder_name: 'X' },
      holderOn('cus_2'),
      holderOn('cus_3', 'PBBEMYKL'),
    ]);
    customers.listCustomers.mockResolvedValue([
      { id: 'cus_2', metadata: { handle: 'Collector2' } },
    ]);
    const res = mkRes();
    await GET(mkReq(), res as never);
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    const body = res.json.mock.calls[0][0];
    expect(body.accounts).toEqual([
      expect.objectContaining({
        id: ACCOUNT.id,
        account_number: '512345678901',
        verified_at: null,
        // cus_3 holds the same digits at another bank: a different account.
        linked: [{ customer_id: 'cus_2', handle: 'Collector2' }],
      }),
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
    packs.otherPayoutAccountHolders.mockResolvedValue([holderOn('cus_2')]);
    customers.listCustomers.mockResolvedValue([
      {
        id: 'cus_2',
        metadata: {
          handle: 'Collector2',
          bank_accounts: [ACCOUNT],
          bank_share_verified: { [ACCOUNT.id]: STAMP },
        },
      },
    ]);
    await expect(VERIFY(verify(), mkRes() as never)).rejects.toThrow(
      /Collector2 is already verified/,
    );
    expect(packs.setBankShareVerified).not.toHaveBeenCalled();
  });

  it('a stamp on another number of theirs does not count', async () => {
    packs.otherPayoutAccountHolders.mockResolvedValue([holderOn('cus_2')]);
    const elsewhere = {
      ...ACCOUNT,
      id: 'other',
      accountNumber: '999999999999',
    };
    customers.listCustomers.mockResolvedValue([
      {
        id: 'cus_2',
        metadata: {
          bank_accounts: [elsewhere],
          bank_share_verified: { other: STAMP },
        },
      },
    ]);
    await VERIFY(verify(), mkRes() as never);
    expect(packs.setBankShareVerified).toHaveBeenCalledTimes(1);
  });

  it('verifies with the admin from the token, for this account', async () => {
    packs.otherPayoutAccountHolders.mockResolvedValue([holderOn('cus_2')]);
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
    expect(packs.otherPayoutAccountHolders).not.toHaveBeenCalled();
  });
});

describe('POST bank-accounts/add', () => {
  const body = (over: Record<string, unknown> = {}) => ({
    bank_code: 'MBBEMYKL',
    account_number: '512345678901',
    account_holder_name: ' Test Holder ',
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

  it('vouches for a shared number by adding it', async () => {
    packs.otherPayoutAccountHolders.mockResolvedValue([holderOn('cus_2')]);
    customers.listCustomers.mockResolvedValue([
      { id: 'cus_2', metadata: { bank_accounts: [] } },
    ]);
    await ADD(mkReq(body()), mkRes() as never);
    expect(packs.addSavedBankAccount).toHaveBeenCalledWith(
      expect.objectContaining({ verify: true }),
    );
  });

  it('one person, one account: refuses while another account is verified on it', async () => {
    packs.otherPayoutAccountHolders.mockResolvedValue([holderOn('cus_2')]);
    customers.listCustomers.mockResolvedValue([
      {
        id: 'cus_2',
        metadata: {
          handle: 'Collector2',
          bank_accounts: [ACCOUNT],
          bank_share_verified: { [ACCOUNT.id]: STAMP },
        },
      },
    ]);
    await expect(ADD(mkReq(body()), mkRes() as never)).rejects.toThrow(
      /Collector2 is already verified/,
    );
    expect(packs.addSavedBankAccount).not.toHaveBeenCalled();
  });
});
