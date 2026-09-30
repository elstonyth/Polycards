import { POST } from '../route';
import { GOOGLE_LINKED_TEMPLATE } from '../../../../../modules/resend/templates';

const mkRes = () => {
  const res = { json: jest.fn(), status: jest.fn(), setHeader: jest.fn() };
  res.status.mockReturnValue(res);
  return res as never;
};

const retrieveAuthIdentity = jest.fn();
const updateAuthIdentities = jest.fn();
const listAuthIdentities = jest.fn();
const deleteAuthIdentities = jest.fn();
const listCustomers = jest.fn();
const createNotifications = jest.fn();
const warn = jest.fn();

const scope = {
  resolve: jest.fn((key: string) => {
    if (key === 'auth')
      return {
        retrieveAuthIdentity,
        updateAuthIdentities,
        listAuthIdentities,
        deleteAuthIdentities,
      };
    if (key === 'customer') return { listCustomers };
    if (key === 'notification') return { createNotifications };
    if (key === 'logger') return { warn };
    throw new Error(`unexpected resolve(${key})`);
  }),
};

/** The account's own password login: an emailpass identity linked to it. */
const passwordLogin = (email: string) => ({
  id: 'authid_e',
  app_metadata: { customer_id: 'cus_old' },
  provider_identities: [{ provider: 'emailpass', entity_id: email }],
});

const mkReq = (auth_context: Record<string, unknown>) =>
  ({ auth_context, scope }) as never;

/** A register-phase Google token: identity exists, no actor attached yet. */
const registerReq = () =>
  mkReq({ actor_id: '', auth_identity_id: 'authid_g' });

const googleIdentity = (email: string | undefined, app_metadata = {}) => ({
  id: 'authid_g',
  app_metadata,
  provider_identities: [
    { provider: 'google', entity_id: 'sub-1', user_metadata: { email } },
  ],
});

