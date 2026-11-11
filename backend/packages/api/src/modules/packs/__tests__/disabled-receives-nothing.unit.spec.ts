import { MedusaError } from '@medusajs/framework/utils';
import PacksModuleService from '../service';

// Owner rule 2026-11-12: a disabled account receives nothing. The admin grants
// with no other test file of their own are pinned here; the credit grant,
// delivery, payout and referral gates sit beside their own seams' tests.
const disabledService = () => {
  const svc = Object.create(PacksModuleService.prototype) as PacksModuleService;
  const em = { execute: jest.fn(async () => []) };
  const listPacks = jest.fn(async () => []);
  Object.assign(svc, {
    isAccountDisabled: jest.fn(async () => true),
    listPacks,
  });
  return {
    svc,
    em,
    listPacks,
    ctx: { transactionManager: em, manager: em } as never,
  };
};

describe('a disabled account receives nothing', () => {
  it('a pack gift is refused before the pack is even read', async () => {
    const f = disabledService();
    await expect(
      f.svc.grantPackGifts(
        {
          customerId: 'cus_1',
          packSlug: 'any-pack',
          quantity: 1,
          note: 'sorry',
          adminId: 'adm_1',
          idempotencyKey: 'k1',
        },
        f.ctx,
      ),
    ).rejects.toMatchObject({
      type: MedusaError.Types.NOT_ALLOWED,
      message: expect.stringMatching(/disabled/),
    });
    expect(f.listPacks).not.toHaveBeenCalled();
  });

  it('a Lucky Draw ticket grant is refused before any lock or write', async () => {
    const f = disabledService();
    await expect(
      f.svc.adjustLuckyDrawTickets(
        { customerId: 'cus_1', tickets: 5, note: 'goodwill', adminId: 'adm_1' },
        f.ctx,
      ),
    ).rejects.toMatchObject({ type: MedusaError.Types.NOT_ALLOWED });
    expect(f.em.execute).not.toHaveBeenCalled();
  });
});
