import { POST as disablePOST } from '../disable/route';
import { POST as reactivatePOST } from '../reactivate/route';

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
  accountDisabledCause.mockReset();
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
});
