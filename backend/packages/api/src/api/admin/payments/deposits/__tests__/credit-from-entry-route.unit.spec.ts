import { creditFromAdjustmentEntry } from '../../../../../modules/packs/deposit-adjustment-entry';
import { POST } from '../[id]/credit-from-entry/route';

jest.mock('../../../../../modules/packs/deposit-adjustment-entry', () => ({
  creditFromAdjustmentEntry: jest.fn(async () => ({
    credited: true,
    replayed: false,
    amount: 307.92,
    ref: 'MD20261108102020',
    entryId: 'D2026110814698519',
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

beforeEach(() => jest.mocked(creditFromAdjustmentEntry).mockClear());

describe('POST /admin/payments/deposits/:id/credit-from-entry', () => {
  it.each([
    ['none', { ref: 'MD1234' }],
    ['blank', { ref: 'MD1234', reason: '   ' }],
    ['too long', { ref: 'MD1234', reason: 'x'.repeat(501) }],
    ['not text', { ref: 'MD1234', reason: 5 }],
  ])('refuses a reason that is %s, before anything else', async (_l, body) => {
    await expect(run(body).promise).rejects.toThrow(/reason/i);
    expect(creditFromAdjustmentEntry).not.toHaveBeenCalled();
  });

  it('takes the admin from the token and the id from the path', async () => {
    const { json, promise } = run({
      ref: 'MD20261108102020',
      reason: ' Checked back office ',
      adminId: 'someone-else',
      depositId: 'gpd_other',
    });
    await promise;
    expect(creditFromAdjustmentEntry).toHaveBeenCalledWith(expect.anything(), {
      depositId: 'gpd_1',
      ref: 'MD20261108102020',
      adminId: 'usr_1',
      reason: 'Checked back office',
    });
    expect(json).toHaveBeenCalledWith({
      credited: true,
      replayed: false,
      amount: 307.92,
      ref: 'MD20261108102020',
      entryId: 'D2026110814698519',
    });
  });

  it('passes a non-text ref on as empty, for the module to refuse', async () => {
    await run({ ref: 42, reason: 'x' }).promise;
    expect(creditFromAdjustmentEntry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ ref: '' }),
    );
  });
});
