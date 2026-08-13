import {
  ACCOUNT_INFO_PATH,
  blockDisabledCustomerSession,
  blockDisabledEmailpassLogin,
  CUSTOMER_ME_PATH,
  DELETE_PATH,
  REACTIVATE_PATH,
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
  // Every carve-out path, against the ADMIN branch. The carve-out is only ever
  // widened for `self`; an admin ban must stay total, or a banned account could
  // reach the delete route and purge the records the ban exists to preserve.
  it.each([
    REACTIVATE_PATH,
    DELETE_PATH,
    ACCOUNT_INFO_PATH,
    CUSTOMER_ME_PATH,
  ])(
    'blocks an admin-disabled session on %s',
    async (path) => {
      accountDisabledCause.mockResolvedValue('admin');
      const next = mkNext();
      await blockDisabledCustomerSession(mkSessionReq(path), {} as never, next);
      expect(String(next.mock.calls[0][0].message)).toMatch(
        /has been disabled/i,
      );
    },
  );

  // A self-disabled customer chose the state and no evidence is at risk, so
  // they must be able to delete WITHOUT reactivating first — and the Settings
  // page needs the account read to render the Danger zone at all. Without these
  // three the population most likely to want deletion could not reach it.
  //
  // CUSTOMER_ME_PATH is the one that makes the other two REACHABLE: /settings
  // renders behind the account layout, whose getCustomer() call is this path.
  // Blocked, it 403s, the layout reads that as logged-out and redirects to
  // /?auth=login — so the Danger zone could never be rendered at all.
  it.each([DELETE_PATH, ACCOUNT_INFO_PATH, CUSTOMER_ME_PATH])(
    'lets a self-disabled session through to %s',
    async (path) => {
      accountDisabledCause.mockResolvedValue('self');
      const next = mkNext();
      await blockDisabledCustomerSession(mkSessionReq(path), {} as never, next);
      expect(next).toHaveBeenCalledWith();
    },
  );

  // The safety argument for admitting CUSTOMER_ME_PATH rests entirely on the
  // set being EXACT membership rather than a prefix match. This is the test
  // that proves it: /store/customers/me/addresses shares the whole allowed
  // prefix and must still be refused. A future rewrite to startsWith() would
  // open every sub-route of the customer tree, and only this case would notice.
  it('blocks a self-disabled session on a sub-path of an allowed path', async () => {
    accountDisabledCause.mockResolvedValue('self');
    const next = mkNext();
    await blockDisabledCustomerSession(
      mkSessionReq('/store/customers/me/addresses'),
      {} as never,
      next,
    );
    expect(String(next.mock.calls[0][0].message)).toBe(SELF_DISABLED_CODE);
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
