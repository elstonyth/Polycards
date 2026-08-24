// The deletion sequence itself (purgeAndDeleteAccount) already has coverage —
// self-service.unit.spec.ts and account-lifecycle.unit.spec.ts. This file
// covers only the SCRIPT's own guards: the env-var gate, the echo-the-id
// confirm, and that a preflight refusal is never bypassed. The write path is
// mocked out wholesale so a bug in this file can never mask (or be masked by)
// a bug in the shared purge — jest allows a factory to close over a variable
// whose name starts with `mock`, same idiom as self-service.unit.spec.ts:6-9.
const mockPurgeAndDeleteAccount = jest.fn();
// Wrapped in a lazily-invoked arrow rather than passed directly: the factory
// below runs at hoist time, BEFORE the `const` on the line above initializes
// — a direct `purgeAndDeleteAccount: mockPurgeAndDeleteAccount` reference
// hits the TDZ. The wrapper defers the read until the mock is actually
// CALLED, by which point module evaluation has finished. Same shape as
// self-service.unit.spec.ts:6-9's `deleteFilesWorkflow: jest.fn(() => ({
// run: mockRunWorkflow }))`.
jest.mock('../../api/utils/account-deletion', () => ({
  purgeAndDeleteAccount: (...args: unknown[]) => mockPurgeAndDeleteAccount(...args),
}));

import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../modules/packs';
import deleteCustomerAccount from '../delete-customer-account';

const retrieveCustomer = jest.fn();
const listAndCountPulls = jest.fn();
const deleteAccountPreflight = jest.fn();
const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

const container = {
  resolve: jest.fn((key: string) => {
    if (key === PACKS_MODULE) return { listAndCountPulls, deleteAccountPreflight };
    if (key === Modules.CUSTOMER) return { retrieveCustomer };
    if (key === ContainerRegistrationKeys.LOGGER) return logger;
    throw new Error(`unexpected resolve key in test: ${key}`);
  }),
} as never;

const run = () => deleteCustomerAccount({ container, args: [] } as never);

describe('delete-customer-account script guards', () => {
  beforeEach(() => {
    delete process.env.DELETE_CUSTOMER_ID;
    delete process.env.CONFIRM_DELETE;
    mockPurgeAndDeleteAccount.mockReset();
    retrieveCustomer.mockReset().mockImplementation(
      async (id: string, options?: { withDeleted?: boolean }) =>
        options?.withDeleted
          ? { id, phone: null }
          : {
              id,
              email: 'a@b.dev',
              phone: '+60123456789',
              has_account: true,
            },
    );
    listAndCountPulls.mockReset().mockResolvedValue([[], 3]);
    deleteAccountPreflight.mockReset().mockResolvedValue({ ok: true });
    logger.info.mockClear();
    logger.error.mockClear();
  });

  it('DELETE_CUSTOMER_ID unset: logs an error and calls no service at all', async () => {
    await run();
    expect(logger.error).toHaveBeenCalled();
    expect(retrieveCustomer).not.toHaveBeenCalled();
    expect(listAndCountPulls).not.toHaveBeenCalled();
    expect(deleteAccountPreflight).not.toHaveBeenCalled();
    expect(mockPurgeAndDeleteAccount).not.toHaveBeenCalled();
  });

  it('dry run (no CONFIRM_DELETE): the preflight verdict is read for display, but nothing is written', async () => {
    process.env.DELETE_CUSTOMER_ID = 'cus_1';
    await run();
    expect(retrieveCustomer).toHaveBeenCalledWith(
      'cus_1',
      expect.objectContaining({ select: expect.any(Array) }),
    );
    expect(deleteAccountPreflight).toHaveBeenCalledWith('cus_1');
    expect(mockPurgeAndDeleteAccount).not.toHaveBeenCalled();
  });

  it('CONFIRM_DELETE set to the wrong id: refuses, no writes', async () => {
    process.env.DELETE_CUSTOMER_ID = 'cus_1';
    process.env.CONFIRM_DELETE = 'cus_2';
    await run();
    expect(mockPurgeAndDeleteAccount).not.toHaveBeenCalled();
  });

  it('CONFIRM_DELETE matching: the deletion path is invoked exactly once', async () => {
    process.env.DELETE_CUSTOMER_ID = 'cus_1';
    process.env.CONFIRM_DELETE = 'cus_1';
    mockPurgeAndDeleteAccount.mockResolvedValue({ ok: true });
    await run();
    expect(mockPurgeAndDeleteAccount).toHaveBeenCalledTimes(1);
    expect(mockPurgeAndDeleteAccount).toHaveBeenCalledWith(container, 'cus_1');
  });

  // The preflight refusal has to come from purgeAndDeleteAccount itself
  // (mocked here to stand in for its own, already-covered re-check), never
  // from the script trusting the informational read above — that read and the
  // real gate are two different calls, and this is what proves the script
  // does not shortcut the second one.
  it('preflight refuses inside the write path: does not treat it as success, and exits non-zero', async () => {
    process.env.DELETE_CUSTOMER_ID = 'cus_1';
    process.env.CONFIRM_DELETE = 'cus_1';
    mockPurgeAndDeleteAccount.mockResolvedValue({
      ok: false,
      reason: 'BALANCE_NOT_ZERO',
      detail: 'Wallet balance is RM 12.50.',
    });
    await expect(run()).rejects.toThrow(/BALANCE_NOT_ZERO/);
    expect(mockPurgeAndDeleteAccount).toHaveBeenCalledTimes(1);
    // Only the BEFORE read happened — a success path's AFTER read
    // (withDeleted: true, proving the phone was released) never ran.
    expect(retrieveCustomer).toHaveBeenCalledTimes(1);
  });
});
