import { MedusaError } from '@medusajs/framework/utils';
import { POST } from '../route';
import { editGroupOddsSet } from '../../../../../../modules/packs/player-groups';

jest.mock('../../../../../../modules/packs/player-groups', () => ({
  editGroupOddsSet: jest.fn(),
}));

const edit = editGroupOddsSet as jest.MockedFunction<typeof editGroupOddsSet>;

const call = async (body: unknown) => {
  const res = { json: jest.fn() };
  await POST(
    {
      params: { id: 'cg_pro' },
      body,
      scope: {},
      auth_context: { actor_id: 'user_admin' },
    } as never,
    res as never,
  );
  return res;
};

describe('POST /admin/customer-groups/:id/odds-set', () => {
  beforeEach(() => edit.mockReset());

  it('changes the set as the signed-in admin and returns the group', async () => {
    edit.mockResolvedValue({
      id: 'cg_pro',
      name: 'pro',
      metadata: { odds_set: 3 },
    } as never);
    const res = await call({ odds_set: 3 });
    expect(edit).toHaveBeenCalledWith(
      {},
      { groupId: 'cg_pro', oddsSet: 3, adminId: 'user_admin' },
    );
    expect(res.json).toHaveBeenCalledWith({
      customer_group: { id: 'cg_pro', name: 'pro', metadata: { odds_set: 3 } },
    });
  });

  it.each([[4], ['2'], [null], [undefined]])(
    'refuses odds_set %p before touching the group',
    async (odds_set) => {
      await expect(call({ odds_set })).rejects.toBeInstanceOf(MedusaError);
      expect(edit).not.toHaveBeenCalled();
    },
  );
});
