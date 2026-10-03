// account-deletion.ts imports deleteFilesWorkflow at MODULE scope, which pulls
// the whole core-flows barrel into a unit run. Mocked, per the repo's precedent
// at admin/media/__tests__/bake-slab-rebake.unit.spec.ts:23. The run handle is
// hoisted out so the avatar assertion below can read it — jest allows a
// factory to close over a variable whose name starts with `mock`.
const mockRunWorkflow = jest.fn().mockResolvedValue({});
jest.mock('@medusajs/medusa/core-flows', () => ({
  deleteFilesWorkflow: jest.fn(() => ({ run: mockRunWorkflow })),
}));

import { purgeAndDeleteAccount } from '../account-deletion';

const listAuthIdentities = jest.fn();
const deleteAuthIdentities = jest.fn();
// Exposed on the fake auth module ONLY so the spec can prove the purge never
// reaches for it. Nothing in the purge should ever call this.
const softDeleteAuthIdentities = jest.fn();
const deleteAccountPreflight = jest.fn();
const purgeAccountPacksData = jest.fn();
const mutateCustomerMetadata = jest.fn();
const retrieveCustomer = jest.fn();
const listCustomerAddresses = jest.fn();
const deleteCustomerAddresses = jest.fn();
const updateCustomers = jest.fn();
const softDeleteCustomers = jest.fn();
const listNotifications = jest.fn();
const deleteNotifications = jest.fn();

