// delete/route.ts imports deleteFilesWorkflow at MODULE scope, which pulls the
// whole core-flows barrel into a unit run. Mocked, per the repo's precedent at
// admin/media/__tests__/bake-slab-rebake.unit.spec.ts:23. The run handle is
// hoisted out so the avatar assertion below can read it — jest allows a
// factory to close over a variable whose name starts with `mock`.
const mockRunWorkflow = jest.fn().mockResolvedValue({});
jest.mock('@medusajs/medusa/core-flows', () => ({
  deleteFilesWorkflow: jest.fn(() => ({ run: mockRunWorkflow })),
}));

import { POST as disablePOST } from '../disable/route';
import { POST as reactivatePOST } from '../reactivate/route';
import { POST as deletePOST } from '../delete/route';
import { GET as accountGET } from '../account/route';

const setAccountDisabled = jest.fn();
const accountDisabledCause = jest.fn();

const scope = {
  resolve: jest.fn(() => ({ setAccountDisabled, accountDisabledCause })),
};

const mkRes = () => {
  const res = { json: jest.fn(), status: jest.fn(), setHeader: jest.fn() };
  res.status.mockReturnValue(res);
  return res as never;
};

const mkReq = (actorId = 'cus_1') =>
  ({ auth_context: { actor_id: actorId }, body: null, scope }) as never;

beforeEach(() => {
  setAccountDisabled.mockReset().mockResolvedValue({ disabled: true });
  // Default: not disabled. Both routes now read the cause before writing, so a
  // bare mock returning undefined would trip their fail-closed branch.
  accountDisabledCause.mockReset().mockResolvedValue(null);
});

describe('POST /store/customers/me/disable', () => {
  it('self-disables with cause=self and the customer as actor', async () => {
    const res = mkRes();
    await disablePOST(mkReq(), res);
    expect(setAccountDisabled).toHaveBeenCalledWith({
      customerId: 'cus_1',
      adminId: 'cus_1',
      disabled: true,
      reason: 'Customer disabled their own account.',
      cause: 'self',
    });
    expect((res as { json: jest.Mock }).json).toHaveBeenCalledWith({
      disabled: true,
    });
  });

  it('401s a register-phase token (empty actor_id) before writing', async () => {
    await expect(disablePOST(mkReq(''), mkRes())).rejects.toThrow(
      /unauthorized/i,
    );
    expect(setAccountDisabled).not.toHaveBeenCalled();
  });

  // Defence in depth: unreachable while the session guard stands, but the write
  // stamps cause='self' unconditionally, so reaching it with an admin ban would
  // launder that ban into a self-liftable one. Grant only on null or 'self'.
  it('refuses an unexpected disable cause without writing', async () => {
    accountDisabledCause.mockResolvedValue('suspended');
    await expect(disablePOST(mkReq(), mkRes())).rejects.toThrow(
      /has been disabled/i,
    );
    expect(setAccountDisabled).not.toHaveBeenCalled();
  });
});

describe('POST /store/customers/me/reactivate', () => {
  it('reactivates a self-disabled account', async () => {
    accountDisabledCause.mockResolvedValue('self');
    setAccountDisabled.mockResolvedValue({ disabled: false });
    const res = mkRes();
    await reactivatePOST(mkReq(), res);
    expect(setAccountDisabled).toHaveBeenCalledWith({
      customerId: 'cus_1',
      adminId: 'cus_1',
      disabled: false,
      reason: 'Customer reactivated their own account.',
      cause: 'self',
    });
    expect((res as { json: jest.Mock }).json).toHaveBeenCalledWith({
      disabled: false,
    });
  });

  // The guard already blocks an admin-disabled session before this route runs;
  // this asserts the route refuses on its own too, so correctness does not
  // depend on middleware ordering.
  it('403s an admin-disabled account without writing', async () => {
    accountDisabledCause.mockResolvedValue('admin');
    await expect(reactivatePOST(mkReq(), mkRes())).rejects.toThrow(
      /has been disabled/i,
    );
    expect(setAccountDisabled).not.toHaveBeenCalled();
  });

  it('is a no-op success when the account is not disabled', async () => {
    accountDisabledCause.mockResolvedValue(null);
    const res = mkRes();
    await reactivatePOST(mkReq(), res);
    expect(setAccountDisabled).not.toHaveBeenCalled();
    expect((res as { json: jest.Mock }).json).toHaveBeenCalledWith({
      disabled: false,
    });
  });

  // The fail-OPEN regression test. Denying on `=== 'admin'` would let any
  // unexpected third cause (a future value, a bad write, a rolling-deploy
  // race) fall through to the reactivate write; granting only on an explicit
  // 'self' refuses it instead.
  it('refuses an unexpected cause instead of reactivating', async () => {
    accountDisabledCause.mockResolvedValue('suspended');
    await expect(reactivatePOST(mkReq(), mkRes())).rejects.toThrow(
      /has been disabled/i,
    );
    expect(setAccountDisabled).not.toHaveBeenCalled();
  });
});

