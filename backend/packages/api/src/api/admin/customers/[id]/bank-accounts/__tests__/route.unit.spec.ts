import { GET } from '../route';
import { POST as REMOVE } from '../remove/route';
import { POST as VERIFY } from '../verify/route';

// What support sees and does for a tied bank account (ADR 0015). The service
// methods are pinned in modules/packs/__tests__/saved-account-support; these pin
// the routes around them.

const ACCOUNT = {
  id: 'acc_1',
  bankCode: 'PBBEMYKL',
  bankName: 'Public Bank',
  accountNumber: '6800000013',
  accountHolderName: 'Game Story',
  savedAt: '2026-10-24T00:00:00.000Z',
};

const packs = {
  otherPayoutAccountHolders: jest.fn(),
  createAdminActionAudits: jest.fn(),
  removeSavedBankAccount: jest.fn(),
  setBankShareVerified: jest.fn(),
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
      { customer_id: 'cus_2', bank_code: 'PBBEMYKL', holder_name: 'X' },
      { customer_id: 'cus_2', bank_code: 'PBBEMYKL', holder_name: null },
      { customer_id: 'cus_3', bank_code: 'MBBEMYKL', holder_name: null },
    ]);
    customers.listCustomers.mockResolvedValue([
      { id: 'cus_2', metadata: { handle: 'Collector2' } },
    ]);
    const res = mkRes();
    await GET(mkReq(), res as never);
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(res.json).toHaveBeenCalledWith({
      verified_at: null,
      accounts: [
        expect.objectContaining({
          id: 'acc_1',
          account_number: '6800000013',
          // cus_3 holds the same digits at another bank: a different account.
          linked: [{ customer_id: 'cus_2', handle: 'Collector2' }],
        }),
      ],
    });
  });

  it('records the reveal with the last 4 only, and an audit outage does not deny the read', async () => {
    const res = mkRes();
    await GET(mkReq(), res as never);
    const [[row]] = packs.createAdminActionAudits.mock.calls[0];
    expect(row.action).toBe('reveal');
    expect(JSON.stringify(row)).not.toContain('6800000013');

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
      REMOVE(mkReq({ account_id: 'acc_1', reason: ' ' }), mkRes() as never),
    ).rejects.toThrow(/reason/i);
    expect(packs.removeSavedBankAccount).not.toHaveBeenCalled();
  });

  it('takes the admin from the token and tells the customer, last 4 only', async () => {
    packs.removeSavedBankAccount.mockResolvedValue(ACCOUNT);
    const res = mkRes();
    await REMOVE(
      mkReq({ account_id: 'acc_1', reason: ' changed bank ', adminId: 'evil' }),
      res as never,
    );
    expect(packs.removeSavedBankAccount).toHaveBeenCalledWith({
      customerId: 'cus_1',
      adminId: 'user_1',
      accountId: 'acc_1',
      reason: 'changed bank',
    });
    expect(res.json).toHaveBeenCalledWith({ removed: true });
    const sent = JSON.stringify(notifications.createNotifications.mock.calls);
    expect(sent).toContain('0013');
    expect(sent).not.toContain('6800000013');
  });

  it('stays silent when it was already gone', async () => {
    packs.removeSavedBankAccount.mockResolvedValue(null);
    const res = mkRes();
    await REMOVE(mkReq({ account_id: 'acc_1', reason: 'x' }), res as never);
    expect(res.json).toHaveBeenCalledWith({ removed: false });
    expect(notifications.createNotifications).not.toHaveBeenCalled();
  });
});

describe('POST bank-accounts/verify', () => {
  it('needs a boolean and a reason', async () => {
    await expect(
      VERIFY(mkReq({ verified: 'yes', reason: 'x' }), mkRes() as never),
    ).rejects.toThrow(/true or false/);
    await expect(
      VERIFY(mkReq({ verified: true }), mkRes() as never),
    ).rejects.toThrow(/reason/i);
    expect(packs.setBankShareVerified).not.toHaveBeenCalled();
  });

  it('one person, one account: refuses a second account on the number', async () => {
    packs.otherPayoutAccountHolders.mockResolvedValue([
      { customer_id: 'cus_2', bank_code: 'PBBEMYKL', holder_name: null },
    ]);
    customers.listCustomers.mockResolvedValue([
      {
        id: 'cus_2',
        metadata: {
          handle: 'Collector2',
          bank_share_verified_at: '2026-11-03T00:00:00.000Z',
        },
      },
    ]);
    await expect(
      VERIFY(mkReq({ verified: true, reason: 'x' }), mkRes() as never),
    ).rejects.toThrow(/Collector2 is already verified/);
    expect(packs.setBankShareVerified).not.toHaveBeenCalled();
  });

  it('lets the first account on the number through, and undo always', async () => {
    packs.otherPayoutAccountHolders.mockResolvedValue([
      { customer_id: 'cus_2', bank_code: 'PBBEMYKL', holder_name: null },
    ]);
    customers.listCustomers.mockResolvedValue([
      { id: 'cus_2', metadata: { handle: 'Collector2' } },
    ]);
    await VERIFY(mkReq({ verified: true, reason: 'x' }), mkRes() as never);
    expect(packs.setBankShareVerified).toHaveBeenCalledTimes(1);

    customers.listCustomers.mockResolvedValue([
      {
        id: 'cus_2',
        metadata: { bank_share_verified_at: '2026-11-03T00:00:00.000Z' },
      },
    ]);
    await VERIFY(mkReq({ verified: false, reason: 'x' }), mkRes() as never);
    expect(packs.setBankShareVerified).toHaveBeenCalledTimes(2);
  });

  it('sets it for this customer, with the admin from the token', async () => {
    const res = mkRes();
    await VERIFY(mkReq({ verified: true, reason: ' checked ' }), res as never);
    expect(packs.setBankShareVerified).toHaveBeenCalledWith({
      customerId: 'cus_1',
      adminId: 'user_1',
      verified: true,
      reason: 'checked',
    });
    expect(res.json).toHaveBeenCalledWith({ verified: true });
  });
});
