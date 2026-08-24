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

// Finds the final DONE/ANOMALY summary line regardless of which word it
// used — the two are mutually exclusive outcomes of the same log call, so
// tests assert on the word itself rather than pre-supposing one.
const findSummary = () =>
  logger.info.mock.calls.find((c) =>
    /\[release-customer-phone\] (DONE|ANOMALY) —/.test(String(c[0])),
  )?.[0];

const DEFAULT_CUSTOMER = {
  id: 'cus_1',
  email: 'a@b.dev',
  phone: '+60123456789',
  has_account: true,
};

describe('release-customer-phone script guards', () => {
  let retrieveCustomerCalls = 0;

  beforeEach(() => {
    delete process.env.RELEASE_CUSTOMER_ID;
    delete process.env.RELEASE_REASON;
    delete process.env.CONFIRM_RELEASE;

    retrieveCustomerCalls = 0;
    // Smart default: call 1 is the initial lookup, call 2 is the pre-write
    // TOCTOU re-check (release-customer-phone.ts) — both return the
    // unchanged DEFAULT_CUSTOMER, so "nothing changed" is the default
    // scenario. Call 3+ is the post-release verification read; returning
    // phone: null there means any test that doesn't override retrieveCustomer
    // gets a realistic, fully-successful release (DONE) instead of an
    // accidental ANOMALY from a mock that never simulates the write actually
    // taking effect. Tests that want an anomalous verification read
    // override this with their own mockReset() + mockResolvedValueOnce
    // chain (which must then supply all 3 slots, in order).
    retrieveCustomer.mockReset().mockImplementation(async () => {
      retrieveCustomerCalls += 1;
      return retrieveCustomerCalls >= 3
        ? { id: 'cus_1', phone: null }
        : { ...DEFAULT_CUSTOMER };
    });
    // Default: 2 has_account:true rows carry this exact phone — the target
    // plus one other — so the release is legal by default; tests that need
    // the "not duplicated" refusal override this explicitly. Real ids, not
    // just a count: the guard filters rows by id, so a test that returned
    // an empty rows array here couldn't prove the filter actually excludes
    // the target's own row. This same blanket default also answers the
    // SECOND (unfiltered) read and the TOCTOU re-check read, since a plain
    // (non-Once) mockResolvedValue answers every call not otherwise queued
    // — matchingCount === allHoldersCount by default, so no
    // has_account:false warning fires unless a test overrides this.
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
    logger.warn.mockClear();
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

  // Sourcery (PR #479): CONFIRM_RELEASE was trimmed before comparison, so
  // ' cus_1 ' silently matched 'cus_1' despite the docblock's "EXACTLY".
  // Compared untrimmed now — this pins the rejection.
  it('CONFIRM_RELEASE with surrounding whitespace: rejected, not silently trimmed into a match', async () => {
    process.env.RELEASE_CUSTOMER_ID = 'cus_1';
    process.env.RELEASE_REASON = 'dup phone cleanup';
    process.env.CONFIRM_RELEASE = ' cus_1 ';
    await run();
    expect(updateCustomers).not.toHaveBeenCalled();
    expect(
      logger.info.mock.calls.some((c) => String(c[0]).includes('DRY RUN')),
    ).toBe(true);
  });

  it('CONFIRM_RELEASE matching: nulls the phone, clears the verified stamp, appends exactly one audit row', async () => {
    process.env.RELEASE_CUSTOMER_ID = 'cus_1';
    process.env.RELEASE_REASON = 'dup phone cleanup';
    process.env.CONFIRM_RELEASE = 'cus_1';
    await run();

    // Pins the guard's FILTER BASIS, not just its arithmetic: exact phone
    // string + has_account: true is what makes this predict the same
    // grouping the future partial unique index enforces (plan 124). Without
    // this, a mock that ignores its arguments would still pass even if the
    // real query dropped has_account or matched the wrong phone.
    expect(listAndCountCustomers).toHaveBeenCalledWith(
      expect.objectContaining({ phone: '+60123456789', has_account: true }),
      expect.objectContaining({ take: expect.any(Number) }),
    );
    // The has_account:true-scoped guard, the unfiltered has_account:false
    // blind-spot read, and the pre-write TOCTOU re-check all ran exactly
    // once each on the happy path.
    expect(listAndCountCustomers).toHaveBeenCalledTimes(3);

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

    // The true happy path must render as DONE, never ANOMALY.
    const summary = findSummary();
    expect(summary).toContain('DONE');
  });

  // Unlike delete-customer-account.ts, this script's write never removes the
  // customer row — only the phone column. So a NOT_FOUND on the post-release
  // re-read is an anomaly (the release write already ran, the row vanished
  // some other way), not proof of success, and must NOT collapse into the
  // same '(none)' string a genuine release produces.
  it('post-release re-read rejects NOT_FOUND: renders as ANOMALY, not the (none) success shape, names the anomaly', async () => {
    process.env.RELEASE_CUSTOMER_ID = 'cus_1';
    process.env.RELEASE_REASON = 'dup phone cleanup';
    process.env.CONFIRM_RELEASE = 'cus_1';
    retrieveCustomer
      .mockReset()
      .mockResolvedValueOnce({ ...DEFAULT_CUSTOMER }) // initial lookup
      .mockResolvedValueOnce({ ...DEFAULT_CUSTOMER }) // TOCTOU re-check: unchanged, passes
      .mockRejectedValueOnce(
        new MedusaError(MedusaError.Types.NOT_FOUND, 'Customer not found'),
      ); // post-release re-read
    await run();
    // The write path already ran — a failed verification read is a
    // reporting problem, not a reason the release itself didn't happen.
    expect(updateCustomers).toHaveBeenCalledTimes(1);
    const summary = findSummary();
    expect(summary).toBeDefined();
    expect(summary).toContain('ANOMALY');
    expect(summary).not.toContain('(none)');
    expect(summary).toContain('MISSING');
  });

  // Sourcery (PR #479): a non-null phone read back was masked (e.g.
  // '••••6789') but the line still unconditionally said "DONE — released",
  // so an operator could read a masked value, not notice it wasn't '(none)',
  // and conclude the collision was resolved when it was not.
  it('post-release re-read resolves with a non-null phone: renders as ANOMALY, wording says the release did not take', async () => {
    process.env.RELEASE_CUSTOMER_ID = 'cus_1';
    process.env.RELEASE_REASON = 'dup phone cleanup';
    process.env.CONFIRM_RELEASE = 'cus_1';
    retrieveCustomer
      .mockReset()
      .mockResolvedValueOnce({ ...DEFAULT_CUSTOMER }) // initial lookup
      .mockResolvedValueOnce({ ...DEFAULT_CUSTOMER }) // TOCTOU re-check: unchanged, passes
      .mockResolvedValueOnce({ id: 'cus_1', phone: '+60123456789' }); // still set!
    await run();
    expect(updateCustomers).toHaveBeenCalledTimes(1); // the write still ran
    const summary = findSummary();
    expect(summary).toBeDefined();
    expect(summary).toContain('ANOMALY');
    expect(summary).not.toMatch(/\bDONE\b/);
    expect(String(summary).toLowerCase()).toContain('did not take');
  });

  // Fix for the has_account:false blind spot (docblock): the guard itself
  // stays has_account:true-scoped and must NOT refuse on this by itself —
  // it only warns, and the release still proceeds.
  it('has_account:false row also holds the phone: warns without refusing; the numbers surface in both the info block and the final summary', async () => {
    process.env.RELEASE_CUSTOMER_ID = 'cus_1';
    process.env.RELEASE_REASON = 'dup phone cleanup';
    process.env.CONFIRM_RELEASE = 'cus_1';
    listAndCountCustomers
      .mockReset()
      .mockResolvedValueOnce([[{ id: 'cus_1' }, { id: 'cus_2' }], 2]) // guard: has_account:true only
      .mockResolvedValueOnce([[], 3]) // unfiltered: 3 total -> 1 has_account:false row hiding
      .mockResolvedValueOnce([[{ id: 'cus_1' }, { id: 'cus_2' }], 2]); // TOCTOU re-check
    await run();

    // Never refuses on this by itself.
    expect(updateCustomers).toHaveBeenCalledTimes(1);

    const infoBlock = logger.info.mock.calls.find((c) =>
      String(c[0]).includes('all live holders'),
    );
    expect(infoBlock?.[0]).toContain('3');

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(String(logger.warn.mock.calls[0][0])).toContain('has_account:false');

    const summary = findSummary();
    expect(summary).toContain('DONE'); // the release itself still succeeded
    expect(summary).toContain('has_account:false');
  });

  // Fix for the TOCTOU window (docblock): the re-check runs immediately
  // before the write and must abort — with NO write of any kind — if the
  // other-holder count that made the release legal has since dropped to
  // zero.
  it('TOCTOU re-check: other-holder count drops to zero right before the write, aborts with no write', async () => {
    process.env.RELEASE_CUSTOMER_ID = 'cus_1';
    process.env.RELEASE_REASON = 'dup phone cleanup';
    process.env.CONFIRM_RELEASE = 'cus_1';
    listAndCountCustomers
      .mockReset()
      .mockResolvedValueOnce([[{ id: 'cus_1' }, { id: 'cus_2' }], 2]) // guard: passes, 1 other holder
      .mockResolvedValueOnce([[{ id: 'cus_1' }, { id: 'cus_2' }], 2]) // unfiltered: no extra
      .mockResolvedValueOnce([[{ id: 'cus_1' }], 1]); // TOCTOU re-check: the other holder is gone
    await run();
    expect(
      logger.error.mock.calls.some((c) => String(c[0]).includes('REFUSED')),
    ).toBe(true);
    expect(updateCustomers).not.toHaveBeenCalled();
    expect(updateCustomerAccountStates).not.toHaveBeenCalled();
    expect(createAdminActionAudits).not.toHaveBeenCalled();
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
