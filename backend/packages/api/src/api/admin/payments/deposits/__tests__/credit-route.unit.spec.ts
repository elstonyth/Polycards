import { creditDepositByAdmin } from '../../../../../modules/packs/gateway-deposit';
import { POST } from '../[id]/credit/route';

jest.mock('../../../../../modules/packs/gateway-deposit', () => ({
  creditDepositByAdmin: jest.fn(async () => ({
    credited: true,
    replayed: false,
  })),
}));

const run = (body: unknown) => {
  const json = jest.fn();
  const promise = POST(
    {
      body,
      params: { id: 'gpd_1' },
      scope: {},
      auth_context: { actor_id: 'usr_1' },
    } as never,
    { json } as never,
  );
  return { json, promise };
};

beforeEach(() => jest.mocked(creditDepositByAdmin).mockClear());

describe('POST /admin/payments/deposits/:id/credit', () => {
  it.each([
    ['none', {}],
    ['blank', { reason: '   ' }],
    ['too long', { reason: 'x'.repeat(501) }],
    ['not text', { reason: 5 }],
  ])('refuses a reason that is %s, before anything else', async (_label, body) => {
    await expect(run(body).promise).rejects.toThrow(/reason/i);
    expect(creditDepositByAdmin).not.toHaveBeenCalled();
  });

  it('takes the admin from the token and the id from the path', async () => {
    const { json, promise } = run({
      reason: ' Bank slip checked ',
      adminId: 'someone-else',
    });
    await promise;
    expect(creditDepositByAdmin).toHaveBeenCalledWith(expect.anything(), {
      depositId: 'gpd_1',
      adminId: 'usr_1',
      reason: 'Bank slip checked',
    });
    expect(json).toHaveBeenCalledWith({ credited: true, replayed: false });
  });
});