const scope = {
  resolve: jest.fn((key: string) => {
    if (key === 'packs')
      return {
        deleteAccountPreflight,
        purgeAccountPacksData,
        mutateCustomerMetadata,
      };
    if (key === 'auth')
      return {
        listAuthIdentities,
        deleteAuthIdentities,
        softDeleteAuthIdentities,
      };
    if (key === 'notification')
      return { listNotifications, deleteNotifications };
    if (key === 'logger')
      return { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    return {
      retrieveCustomer,
      listCustomerAddresses,
      deleteCustomerAddresses,
      updateCustomers,
      softDeleteCustomers,
    };
  }),
};

const purge = () => purgeAndDeleteAccount(scope as never, 'cus_1');

describe('purgeAndDeleteAccount', () => {
  beforeEach(() => {
    mockRunWorkflow.mockClear();
    listAuthIdentities.mockReset().mockResolvedValue([{ id: 'authid_1' }]);
    deleteAuthIdentities.mockReset().mockResolvedValue(undefined);
    softDeleteAuthIdentities.mockReset().mockResolvedValue(undefined);
    deleteAccountPreflight.mockReset().mockResolvedValue({ ok: true });
    purgeAccountPacksData.mockReset().mockResolvedValue(undefined);
    mutateCustomerMetadata
      .mockReset()
      .mockImplementation(async ({ mutate }) => mutate({}));
    retrieveCustomer.mockReset().mockResolvedValue({
      id: 'cus_1',
      email: 'a@b.dev',
    });
    listCustomerAddresses.mockReset().mockResolvedValue([]);
    deleteCustomerAddresses.mockReset().mockResolvedValue(undefined);
    updateCustomers.mockReset().mockResolvedValue({});
    softDeleteCustomers.mockReset().mockResolvedValue(undefined);
    listNotifications.mockReset().mockResolvedValue([]);
    deleteNotifications.mockReset().mockResolvedValue(undefined);
  });

  // A refusal is RETURNED, not thrown — the operator script prints the reason
  // and its numbers and exits non-zero — and it must leave everything as it
  // was.
  it('returns the preflight refusal and purges nothing', async () => {
    deleteAccountPreflight.mockResolvedValue({
      ok: false,
      reason: 'BALANCE_NOT_ZERO',
      detail: 'Wallet balance is RM 12.50.',
    });
    await expect(purge()).resolves.toEqual({
      ok: false,
      reason: 'BALANCE_NOT_ZERO',
      detail: 'Wallet balance is RM 12.50.',
    });
    expect(purgeAccountPacksData).not.toHaveBeenCalled();
    expect(deleteAuthIdentities).not.toHaveBeenCalled();
    expect(softDeleteCustomers).not.toHaveBeenCalled();
  });

  // Ordering IS the retry story, so it gets pinned rather than left to the
  // reader. Everything that can still fail runs while the row is live and
  // loginable; the soft delete — which would make a re-run impossible, because
  // mutateCustomerMetadata cannot see a soft-deleted row — goes last.
  it('soft-deletes the customer only after every step that can fail', async () => {
    await expect(purge()).resolves.toEqual({ ok: true });
    const softDelete = softDeleteCustomers.mock.invocationCallOrder[0];
    expect(purgeAccountPacksData.mock.invocationCallOrder[0]).toBeLessThan(
      softDelete,
    );
    expect(mutateCustomerMetadata.mock.invocationCallOrder[0]).toBeLessThan(
      softDelete,
    );
    expect(updateCustomers.mock.invocationCallOrder[0]).toBeLessThan(
      softDelete,
    );
    expect(deleteAuthIdentities.mock.invocationCallOrder[0]).toBeLessThan(
      softDelete,
    );
  });

  it('clears the metadata blob while the row is still live', async () => {
    await purge();
    expect(mutateCustomerMetadata.mock.invocationCallOrder[0]).toBeLessThan(
      softDeleteCustomers.mock.invocationCallOrder[0],
    );
    // The mutator must return an EMPTY blob — bank accounts, handle, avatar
    // and frame all live in it.
    const { mutate } = mutateCustomerMetadata.mock.calls[0][0];
    expect(mutate({ bank_accounts: [{}], handle: 'x' })).toEqual({});
  });

  // company_name is in the live schema and Medusa's stock store validators
  // accept it on both create and update — rejectCustomerMetadata only guards
  // `metadata` — so it is reachable, and it names the person.
  it('scrubs the email to the tombstone address', async () => {
    await purge();
    expect(updateCustomers).toHaveBeenCalledWith('cus_1', {
      email: 'deleted_cus_1@removed.invalid',
      first_name: null,
      last_name: null,
      phone: null,
      company_name: null,
    });
  });

  // The one invariant here whose violation is PERMANENTLY unrecoverable. A soft
  // delete leaves the (entity_id, provider) slot occupied — that index carries
  // no deleted_at predicate — so the person could never sign up with their own
  // email again. Both halves are asserted: a future "consistency" refactor to
  // softDeleteAuthIdentities would otherwise pass every other test in this file.
  it('HARD-deletes the auth identities, by id, and never soft-deletes them', async () => {
    await purge();
    expect(deleteAuthIdentities).toHaveBeenCalledWith(['authid_1']);
    expect(softDeleteAuthIdentities).not.toHaveBeenCalled();
  });

  // notification rows are keyed by EMAIL for the email channel and by
  // CUSTOMER_ID for the in-app feed (notify-feed.ts:39), and `to` holds each
  // verbatim — so both are personal data in their own right, and both have to
  // go before the scrub above overwrites the address that finds the email half.
  it('deletes the notification rows addressed to the customer, before the email scrub', async () => {
    listNotifications.mockResolvedValue([{ id: 'noti_1' }, { id: 'noti_2' }]);
    await purge();
    expect(listNotifications).toHaveBeenCalledWith({
      to: ['a@b.dev', 'cus_1'],
    });
    expect(deleteNotifications).toHaveBeenCalledWith(['noti_1', 'noti_2']);
    expect(deleteNotifications.mock.invocationCallOrder[0]).toBeLessThan(
      updateCustomers.mock.invocationCallOrder[0],
    );
  });

  // The avatar id is read inside the SAME callback that empties the blob, so
  // it has to be captured out of it — on a retry the blob is already {} and
  // the Spaces object would never be deleted at all.
  it('deletes the avatar object with the id captured from the blob', async () => {
    mutateCustomerMetadata.mockImplementation(async ({ mutate }) =>
      mutate({ avatar_file_id: 'file_1', handle: 'x' }),
    );
    await purge();
    expect(mockRunWorkflow).toHaveBeenCalledWith({
      input: { ids: ['file_1'] },
    });
  });

  it('does not call the file workflow when there is no avatar', async () => {
    await purge();
    expect(mockRunWorkflow).not.toHaveBeenCalled();
  });
});
