import { POST } from '../route';

// The Top Hits order is part of the pack page the operator curates, so a
// change leaves a before/after record like every other pack edit.

const rows = [
  { id: 'o1', pack_id: 'bronze-pack', card_id: 'card-a', top_hit_order: null },
  { id: 'o2', pack_id: 'bronze-pack', card_id: 'card-b', top_hit_order: 1 },
];

function harness() {
  const packs = {
    listPacks: jest
      .fn()
      .mockResolvedValue([{ id: 'pack_1', slug: 'bronze-pack' }]),
    listPackOdds: jest.fn(async (_f: unknown, opts?: { skip?: number }) =>
      (opts?.skip ?? 0) > 0 ? [] : rows,
    ),
    updatePackOdds: jest.fn(),
    createAdminActionAudits: jest.fn(),
  };
  const res = { json: jest.fn(), status: jest.fn() };
  res.status.mockReturnValue(res);
  const req = (card_ids: string[]) =>
    ({
      params: { slug: 'bronze-pack' },
      body: { card_ids },
      scope: { resolve: () => packs },
      auth_context: { actor_id: 'user_admin' },
    }) as unknown as Parameters<typeof POST>[0];
  return { packs, res: res as unknown as Parameters<typeof POST>[1], req };
}

describe('POST /admin/packs/:slug/top-hits — audit', () => {
  it('records the order of every card whose slot changed', async () => {
    const h = harness();
    await POST(h.req(['card-a', 'card-b']), h.res);
    expect(h.packs.createAdminActionAudits).toHaveBeenCalledWith([
      expect.objectContaining({
        admin_id: 'user_admin',
        entity_type: 'pack',
        entity_id: 'bronze-pack',
        action: 'edit_top_hits',
        before: { top_hits: { 'card-a': null, 'card-b': 1 } },
        after: { top_hits: { 'card-a': 1, 'card-b': 2 } },
      }),
    ]);
  });

  it('records nothing when the order did not change', async () => {
    const h = harness();
    await POST(h.req(['card-b']), h.res);
    expect(h.packs.updatePackOdds).not.toHaveBeenCalled();
    expect(h.packs.createAdminActionAudits).not.toHaveBeenCalled();
  });
});