describe('POST /store/customers/link-google', () => {
  const ORIGINAL_ENV = {
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    RESEND_FROM_EMAIL: process.env.RESEND_FROM_EMAIL,
  };

  beforeEach(() => {
    retrieveAuthIdentity.mockReset();
    updateAuthIdentities.mockReset().mockResolvedValue([]);
    listAuthIdentities.mockReset().mockResolvedValue([]);
    deleteAuthIdentities.mockReset().mockResolvedValue(undefined);
    listCustomers.mockReset().mockResolvedValue([]);
    createNotifications.mockReset().mockResolvedValue([]);
    warn.mockReset();
    // The notice is skipped unless Resend is configured.
    process.env.RESEND_API_KEY = 'test-key';
    process.env.RESEND_FROM_EMAIL = 'no-reply@test.dev';
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('refuses a token that already carries a customer', async () => {
    await expect(
      POST(mkReq({ actor_id: 'cus_1', auth_identity_id: 'authid_g' }), mkRes()),
    ).rejects.toMatchObject({ type: 'invalid_data' });
    expect(retrieveAuthIdentity).not.toHaveBeenCalled();
  });

  it('401s with no auth identity at all', async () => {
    await expect(POST(mkReq({}), mkRes())).rejects.toMatchObject({
      type: 'unauthorized',
    });
  });

  // An emailpass register token proves nothing about the email (signup never
  // verifies it), so it must not be able to claim an existing account.
  it('refuses an identity with no Google provider', async () => {
    retrieveAuthIdentity.mockResolvedValue({
      id: 'authid_e',
      app_metadata: {},
      provider_identities: [{ provider: 'emailpass', entity_id: 'a@b.dev' }],
    });
    await expect(POST(registerReq(), mkRes())).rejects.toMatchObject({
      type: 'not_allowed',
    });
    expect(listCustomers).not.toHaveBeenCalled();
    expect(updateAuthIdentities).not.toHaveBeenCalled();
  });

  it('404s when no registered account holds the email', async () => {
    retrieveAuthIdentity.mockResolvedValue(googleIdentity('a@b.dev'));
    await expect(POST(registerReq(), mkRes())).rejects.toMatchObject({
      type: 'not_found',
    });
    // has_account: a guest row (no account) is not something to log into.
    expect(listCustomers).toHaveBeenCalledWith(
      { email: 'a@b.dev', has_account: true },
      expect.anything(),
    );
    expect(updateAuthIdentities).not.toHaveBeenCalled();
  });

  it('attaches the Google identity to the existing account (email normalized, app_metadata merged)', async () => {
    retrieveAuthIdentity.mockResolvedValue(
      googleIdentity(' MiXeD@Example.COM ', { keep: 'me' }),
    );
    listCustomers.mockResolvedValue([{ id: 'cus_old' }]);
    const res = mkRes();

    await POST(registerReq(), res);

    expect(listCustomers).toHaveBeenCalledWith(
      { email: 'mixed@example.com', has_account: true },
      expect.anything(),
    );
    // Same shape as core's setAuthAppMetadataStep: the whole map, merged.
    expect(updateAuthIdentities).toHaveBeenCalledWith({
      id: 'authid_g',
      app_metadata: { keep: 'me', customer_id: 'cus_old' },
    });
    expect((res as { json: jest.Mock }).json).toHaveBeenCalledWith({
      customer_id: 'cus_old',
    });
    // No password login on the account: nothing to revoke, nothing to say.
    expect(deleteAuthIdentities).not.toHaveBeenCalled();
    expect(createNotifications).not.toHaveBeenCalled();
  });

  // The account pre-hijack: anyone can register a victim's email with their
  // own password (signup never verifies the email). Google proves the email,
  // so once it links, the password login it did not prove goes — BEFORE the
  // link, so a failed revoke is retried on the next sign-in instead of the
  // link sticking with the password still live (an already-linked Google
  // identity never comes back through this route).
  it('revokes the account password login before linking, then emails the owner', async () => {
    retrieveAuthIdentity.mockResolvedValue(googleIdentity('owner@test.dev'));
    listCustomers.mockResolvedValue([{ id: 'cus_old' }]);
    listAuthIdentities.mockResolvedValue([passwordLogin('owner@test.dev')]);

    await POST(registerReq(), mkRes());

    expect(listAuthIdentities).toHaveBeenCalledWith(
      { app_metadata: { customer_id: 'cus_old' } },
      { relations: ['provider_identities'] },
    );
    expect(deleteAuthIdentities).toHaveBeenCalledWith(['authid_e']);
    expect(deleteAuthIdentities.mock.invocationCallOrder[0]).toBeLessThan(
      updateAuthIdentities.mock.invocationCallOrder[0],
    );
    expect(createNotifications).toHaveBeenCalledWith({
      to: 'owner@test.dev',
      channel: 'email',
      template: GOOGLE_LINKED_TEMPLATE,
      data: {},
    });
  });

  it('never deletes an identity that also carries a Google login', async () => {
    retrieveAuthIdentity.mockResolvedValue(googleIdentity('owner@test.dev'));
    listCustomers.mockResolvedValue([{ id: 'cus_old' }]);
    listAuthIdentities.mockResolvedValue([
      {
        id: 'authid_mixed',
        app_metadata: { customer_id: 'cus_old' },
        provider_identities: [
          { provider: 'emailpass', entity_id: 'owner@test.dev' },
          { provider: 'google', entity_id: 'sub-9' },
        ],
      },
    ]);

    await POST(registerReq(), mkRes());

    expect(deleteAuthIdentities).not.toHaveBeenCalled();
  });

  it('links nothing when the revoke fails, so the next sign-in retries both', async () => {
    retrieveAuthIdentity.mockResolvedValue(googleIdentity('owner@test.dev'));
    listCustomers.mockResolvedValue([{ id: 'cus_old' }]);
    listAuthIdentities.mockResolvedValue([passwordLogin('owner@test.dev')]);
    deleteAuthIdentities.mockRejectedValue(new Error('db down'));

    await expect(POST(registerReq(), mkRes())).rejects.toThrow('db down');
    expect(updateAuthIdentities).not.toHaveBeenCalled();
  });

  it('still links when only the notice fails', async () => {
    retrieveAuthIdentity.mockResolvedValue(googleIdentity('owner@test.dev'));
    listCustomers.mockResolvedValue([{ id: 'cus_old' }]);
    listAuthIdentities.mockResolvedValue([passwordLogin('owner@test.dev')]);
    createNotifications.mockRejectedValue(
      new Error('resend down: failed to deliver to owner@test.dev'),
    );
    const res = mkRes();

    await POST(registerReq(), res);

    expect(updateAuthIdentities).toHaveBeenCalled();
    expect((res as { json: jest.Mock }).json).toHaveBeenCalledWith({
      customer_id: 'cus_old',
    });
    // PII: the warn names the customer, never the address.
    expect(String(warn.mock.calls[0][0])).toContain('cus_old');
    expect(String(warn.mock.calls[0][0])).not.toContain('owner@test.dev');
  });
});
