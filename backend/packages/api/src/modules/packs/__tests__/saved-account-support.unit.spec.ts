import PacksModuleService from '../service';
import { heldByAnother, savedBankAccountId } from '../saved-accounts';

// Support is the only way a tied bank account changes (ADR 0015): removing one,
// and verifying a shared one. Same fake-`this` technique as
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

const fakeService = (metadata: Record<string, unknown>) => {
  const svc = Object.create(PacksModuleService.prototype) as PacksModuleService;
  const writes: Record<string, unknown>[] = [];
  const em = {
    execute: jest.fn(async (query: string, params: unknown[] = []) => {
      if (query.startsWith('SELECT metadata')) return [{ metadata }];
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

  it('removes it, clears the verification, keeps the rest, audits last 4 only', async () => {
    const { svc, writes, audits, ctx } = fakeService({
      avatar_url: 'a',
      bank_accounts: [ACCOUNT],
      bank_share_verified_at: '2026-11-03T00:00:00.000Z',
    });
    const removed = await svc.removeSavedBankAccount(input, ctx);
    expect(removed?.id).toBe(ACCOUNT.id);
    expect(writes).toEqual([{ avatar_url: 'a', bank_accounts: [] }]);
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

  it('keeps the verification when an extra comes off a longer list', async () => {
    const other = { ...ACCOUNT, id: 'other', accountNumber: '999999999999' };
    const { svc, writes, ctx } = fakeService({
      bank_accounts: [ACCOUNT, other],
      bank_share_verified_at: '2026-11-03T00:00:00.000Z',
    });
    await svc.removeSavedBankAccount(input, ctx);
    expect(writes).toEqual([
      {
        bank_accounts: [other],
        bank_share_verified_at: '2026-11-03T00:00:00.000Z',
      },
    ]);
  });

  it('is a no-op on an account already gone: no write, no audit row', async () => {
    const { svc, writes, audits, ctx } = fakeService({ bank_accounts: [] });
    expect(await svc.removeSavedBankAccount(input, ctx)).toBeNull();
    expect(writes).toEqual([]);
    expect(audits).toEqual([]);
  });
});

describe('setBankShareVerified', () => {
  const base = { customerId: 'cus_1', adminId: 'user_1', reason: 'checked ID' };

  it('stamps it and audits, leaving the rest of the blob', async () => {
    const { svc, writes, audits, ctx } = fakeService({
      bank_accounts: [ACCOUNT],
    });
    await svc.setBankShareVerified({ ...base, verified: true }, ctx);
    expect(writes[0].bank_accounts).toEqual([ACCOUNT]);
    expect(typeof writes[0].bank_share_verified_at).toBe('string');
    expect(audits[0][0]).toMatchObject({
      action: 'edit',
      after: { bank_share_verified: true },
      reason: 'Verified shared bank account: checked ID',
    });
  });

  it('clears it', async () => {
    const { svc, writes, audits, ctx } = fakeService({
      avatar_url: 'a',
      bank_share_verified_at: '2026-11-03T00:00:00.000Z',
    });
    await svc.setBankShareVerified({ ...base, verified: false }, ctx);
    expect(writes).toEqual([{ avatar_url: 'a' }]);
    expect(audits[0][0].reason).toBe(
      'Unverified shared bank account: checked ID',
    );
  });

  it('writes nothing when it is already in that state', async () => {
    const { svc, writes, audits, ctx } = fakeService({});
    await svc.setBankShareVerified({ ...base, verified: false }, ctx);
    expect(writes).toEqual([]);
    expect(audits).toEqual([]);
  });
});

describe('bankShareVerifiedFor', () => {
  it('reads the stamp, and a missing customer is not verified', async () => {
    const verified = fakeService({ bank_share_verified_at: 'x' });
    expect(await verified.svc.bankShareVerifiedFor('cus_1', verified.ctx)).toBe(
      true,
    );
    const plain = fakeService({});
    expect(await plain.svc.bankShareVerifiedFor('cus_1', plain.ctx)).toBe(
      false,
    );
  });
});

describe('heldByAnother', () => {
  it('counts any holder of a bank number, under a retired code too', () => {
    expect(
      heldByAnother(
        [{ bank_code: 'MYMB2U', holder_name: 'Anyone' }],
        'MBBEMYKL',
      ),
    ).toBe(true);
    expect(
      heldByAnother([{ bank_code: 'PBBEMYKL', holder_name: null }], 'MBBEMYKL'),
    ).toBe(false);
    expect(heldByAnother([], 'MBBEMYKL')).toBe(false);
  });

  it('counts only a wallet someone was already paid to', () => {
    expect(
      heldByAnother(
        [{ bank_code: 'USDTTRC20', holder_name: 'USDT' }],
        'USDTTRC20',
      ),
    ).toBe(false);
    expect(
      heldByAnother(
        [{ bank_code: 'USDTTRC20', holder_name: null }],
        'USDTTRC20',
      ),
    ).toBe(true);
  });
});
