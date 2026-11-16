import { MedusaError } from '@medusajs/framework/utils';
import PacksModuleService from '../service';
import { savedBankAccountId } from '../saved-accounts';

/**
 * adminSetRealName — support correcting a real name carries it to the saved
 * banks in the old name (owner, 2026-11-16: one name per account, a bank's
 * holder IS the real name).
 *
 * Same fake-`this` technique as customer-metadata-lock.unit.spec.ts: the
 * decorators reuse a provided `sharedContext.transactionManager`, so the
 * advisory locks, the metadata read and its write are visible as raw SQL on
 * one `em`. What the real SQL does with two transactions is not provable here;
 * the ORDER that keeps it deadlock-free is (`metadata:` before `credit:`, as
 * liftPermanentBan takes them). Made-up details only: the repo is public.
 */

const bank = (number: string, holder: string, over: Record<string, unknown> = {}) => ({
  id: savedBankAccountId('MBBEMYKL', number),
  bankCode: 'MBBEMYKL',
  bankName: 'Maybank',
  accountNumber: number,
  accountHolderName: holder,
  savedAt: '2026-11-01T00:00:00.000Z',
  ...over,
});
const TRON = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const wallet = {
  id: savedBankAccountId('USDTTRC20', TRON),
  bankCode: 'USDTTRC20',
  bankName: 'USDT · TRC20 (Tron)',
  accountNumber: TRON,
  accountHolderName: 'USDT · TRC20 (Tron)',
  savedAt: '2026-11-01T00:00:00.000Z',
};

const fakeService = (
  oldName: string | null,
  metadata: Record<string, unknown> = {},
) => {
  const svc = Object.create(PacksModuleService.prototype) as PacksModuleService;
  const ops: string[] = [];
  let written: Record<string, unknown> | null = null;
  const em = {
    execute: jest.fn(async (query: string, params?: unknown[]) => {
      if (query.includes('pg_advisory_xact_lock')) {
        ops.push(`lock ${String(params?.[0])}`);
        return [];
      }
      if (query.startsWith('SELECT metadata')) {
        ops.push('read metadata');
        return [{ metadata }];
      }
      if (query.startsWith('UPDATE customer')) {
        ops.push('write metadata');
        written = JSON.parse(String(params?.[0]));
        return [];
      }
      throw new Error(`unexpected SQL: ${query}`);
    }),
  };
  const state = oldName === null ? [] : [{ id: 'cas_1', real_name: oldName }];
  const stub = svc as unknown as Record<string, jest.Mock>;
  stub.listCustomerAccountStates = jest.fn(async () => {
    ops.push('read state');
    return state;
  });
  stub.updateCustomerAccountStates = jest.fn(async () => ops.push('write state'));
  stub.createCustomerAccountStates = jest.fn(async () => ops.push('write state'));
  stub.createAdminActionAudits = jest.fn(async () => ops.push('audit'));
  return {
    svc,
    ops,
    stub,
    written: () => written as { bank_accounts: { accountHolderName: string }[] } | null,
    ctx: { transactionManager: em } as never,
  };
};

const correct = (
  f: ReturnType<typeof fakeService>,
  realName: string,
) =>
  f.svc.adminSetRealName(
    { customerId: 'cus_1', adminId: 'user_1', realName, reason: 'typo' },
    f.ctx,
  );

describe('PacksModuleService.adminSetRealName', () => {
  it('takes the metadata lock before the credit lock, then reads', async () => {
    const f = fakeService('Tan Ah Kow', { bank_accounts: [bank('512345678901', 'Tan Ah Kow')] });
    await correct(f, 'Tan Ah Kau');
    expect(f.ops.slice(0, 3)).toEqual([
      'lock metadata:cus_1',
      'lock credit:cus_1',
      'read state',
    ]);
    // mutateCustomerMetadata re-takes the lock this transaction already holds.
    expect(f.ops.filter((o) => o.startsWith('lock credit'))).toHaveLength(1);
  });

  it('carries the correction to the banks in the old name only, and audits each', async () => {
    const f = fakeService('Tan Ah-Kow', {
      avatar_url: 'keep',
      bank_accounts: [
        bank('512345678901', 'TAN AH KOW'),
        bank('512345678902', 'Lim Mei Ling', { bankCode: 'TNGMY', bankName: "Touch 'n Go eWallet" }),
        wallet,
      ],
    });
    await correct(f, 'Tan Ah Kau');
    const after = f.written()!;
    expect(after).toMatchObject({ avatar_url: 'keep' });
    expect(after.bank_accounts.map((a) => a.accountHolderName)).toEqual([
      'Tan Ah Kau',
      'Lim Mei Ling',
      'USDT · TRC20 (Tron)',
    ]);
    const [[[row]]] = f.stub.createAdminActionAudits.mock.calls;
    expect(row).toMatchObject({
      action: 'set_real_name',
      before: {
        real_name: 'Tan Ah-Kow',
        bank_holders: [{ bank: 'Maybank', last4: '8901', holder: 'TAN AH KOW' }],
      },
      after: {
        real_name: 'Tan Ah Kau',
        bank_holders: [{ bank: 'Maybank', last4: '8901', holder: 'Tan Ah Kau' }],
      },
    });
  });

  it('a case-only correction still carries to the bank', async () => {
    const f = fakeService('TAN AH KOW', { bank_accounts: [bank('512345678901', 'TAN AH KOW')] });
    await correct(f, 'Tan Ah Kow');
    expect(f.written()!.bank_accounts[0].accountHolderName).toBe('Tan Ah Kow');
  });

  it('writes no metadata when no bank is in the old name', async () => {
    const f = fakeService('Tan Ah Kow', { bank_accounts: [bank('512345678901', 'Lim Mei Ling'), wallet] });
    await correct(f, 'Tan Ah Kau');
    expect(f.ops).not.toContain('write metadata');
    const [[[row]]] = f.stub.createAdminActionAudits.mock.calls;
    expect(row.before).toEqual({ real_name: 'Tan Ah Kow' });
    expect(row.after).toEqual({ real_name: 'Tan Ah Kau' });
  });

  it('with no old name there is nothing to carry, and metadata is not read', async () => {
    const f = fakeService(null);
    await correct(f, 'Tan Ah Kau');
    expect(f.ops).not.toContain('read metadata');
    expect(f.ops).toContain('write state');
  });

  it('refuses a name not in English letters when a bank carries the old name, writing nothing', async () => {
    const f = fakeService('Tan Ah Kow', { bank_accounts: [bank('512345678901', 'Tan Ah Kow')] });
    await expect(correct(f, '陈大文')).rejects.toMatchObject({
      type: MedusaError.Types.NOT_ALLOWED,
      message: expect.stringMatching(/English letters/),
    });
    expect(f.ops).not.toContain('write metadata');
    expect(f.ops).not.toContain('write state');
    expect(f.ops).not.toContain('audit');
  });

  it('allows a name in another script when no bank carries the old name', async () => {
    const f = fakeService('Tan Ah Kow', { bank_accounts: [wallet] });
    await correct(f, '陈大文');
    expect(f.ops).toContain('write state');
  });
});
