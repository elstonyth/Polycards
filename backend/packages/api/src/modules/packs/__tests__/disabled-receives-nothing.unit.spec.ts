import { MedusaError } from '@medusajs/framework/utils';
import PacksModuleService from '../service';

// Owner rule 2026-11-12: a disabled account receives nothing. The admin grants
// with no other test file of their own are pinned here; the credit grant,
// delivery, payout and referral gates sit beside their own seams' tests. The
// gate runs AFTER each grant's replay check, so a request that committed before
// the disable still answers with its result.
const disabledService = (
  opts: { doneDelta?: number; gifted?: number } = {},
) => {
  const svc = Object.create(PacksModuleService.prototype) as PacksModuleService;
  const em = {
    execute: jest.fn(async (sql: string) =>
      sql.includes('FROM lucky_draw_ticket') && opts.doneDelta !== undefined
        ? [{ delta: opts.doneDelta }]
        : [],
    ),
  };
  const writes = {
    createLuckyDrawTickets: jest.fn(async () => []),
    createPackGifts: jest.fn(async () => []),
  };
  Object.assign(svc, {
    isAccountDisabled: jest.fn(async () => true),
    luckyDrawBalance: jest.fn(async () => 0),
    listPacks: jest.fn(async () => [
      {
        id: 'pk_1',
        slug: 'any-pack',
        title: 'Any Pack',
        status: 'active',
        price: 10,
      },
    ]),
    listPackOdds: jest.fn(async () => [{ pack_id: 'any-pack' }]),
    listPackGifts: jest.fn(async () =>
      Array.from({ length: opts.gifted ?? 0 }, (_, i) => ({
        id: `pg_${i}`,
        pack_id: 'any-pack',
        status: 'unopened',
        created_at: new Date(),
      })),
    ),
    ...writes,
  });
  return {
    svc,
    em,
    writes,
    ctx: { transactionManager: em, manager: em } as never,
  };
};

const gift = {
  customerId: 'cus_1',
  packSlug: 'any-pack',
  quantity: 1,
  note: 'sorry',
  adminId: 'adm_1',
  idempotencyKey: 'k1',
};
const tickets = (n: number) => ({
  customerId: 'cus_1',
  tickets: n,
  note: 'goodwill',
  adminId: 'adm_1',
  idempotencyKey: 'k1',
});

describe('a disabled account receives nothing', () => {
  it('a pack gift is refused and nothing is written', async () => {
    const f = disabledService();
    await expect(f.svc.grantPackGifts(gift, f.ctx)).rejects.toMatchObject({
      type: MedusaError.Types.NOT_ALLOWED,
      message: expect.stringMatching(/disabled/),
    });
    expect(f.writes.createPackGifts).not.toHaveBeenCalled();
  });

  it('a pack gift that committed before the disable still replays', async () => {
    const f = disabledService({ gifted: 1 });
    await expect(f.svc.grantPackGifts(gift, f.ctx)).resolves.toMatchObject({
      replayed: true,
    });
    expect(f.writes.createPackGifts).not.toHaveBeenCalled();
  });

  it('a Lucky Draw ticket grant is refused and nothing is written', async () => {
    const f = disabledService();
    await expect(
      f.svc.adjustLuckyDrawTickets(tickets(5), f.ctx),
    ).rejects.toMatchObject({
      type: MedusaError.Types.NOT_ALLOWED,
      message: expect.stringMatching(/disabled/),
    });
    expect(f.writes.createLuckyDrawTickets).not.toHaveBeenCalled();
  });

  it('a ticket grant that committed before the disable still replays', async () => {
    const f = disabledService({ doneDelta: 5 });
    await expect(
      f.svc.adjustLuckyDrawTickets(tickets(5), f.ctx),
    ).resolves.toMatchObject({ replayed: true });
    expect(f.writes.createLuckyDrawTickets).not.toHaveBeenCalled();
  });
});
