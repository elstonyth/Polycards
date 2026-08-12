import {
  blockDisabledCustomerSession,
  blockDisabledEmailpassLogin,
  SELF_DISABLED_CODE,
} from '../disabled-guard';

const accountDisabledCause = jest.fn();
const listAuthIdentities = jest.fn();

const scope = {
  resolve: jest.fn((key: string) => {
    if (key === 'packs') return { accountDisabledCause };
    return { listAuthIdentities };
  }),
};

const mkNext = () => jest.fn();

// `originalUrl`, NOT `path`. The guard is registered method-less, so Express
// takes the `app.use(matcher, handler)` branch and has already stripped the
// matched prefix by the time the handler runs: `req.path` is '/' in there.
// Setting `path` here would make the test assert on itself.
const mkSessionReq = (originalUrl: string) =>
  ({
    auth_context: { actor_id: 'cus_1', actor_type: 'customer' },
    originalUrl,
    method: 'POST',
    scope,
  }) as never;

beforeEach(() => {
  accountDisabledCause.mockReset();
  listAuthIdentities.mockReset();
  listAuthIdentities.mockResolvedValue([
    { app_metadata: { customer_id: 'cus_1' } },
  ]);
});

describe('blockDisabledEmailpassLogin', () => {
  it('blocks an admin-disabled account', async () => {
    accountDisabledCause.mockResolvedValue('admin');
    const next = mkNext();
    await blockDisabledEmailpassLogin(
      { body: { email: 'a@b.dev' }, scope } as never,
      {} as never,
      next,
    );
    expect(next.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(String(next.mock.calls[0][0].message)).toMatch(/has been disabled/i);
  });

  // A row whose disabled_cause is NULL reaches the guard as 'admin' — the
  // service collapses it. Pinned at the guard as well, because the guard is
  // where an inverted test (`=== 'admin'` to deny) would turn any OTHER value
  // into a silent login bypass.
  it('blocks a disabled account whose cause is NULL in the database', async () => {
    accountDisabledCause.mockResolvedValue('admin'); // what NULL resolves to
    const next = mkNext();
    await blockDisabledEmailpassLogin(
      { body: { email: 'a@b.dev' }, scope } as never,
      {} as never,
      next,
    );
    expect(String(next.mock.calls[0][0].message)).toMatch(/has been disabled/i);
  });

  // The inversion guard itself: an unexpected third cause must BLOCK, not pass.
  it('blocks an unexpected cause value', async () => {
    accountDisabledCause.mockResolvedValue('suspended');
    const next = mkNext();
    await blockDisabledEmailpassLogin(
      { body: { email: 'a@b.dev' }, scope } as never,
      {} as never,
      next,
    );
    expect(String(next.mock.calls[0][0].message)).toMatch(/has been disabled/i);
  });

  it('lets a self-disabled account log in so it can be reactivated', async () => {
    accountDisabledCause.mockResolvedValue('self');
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
  it('blocks an admin-disabled session on every path', async () => {
    accountDisabledCause.mockResolvedValue('admin');
    const next = mkNext();
    await blockDisabledCustomerSession(
      mkSessionReq('/store/customers/me/reactivate'),
      {} as never,
      next,
    );
    expect(String(next.mock.calls[0][0].message)).toMatch(/has been disabled/i);
  });

  it('blocks a self-disabled session everywhere except reactivate', async () => {
    accountDisabledCause.mockResolvedValue('self');
    const next = mkNext();
    await blockDisabledCustomerSession(
      mkSessionReq('/store/credits'),
      {} as never,
      next,
    );
    expect(String(next.mock.calls[0][0].message)).toBe(SELF_DISABLED_CODE);
  });

  it('lets a self-disabled session through to reactivate', async () => {
    accountDisabledCause.mockResolvedValue('self');
    const next = mkNext();
    await blockDisabledCustomerSession(
      mkSessionReq('/store/customers/me/reactivate'),
      {} as never,
      next,
    );
    expect(next).toHaveBeenCalledWith();
  });

  // originalUrl carries whatever the client sent, so the two shapes a browser
  // or fetch wrapper produces for the SAME route must not lock the customer
  // out of the one path they are allowed to use.
  it('lets the reactivate path through with a query string', async () => {
    accountDisabledCause.mockResolvedValue('self');
    const next = mkNext();
    await blockDisabledCustomerSession(
      mkSessionReq('/store/customers/me/reactivate?from=login'),
      {} as never,
      next,
    );
    expect(next).toHaveBeenCalledWith();
  });

  it('lets the reactivate path through with a trailing slash', async () => {
    accountDisabledCause.mockResolvedValue('self');
    const next = mkNext();
    await blockDisabledCustomerSession(
      mkSessionReq('/store/customers/me/reactivate/'),
      {} as never,
      next,
    );
    expect(next).toHaveBeenCalledWith();
  });

  it('passes anonymous traffic straight through', async () => {
    const next = mkNext();
    await blockDisabledCustomerSession(
      { originalUrl: '/store/packs', scope } as never,
      {} as never,
      next,
    );
    expect(next).toHaveBeenCalledWith();
    expect(accountDisabledCause).not.toHaveBeenCalled();
  });
});
