import { GET as accountGET } from '../account/route';

const mkRes = () => {
  const res = { json: jest.fn(), status: jest.fn(), setHeader: jest.fn() };
  res.status.mockReturnValue(res);
  return res as never;
};

const listAuthIdentities = jest.fn();

// Partner groups (spec 2026-09-09): the account route also reads the player's
// group policy (customer module → listCustomerGroups) and their effective
// partner rate (packs → partnerBpForCustomers). Default: no group, no rate.
const listCustomerGroups = jest.fn(
  async (): Promise<
    { id: string; name: string; metadata?: Record<string, unknown> }[]
  > => [],
);
const partnerBpForCustomers = jest.fn(
  async (): Promise<Map<string, number | null>> => new Map(),
);

const scope = {
  resolve: jest.fn((key: string) => {
    if (key === 'packs') return { partnerBpForCustomers };
    if (key === 'auth') return { listAuthIdentities };
    if (key === 'logger')
      return { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    return { listCustomerGroups };
  }),
};

const mkReq = () =>
  ({
    auth_context: { actor_id: 'cus_1' },
    body: null,
    scope,
  }) as never;

const withEmailpass = () =>
  listAuthIdentities.mockResolvedValue([
    {
      id: 'authid_1',
      provider_identities: [{ provider: 'emailpass', entity_id: 'a@b.dev' }],
    },
  ]);

// The fact the storefront's required-phone gate turns on: only a password-less
// (Google-only) account is gated, because the phone-change route asks a
// password account for a password the gate has no field for.
describe('GET /store/customers/me/account', () => {
  const NO_POLICY = {
    partner: false,
    withdrawals_blocked: false,
    verification_exempt: false,
  };

  beforeEach(() => {
    listAuthIdentities.mockReset();
    listCustomerGroups.mockReset().mockResolvedValue([]);
    partnerBpForCustomers.mockReset().mockResolvedValue(new Map());
  });

  it('reports hasPassword true for an emailpass account', async () => {
    withEmailpass();
    const res = mkRes();
    await accountGET(mkReq(), res);
    expect((res as { json: jest.Mock }).json).toHaveBeenCalledWith({
      hasPassword: true,
      policy: NO_POLICY,
    });
  });

  it('reports hasPassword false for a Google-only account', async () => {
    listAuthIdentities.mockResolvedValue([
      { id: 'authid_g', provider_identities: [{ provider: 'google' }] },
    ]);
    const res = mkRes();
    await accountGET(mkReq(), res);
    expect((res as { json: jest.Mock }).json).toHaveBeenCalledWith({
      hasPassword: false,
      policy: NO_POLICY,
    });
  });

  // Partner groups (spec 2026-09-09): the policy block is what lets the
  // storefront skip the phone modal and swap the withdrawal form for a notice.
  it('carries the partner-group policy', async () => {
    withEmailpass();
    listCustomerGroups.mockResolvedValue([
      {
        id: 'cg_p',
        name: 'partners',
        metadata: {
          partner_rate_bp: 400,
          withdrawals_blocked: true,
          verification_exempt: true,
        },
      },
    ]);
    partnerBpForCustomers.mockResolvedValue(new Map([['cus_1', 400]]));
    const res = mkRes();
    await accountGET(mkReq(), res);
    expect((res as { json: jest.Mock }).json).toHaveBeenCalledWith({
      hasPassword: true,
      policy: {
        partner: true,
        withdrawals_blocked: true,
        verification_exempt: true,
      },
    });
  });

  // A manual partner flag with no group: partner, nothing blocked or exempt.
  it('reports a manual partner without group toggles', async () => {
    withEmailpass();
    partnerBpForCustomers.mockResolvedValue(new Map([['cus_1', 350]]));
    const res = mkRes();
    await accountGET(mkReq(), res);
    expect((res as { json: jest.Mock }).json).toHaveBeenCalledWith({
      hasPassword: true,
      policy: { ...NO_POLICY, partner: true },
    });
  });
});
