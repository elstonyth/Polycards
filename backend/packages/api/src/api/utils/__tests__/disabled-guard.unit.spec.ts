import {
  blockDisabledCustomerSession,
  blockDisabledEmailpassLogin,
} from '../disabled-guard';

// Both guards fail CLOSED, so what matters is that a disabled account is
// refused at login AND on an already-minted session, and that anonymous traffic
// is untouched. (These arrived with the self-service branch and outlived it —
// the guards themselves are older and had no unit coverage.)

// The guards read the disabled row itself, for the reason that picks the message.
const listCustomerAccountStates = jest.fn();
const isAccountDisabled = (disabled: boolean, reason = 'test') =>
  listCustomerAccountStates.mockResolvedValue(
    disabled ? [{ disabled_reason: reason }] : [],
  );
const listAuthIdentities = jest.fn();

const scope = {
  resolve: jest.fn((key: string) => {
    if (key === 'packs') return { listCustomerAccountStates };
    return { listAuthIdentities };
  }),
};

const mkNext = () => jest.fn();

beforeEach(() => {
  listCustomerAccountStates.mockReset();
  listAuthIdentities.mockReset();
  listAuthIdentities.mockResolvedValue([
    { app_metadata: { customer_id: 'cus_1' } },
  ]);
});

describe('blockDisabledEmailpassLogin', () => {
  it('refuses a disabled account before a token is minted', async () => {
    isAccountDisabled(true);
    const next = mkNext();
    await blockDisabledEmailpassLogin(
      { body: { email: 'a@b.dev' }, scope } as never,
      {} as never,
      next,
    );
    expect(next.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(String(next.mock.calls[0][0].message)).toMatch(/has been disabled/i);
  });

  it('lets an active account through', async () => {
    isAccountDisabled(false);
    const next = mkNext();
    await blockDisabledEmailpassLogin(
      { body: { email: 'a@b.dev' }, scope } as never,
      {} as never,
      next,
    );
    expect(next).toHaveBeenCalledWith();
  });
});

describe('blockDisabledCustomerSession', () => {
  const mkSessionReq = () =>
    ({
      auth_context: { actor_id: 'cus_1', actor_type: 'customer' },
      scope,
    }) as never;

  it('refuses a disabled customer holding a live token', async () => {
    isAccountDisabled(true);
    const next = mkNext();
    await blockDisabledCustomerSession(mkSessionReq(), {} as never, next);
    expect(next.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(String(next.mock.calls[0][0].message)).toMatch(/has been disabled/i);
  });

  it('passes anonymous traffic straight through without a lookup', async () => {
    const next = mkNext();
    await blockDisabledCustomerSession({ scope } as never, {} as never, next);
    expect(next).toHaveBeenCalledWith();
    expect(listCustomerAccountStates).not.toHaveBeenCalled();
  });
  it('tells a permanently banned account so, with no offer of support', async () => {
    isAccountDisabled(true, 'Permanent ban: shared bank');
    const next = mkNext();
    await blockDisabledCustomerSession(mkSessionReq(), {} as never, next);
    expect(String(next.mock.calls[0][0].message)).toBe(
      'This account has been permanently banned for breaking the rules.',
    );
    const login = mkNext();
    await blockDisabledEmailpassLogin(
      { body: { email: 'a@b.dev' }, scope } as never,
      {} as never,
      login,
    );
    expect(String(login.mock.calls[0][0].message)).toMatch(/permanently banned/);
  });
});
