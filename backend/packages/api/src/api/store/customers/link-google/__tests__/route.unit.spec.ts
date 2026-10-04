import { POST } from '../route';
import { GOOGLE_LINKED_TEMPLATE } from '../../../../../modules/resend/templates';

const mkRes = () => {
  const res = { json: jest.fn(), status: jest.fn(), setHeader: jest.fn() };
  res.status.mockReturnValue(res);
  return res as never;
};

type Identity = {
  id: string;
  app_metadata: { customer_id?: string };
  provider_identities: { id: string; provider: string; entity_id: string }[];
};
// Per-test: every auth identity the filter-aware list below can see.
let identities: Identity[];

const retrieveAuthIdentity = jest.fn();
const updateAuthIdentities = jest.fn();
// Filter-aware like the real query: only identities LINKED to the customer.
const listAuthIdentities = jest.fn(
  async (filter: { app_metadata?: { customer_id?: string } }) =>
    identities.filter(
      (i) => i.app_metadata.customer_id === filter.app_metadata?.customer_id,
    ),
);
const deleteAuthIdentities = jest.fn();
const deleteProviderIdentities = jest.fn();
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
        deleteProviderIdentities,
      };
    if (key === 'customer') return { listCustomers };
    if (key === 'notification') return { createNotifications };
    if (key === 'logger') return { warn };
    throw new Error(`unexpected resolve(${key})`);
  }),
};

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

/** The password login core's emailpass register leaves on an account: an
 *  auth identity of its own, holding that one provider identity. */
const passwordLogin = (): Identity => ({
  id: 'authid_e',
  app_metadata: { customer_id: 'cus_old' },
  provider_identities: [
    { id: 'provid_e', provider: 'emailpass', entity_id: 'a@b.dev' },
  ],
});

const ORIGINAL_ENV = {
  RESEND_API_KEY: process.env.RESEND_API_KEY,
  RESEND_FROM_EMAIL: process.env.RESEND_FROM_EMAIL,
};

describe('POST /store/customers/link-google', () => {
  beforeEach(() => {
    identities = [];
    retrieveAuthIdentity.mockReset();
    updateAuthIdentities.mockReset().mockResolvedValue([]);
    listAuthIdentities.mockClear();
    deleteAuthIdentities.mockReset().mockResolvedValue(undefined);
    deleteProviderIdentities.mockReset().mockResolvedValue(undefined);
    listCustomers.mockReset().mockResolvedValue([]);
    createNotifications.mockReset().mockResolvedValue([]);
    warn.mockReset();
    // The route skips the notice entirely unless Resend is configured, so the
    // notice cases would assert nothing without these.
    process.env.RESEND_API_KEY = 'test-key';
    process.env.RESEND_FROM_EMAIL = 'no-reply@test.dev';
  });

  // Process-wide: leaving them set leaks into whatever runs next.
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
    // No password login on this account: nothing to remove, nothing to tell.
    expect(deleteAuthIdentities).not.toHaveBeenCalled();
    expect(deleteProviderIdentities).not.toHaveBeenCalled();
    expect(createNotifications).not.toHaveBeenCalled();
  });

  describe('an account with a password login', () => {
    beforeEach(() => {
      retrieveAuthIdentity.mockResolvedValue(googleIdentity('a@b.dev'));
      listCustomers.mockResolvedValue([{ id: 'cus_old' }]);
      identities = [passwordLogin()];
    });

    it('removes the password login, then links Google, then emails the account', async () => {
      const res = mkRes();

      await POST(registerReq(), res);

      // The identity holds nothing but the password, so it goes whole.
      expect(deleteAuthIdentities).toHaveBeenCalledWith(['authid_e']);
      expect(deleteProviderIdentities).not.toHaveBeenCalled();
      expect(updateAuthIdentities).toHaveBeenCalledWith({
        id: 'authid_g',
        app_metadata: { customer_id: 'cus_old' },
      });
      // Removed BEFORE the link: see the route for why the order matters.
      expect(deleteAuthIdentities.mock.invocationCallOrder[0]).toBeLessThan(
        updateAuthIdentities.mock.invocationCallOrder[0],
      );
      expect(createNotifications).toHaveBeenCalledWith({
        to: 'a@b.dev',
        channel: 'email',
        template: GOOGLE_LINKED_TEMPLATE,
      });
      expect((res as { json: jest.Mock }).json).toHaveBeenCalledWith({
        customer_id: 'cus_old',
      });
    });

    it('removes only the emailpass provider identity when its auth identity also holds another login', async () => {
      identities = [
        {
          id: 'authid_m',
          app_metadata: { customer_id: 'cus_old' },
          provider_identities: [
            { id: 'provid_g2', provider: 'google', entity_id: 'sub-2' },
            { id: 'provid_e', provider: 'emailpass', entity_id: 'a@b.dev' },
          ],
        },
      ];

      await POST(registerReq(), mkRes());

      expect(deleteProviderIdentities).toHaveBeenCalledWith(['provid_e']);
      expect(deleteAuthIdentities).not.toHaveBeenCalled();
      expect(updateAuthIdentities).toHaveBeenCalled();
    });

    // An emailpass identity nobody is linked to signs into nothing (see
    // utils/linked-login.ts) — it is not this account's password.
    it('leaves an unlinked emailpass identity with the same email alone', async () => {
      identities = [{ ...passwordLogin(), app_metadata: {} }];

      await POST(registerReq(), mkRes());

      expect(deleteAuthIdentities).not.toHaveBeenCalled();
      expect(deleteProviderIdentities).not.toHaveBeenCalled();
      expect(createNotifications).not.toHaveBeenCalled();
      expect(updateAuthIdentities).toHaveBeenCalled();
    });

    it('still links and answers when the notice email fails, and logs only the customer id', async () => {
      // A provider names the failed recipient in its error text.
      createNotifications.mockRejectedValueOnce(
        new Error('Resend refused the send to a@b.dev'),
      );
      const res = mkRes();

      await POST(registerReq(), res);

      expect(updateAuthIdentities).toHaveBeenCalled();
      expect((res as { json: jest.Mock }).json).toHaveBeenCalledWith({
        customer_id: 'cus_old',
      });
      expect(warn).toHaveBeenCalledTimes(1);
      const logged = String(warn.mock.calls[0][0]);
      expect(logged).toContain('cus_old');
      expect(logged).not.toContain('a@b.dev');
    });

    it('fails without linking when the password login cannot be removed, so a retry starts over', async () => {
      deleteAuthIdentities.mockRejectedValueOnce(new Error('db down'));
      const res = mkRes();

      await expect(POST(registerReq(), res)).rejects.toThrow('db down');

      expect(updateAuthIdentities).not.toHaveBeenCalled();
      expect(createNotifications).not.toHaveBeenCalled();
      expect((res as { json: jest.Mock }).json).not.toHaveBeenCalled();
    });
  });
});
