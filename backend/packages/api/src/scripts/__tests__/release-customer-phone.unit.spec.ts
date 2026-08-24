// This script's whole job is the duplicate-count safety guard (see its
// docblock) plus the env-var gates and echo-the-id confirm shared with
// delete-customer-account.ts. Every collaborator is mocked so a bug here can
// never mask, or be masked by, a bug in the customer/packs modules
// themselves — same idiom as delete-customer-account.unit.spec.ts.
import {
  ContainerRegistrationKeys,
  MedusaError,
  Modules,
} from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../modules/packs';
import releaseCustomerPhone from '../release-customer-phone';

const retrieveCustomer = jest.fn();
const listAndCountCustomers = jest.fn();
const updateCustomers = jest.fn();
const listCustomerAccountStates = jest.fn();
const updateCustomerAccountStates = jest.fn();
const createAdminActionAudits = jest.fn();
const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

const container = {
  resolve: jest.fn((key: string) => {
    if (key === PACKS_MODULE)
      return {
        listCustomerAccountStates,
        updateCustomerAccountStates,
        createAdminActionAudits,
      };
    if (key === Modules.CUSTOMER)
      return { retrieveCustomer, listAndCountCustomers, updateCustomers };
    if (key === ContainerRegistrationKeys.LOGGER) return logger;
    throw new Error(`unexpected resolve key in test: ${key}`);
  }),
} as never;

const run = () => releaseCustomerPhone({ container, args: [] } as never);

const DEFAULT_CUSTOMER = {
  id: 'cus_1',
  email: 'a@b.dev',
  phone: '+60123456789',
  has_account: true,
};

