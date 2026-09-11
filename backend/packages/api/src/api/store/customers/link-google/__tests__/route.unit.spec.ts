import { POST } from '../route';

const mkRes = () => {
  const res = { json: jest.fn(), status: jest.fn(), setHeader: jest.fn() };
  res.status.mockReturnValue(res);
  return res as never;
};

const retrieveAuthIdentity = jest.fn();
const updateAuthIdentities = jest.fn();
const listCustomers = jest.fn();

const scope = {
  resolve: jest.fn((key: string) => {
    if (key === 'auth') return { retrieveAuthIdentity, updateAuthIdentities };
    if (key === 'customer') return { listCustomers };
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

describe('POST /store/customers/link-google', () => {
  beforeEach(() => {
    retrieveAuthIdentity.mockReset();
    updateAuthIdentities.mockReset().mockResolvedValue([]);
    listCustomers.mockReset().mockResolvedValue([]);
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
  });
});