const listAuthIdentities = jest.fn();
const deleteAuthIdentities = jest.fn();
// Exposed on the fake auth module ONLY so the spec can prove the route never
// reaches for it. Nothing in the route should ever call this.
const softDeleteAuthIdentities = jest.fn();
const authenticate = jest.fn();
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

const deleteScope = {
  resolve: jest.fn((key: string) => {
    if (key === 'packs')
      return {
        deleteAccountPreflight,
        purgeAccountPacksData,
        mutateCustomerMetadata,
        // The account route reads this to tell login whether to offer
        // reactivation. Defaulted per-test in the account describe below.
        accountDisabledCause,
      };
    if (key === 'auth')
      return {
        listAuthIdentities,
        deleteAuthIdentities,
        softDeleteAuthIdentities,
        authenticate,
      };
    if (key === 'notification') return { listNotifications, deleteNotifications };
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

const mkDeleteReq = (body: Record<string, unknown> | null = null) =>
  ({
    auth_context: { actor_id: 'cus_1' },
    body,
    scope: deleteScope,
  }) as never;

const withEmailpass = () =>
  listAuthIdentities.mockResolvedValue([
    {
      id: 'authid_1',
      provider_identities: [{ provider: 'emailpass', entity_id: 'a@b.dev' }],
    },
  ]);

describe('POST /store/customers/me/delete', () => {
  beforeEach(() => {
    mockRunWorkflow.mockClear();
    listAuthIdentities.mockReset();
    deleteAuthIdentities.mockReset().mockResolvedValue(undefined);
    softDeleteAuthIdentities.mockReset().mockResolvedValue(undefined);
    authenticate.mockReset().mockResolvedValue({ success: true });
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

  // Not in the brief, and the most expensive thing in this file to get wrong: a
  // register-phase token carries actor_id '' (see MEMORY: medusa-register-token
  // -empty-actor-id). Falling through with it would purge whatever customer ''
  // resolved to. Pinned the same way the disable route pins it.
  it('401s a register-phase token (empty actor_id) before reading anything', async () => {
    const req = {
      auth_context: { actor_id: '' },
      body: { password: 'right' },
      scope: deleteScope,
    } as never;
    await expect(deletePOST(req, mkRes())).rejects.toThrow(/unauthorized/i);
    expect(listAuthIdentities).not.toHaveBeenCalled();
    expect(purgeAccountPacksData).not.toHaveBeenCalled();
    expect(softDeleteCustomers).not.toHaveBeenCalled();
  });

  it('requires a password when the account has one', async () => {
    withEmailpass();
    await expect(deletePOST(mkDeleteReq({}), mkRes())).rejects.toThrow(
      /PASSWORD_REQUIRED/,
    );
    expect(purgeAccountPacksData).not.toHaveBeenCalled();
  });

  it('refuses a wrong password before touching any data', async () => {
    withEmailpass();
    authenticate.mockResolvedValue({ success: false });
    await expect(
      deletePOST(mkDeleteReq({ password: 'nope' }), mkRes()),
    ).rejects.toThrow(/PASSWORD_INCORRECT/);
    expect(deleteAccountPreflight).not.toHaveBeenCalled();
    expect(purgeAccountPacksData).not.toHaveBeenCalled();
  });

  // The reason code has to survive as the error MESSAGE, because that is the
  // only field the framework's error handler serialises — the storefront
  // matches on it.
  it('surfaces the preflight reason and purges nothing', async () => {
    withEmailpass();
    deleteAccountPreflight.mockResolvedValue({
      ok: false,
      reason: 'BALANCE_NOT_ZERO',
      detail: 'Wallet balance is RM 12.50.',
    });
    await expect(
      deletePOST(mkDeleteReq({ password: 'right' }), mkRes()),
    ).rejects.toThrow(/BALANCE_NOT_ZERO/);
    expect(purgeAccountPacksData).not.toHaveBeenCalled();
    expect(deleteAuthIdentities).not.toHaveBeenCalled();
  });

  it('skips the password step for a Google-only account', async () => {
    listAuthIdentities.mockResolvedValue([
      { id: 'authid_g', provider_identities: [{ provider: 'google' }] },
    ]);
    const res = mkRes();
    await deletePOST(mkDeleteReq({}), res);
    expect(authenticate).not.toHaveBeenCalled();
    expect((res as { json: jest.Mock }).json).toHaveBeenCalledWith({
      deleted: true,
    });
  });

  // Ordering IS the retry story, so it gets pinned rather than left to the
  // reader. Everything that can still fail runs while the row is live and
  // loginable; the soft delete — which would make a re-run impossible, because
  // mutateCustomerMetadata cannot see a soft-deleted row — goes last.
  it('soft-deletes the customer only after every step that can fail', async () => {
    withEmailpass();
    await deletePOST(mkDeleteReq({ password: 'right' }), mkRes());
    const softDelete = softDeleteCustomers.mock.invocationCallOrder[0];
    expect(purgeAccountPacksData.mock.invocationCallOrder[0]).toBeLessThan(
      softDelete,
    );
    expect(mutateCustomerMetadata.mock.invocationCallOrder[0]).toBeLessThan(
      softDelete,
    );
    expect(updateCustomers.mock.invocationCallOrder[0]).toBeLessThan(softDelete);
    expect(deleteAuthIdentities.mock.invocationCallOrder[0]).toBeLessThan(
      softDelete,
    );
  });

  it('clears the metadata blob while the row is still live', async () => {
    withEmailpass();
    await deletePOST(mkDeleteReq({ password: 'right' }), mkRes());
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
    withEmailpass();
    await deletePOST(mkDeleteReq({ password: 'right' }), mkRes());
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
    withEmailpass();
    await deletePOST(mkDeleteReq({ password: 'right' }), mkRes());
    expect(deleteAuthIdentities).toHaveBeenCalledWith(['authid_1']);
    expect(softDeleteAuthIdentities).not.toHaveBeenCalled();
  });

  // notification rows are keyed by EMAIL for the email channel and by
  // CUSTOMER_ID for the in-app feed (notify-feed.ts:39), and `to` holds each
  // verbatim — so both are personal data in their own right, and both have to
  // go before the scrub above overwrites the address that finds the email half.
  it('deletes the notification rows addressed to the customer, before the email scrub', async () => {
    withEmailpass();
    listNotifications.mockResolvedValue([{ id: 'noti_1' }, { id: 'noti_2' }]);
    await deletePOST(mkDeleteReq({ password: 'right' }), mkRes());
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
    withEmailpass();
    mutateCustomerMetadata.mockImplementation(async ({ mutate }) =>
      mutate({ avatar_file_id: 'file_1', handle: 'x' }),
    );
    await deletePOST(mkDeleteReq({ password: 'right' }), mkRes());
    expect(mockRunWorkflow).toHaveBeenCalledWith({
      input: { ids: ['file_1'] },
    });
  });

  it('does not call the file workflow when there is no avatar', async () => {
    withEmailpass();
    await deletePOST(mkDeleteReq({ password: 'right' }), mkRes());
    expect(mockRunWorkflow).not.toHaveBeenCalled();
  });
});

describe('GET /store/customers/me/account', () => {
  beforeEach(() => {
    listAuthIdentities.mockReset();
    accountDisabledCause.mockReset().mockResolvedValue(null);
  });

  it('reports hasPassword true for an emailpass account', async () => {
    withEmailpass();
    const res = mkRes();
    await accountGET(mkDeleteReq(), res);
    expect((res as { json: jest.Mock }).json).toHaveBeenCalledWith({
      hasPassword: true,
      disabledCause: null,
    });
  });

  it('reports hasPassword false for a Google-only account', async () => {
    listAuthIdentities.mockResolvedValue([
      { id: 'authid_g', provider_identities: [{ provider: 'google' }] },
    ]);
    const res = mkRes();
    await accountGET(mkDeleteReq(), res);
    expect((res as { json: jest.Mock }).json).toHaveBeenCalledWith({
      hasPassword: false,
      disabledCause: null,
    });
  });

  // The field login reads to decide whether to offer reactivation. Asserted on
  // the RESPONSE, not on a rejection: the previous plan for this feature watched
  // for an ACCOUNT_SELF_DISABLED throw on the login path, and that throw stopped
  // happening when GET /store/customers/me entered the guard's carve-out — with
  // every mocked test still green, because the test fabricated the rejection.
  it('reports the disable cause verbatim, so login can offer reactivation', async () => {
    withEmailpass();
    accountDisabledCause.mockResolvedValue('self');
    const res = mkRes();
    await accountGET(mkDeleteReq(), res);
    expect((res as { json: jest.Mock }).json).toHaveBeenCalledWith({
      hasPassword: true,
      disabledCause: 'self',
    });
    expect(accountDisabledCause).toHaveBeenCalledWith('cus_1');
  });

  // Passed through rather than collapsed to a boolean. An admin-disabled session
  // cannot reach this route today (the guard's admin branch is total), but the
  // storefront must key on 'self' explicitly — never on "it answered at all".
  it('does not disguise an admin disable as a self disable', async () => {
    withEmailpass();
    accountDisabledCause.mockResolvedValue('admin');
    const res = mkRes();
    await accountGET(mkDeleteReq(), res);
    expect((res as { json: jest.Mock }).json).toHaveBeenCalledWith({
      hasPassword: true,
      disabledCause: 'admin',
    });
  });
});