describe('release-customer-phone script guards', () => {
  beforeEach(() => {
    delete process.env.RELEASE_CUSTOMER_ID;
    delete process.env.RELEASE_REASON;
    delete process.env.CONFIRM_RELEASE;

    retrieveCustomer.mockReset().mockResolvedValue({ ...DEFAULT_CUSTOMER });
    // Default: 2 has_account:true rows carry this exact phone — the target
    // plus one other — so the release is legal by default; tests that need
    // the "not duplicated" refusal override this explicitly. Real ids, not
    // just a count: the guard filters rows by id, so a test that returned
    // an empty rows array here couldn't prove the filter actually excludes
    // the target's own row.
    listAndCountCustomers
      .mockReset()
      .mockResolvedValue([[{ id: 'cus_1' }, { id: 'cus_2' }], 2]);
    updateCustomers.mockReset();
    listCustomerAccountStates.mockReset().mockResolvedValue([
      { id: 'cas_1', phone_verified_at: new Date('2026-01-01T00:00:00Z') },
    ]);
    updateCustomerAccountStates.mockReset();
    createAdminActionAudits.mockReset();
    logger.info.mockClear();
    logger.error.mockClear();
  });

  it('RELEASE_CUSTOMER_ID unset: logs an error and calls no service at all', async () => {
    process.env.RELEASE_REASON = 'dup phone cleanup';
    await run();
    expect(logger.error).toHaveBeenCalled();
    expect(retrieveCustomer).not.toHaveBeenCalled();
    expect(listAndCountCustomers).not.toHaveBeenCalled();
    expect(updateCustomers).not.toHaveBeenCalled();
  });

  it('RELEASE_REASON unset: logs an error and writes nothing', async () => {
    process.env.RELEASE_CUSTOMER_ID = 'cus_1';
    await run();
    expect(logger.error).toHaveBeenCalled();
    expect(retrieveCustomer).not.toHaveBeenCalled();
    expect(updateCustomers).not.toHaveBeenCalled();
  });

  // Sourcery flagged the equivalent gap on delete-customer-account.ts (PR
  // #478): a blanket catch that treats any lookup failure as "not found"
  // would print the same clean message for a genuine miss and for an
  // outage. These two cases pin the isNotFound split this script reuses.
  it('initial lookup rejects NOT_FOUND: prints does-not-resolve, calls no other service', async () => {
    process.env.RELEASE_CUSTOMER_ID = 'cus_1';
    process.env.RELEASE_REASON = 'dup phone cleanup';
    retrieveCustomer
      .mockReset()
      .mockRejectedValue(
        new MedusaError(MedusaError.Types.NOT_FOUND, 'Customer not found'),
      );
    await run();
    expect(
      logger.error.mock.calls.some((c) =>
        String(c[0]).includes('does not resolve'),
      ),
    ).toBe(true);
    expect(listAndCountCustomers).not.toHaveBeenCalled();
    expect(updateCustomers).not.toHaveBeenCalled();
  });

  it('initial lookup rejects with a generic error (an outage): surfaces the failure, never prints does-not-resolve, never proceeds', async () => {
    process.env.RELEASE_CUSTOMER_ID = 'cus_1';
    process.env.RELEASE_REASON = 'dup phone cleanup';
    retrieveCustomer.mockReset().mockRejectedValue(new Error('connection reset'));
    await expect(run()).rejects.toThrow(/connection reset/);
    expect(
      logger.error.mock.calls.some((c) =>
        String(c[0]).includes('does not resolve'),
      ),
    ).toBe(false);
    expect(listAndCountCustomers).not.toHaveBeenCalled();
    expect(updateCustomers).not.toHaveBeenCalled();
  });

  it('target phone already null: clean stop reported via info (not error), no write', async () => {
    process.env.RELEASE_CUSTOMER_ID = 'cus_1';
    process.env.RELEASE_REASON = 'dup phone cleanup';
    retrieveCustomer
      .mockReset()
      .mockResolvedValue({ ...DEFAULT_CUSTOMER, phone: null });
    await run();
    expect(
      logger.info.mock.calls.some((c) =>
        String(c[0]).includes('already has no phone'),
      ),
    ).toBe(true);
    expect(listAndCountCustomers).not.toHaveBeenCalled();
    expect(updateCustomers).not.toHaveBeenCalled();
  });

  // The load-bearing safety property: CONFIRM_RELEASE matching must NOT be
  // enough to bypass the duplicate-count guard. Proven by setting it here
  // and asserting the refusal still wins.
  it('phone not duplicated (no other holder): REFUSES even with CONFIRM_RELEASE matching, no write', async () => {
    process.env.RELEASE_CUSTOMER_ID = 'cus_1';
    process.env.RELEASE_REASON = 'dup phone cleanup';
    process.env.CONFIRM_RELEASE = 'cus_1';
    // Only the target's own row matches — the id filter must exclude it and
    // land on zero OTHER holders.
    listAndCountCustomers.mockReset().mockResolvedValue([[{ id: 'cus_1' }], 1]);
    await run();
    expect(
      logger.error.mock.calls.some((c) => String(c[0]).includes('REFUSED')),
    ).toBe(true);
    expect(updateCustomers).not.toHaveBeenCalled();
    expect(updateCustomerAccountStates).not.toHaveBeenCalled();
    expect(createAdminActionAudits).not.toHaveBeenCalled();
  });

  // ABSOLUTE: if the duplicate count cannot be determined, refuse rather
  // than proceed. take: 50 is a cap on the rows fetched; if the true count
  // exceeds what was actually read back, the guard cannot trust its own
  // filter and must not guess.
  it('matching rows exceed what could be read back: cannot verify the count safely, REFUSES, no write', async () => {
    process.env.RELEASE_CUSTOMER_ID = 'cus_1';
    process.env.RELEASE_REASON = 'dup phone cleanup';
    process.env.CONFIRM_RELEASE = 'cus_1';
    listAndCountCustomers
      .mockReset()
      .mockResolvedValue([[{ id: 'cus_1' }], 2]); // count says 2, only 1 row came back
    await run();
    expect(
      logger.error.mock.calls.some((c) => String(c[0]).includes('REFUSED')),
    ).toBe(true);
    expect(updateCustomers).not.toHaveBeenCalled();
    expect(updateCustomerAccountStates).not.toHaveBeenCalled();
    expect(createAdminActionAudits).not.toHaveBeenCalled();
  });

  it('dry run (no CONFIRM_RELEASE): the duplicate check still runs, but nothing is written', async () => {
    process.env.RELEASE_CUSTOMER_ID = 'cus_1';
    process.env.RELEASE_REASON = 'dup phone cleanup';
    await run();
    expect(listAndCountCustomers).toHaveBeenCalled();
    expect(
      logger.info.mock.calls.some((c) => String(c[0]).includes('DRY RUN')),
    ).toBe(true);
    expect(updateCustomers).not.toHaveBeenCalled();
  });

  it('CONFIRM_RELEASE set to the wrong id: refuses, no writes', async () => {
    process.env.RELEASE_CUSTOMER_ID = 'cus_1';
    process.env.RELEASE_REASON = 'dup phone cleanup';
    process.env.CONFIRM_RELEASE = 'cus_2';
    await run();
    expect(updateCustomers).not.toHaveBeenCalled();
    expect(updateCustomerAccountStates).not.toHaveBeenCalled();
    expect(createAdminActionAudits).not.toHaveBeenCalled();
  });

  it('CONFIRM_RELEASE matching: nulls the phone, clears the verified stamp, appends exactly one audit row', async () => {
    process.env.RELEASE_CUSTOMER_ID = 'cus_1';
    process.env.RELEASE_REASON = 'dup phone cleanup';
    process.env.CONFIRM_RELEASE = 'cus_1';
    await run();

    expect(updateCustomers).toHaveBeenCalledTimes(1);
    expect(updateCustomers).toHaveBeenCalledWith('cus_1', { phone: null });

    expect(updateCustomerAccountStates).toHaveBeenCalledTimes(1);
    expect(updateCustomerAccountStates).toHaveBeenCalledWith({
      selector: { id: 'cas_1' },
      data: { phone_verified_at: null },
    });

    expect(createAdminActionAudits).toHaveBeenCalledTimes(1);
    const [rows] = createAdminActionAudits.mock.calls[0];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      admin_id: expect.any(String),
      entity_type: 'customer',
      entity_id: 'cus_1',
      action: 'edit',
      reason: 'dup phone cleanup',
    });
    // Never the full phone number in the persisted audit row.
    expect(JSON.stringify(rows[0])).not.toContain('+60123456789');
  });

  it('phone_verified_at already null on an existing row: no account-state write; release still proceeds', async () => {
    process.env.RELEASE_CUSTOMER_ID = 'cus_1';
    process.env.RELEASE_REASON = 'dup phone cleanup';
    process.env.CONFIRM_RELEASE = 'cus_1';
    listCustomerAccountStates
      .mockReset()
      .mockResolvedValue([{ id: 'cas_1', phone_verified_at: null }]);
    await run();
    expect(updateCustomerAccountStates).not.toHaveBeenCalled();
    expect(updateCustomers).toHaveBeenCalledTimes(1);
    expect(createAdminActionAudits).toHaveBeenCalledTimes(1);
  });

  it('no customer_account_state row at all: no account-state write, no row created; release still proceeds', async () => {
    process.env.RELEASE_CUSTOMER_ID = 'cus_1';
    process.env.RELEASE_REASON = 'dup phone cleanup';
    process.env.CONFIRM_RELEASE = 'cus_1';
    listCustomerAccountStates.mockReset().mockResolvedValue([]);
    await run();
    expect(updateCustomerAccountStates).not.toHaveBeenCalled();
    expect(updateCustomers).toHaveBeenCalledTimes(1);
    expect(createAdminActionAudits).toHaveBeenCalledTimes(1);
  });
});
