import PacksModuleService from '../service';
import { taskWeekFor } from '../referral';
import type { TaskFacts } from '../tasks';

/**
 * Two task-engine rules pinned without a DB (fake-`this`, as in
 * delivery-transition-atomic.unit.spec.ts):
 *
 *  1. saveTaskDefinition checks that a reward / requirement target EXISTS
 *     only when that target CHANGED versus the stored definition. Retire and
 *     the active toggle re-POST the whole definition, so a card or pack
 *     deleted since the save must not 400 the very action that fixes it
 *     (review-E 2026-09). Requirement targets (rip_count.pack_id,
 *     vault_pixel_count.pixel_pokemon_id) are now checked too — a typo there
 *     published a task nobody could complete.
 *  2. taskFactsFor measures reach_level against highest_level_ever, not the
 *     net current_level that drops after a reverseOpen — an achievement must
 *     never UN-complete (the vault counts' rule).
 */

const EXISTING = {
  id: 'task_1',
  kind: 'achievement',
  title: 'Vault 2',
  requirement: { type: 'vault_count', count: 2 },
  // The card this rewards has since been DELETED.
  reward: { type: 'card', card_handle: 'gone-card' },
  active: true,
  sort: 0,
  starts_at: null,
  ends_at: null,
};

function fakeSave(existing: Record<string, unknown> | null = EXISTING) {
  const svc = Object.create(PacksModuleService.prototype) as PacksModuleService;
  const fns = {
    listTaskDefinitions: jest.fn(async () => (existing ? [existing] : [])),
    listCards: jest.fn(async () => []),
    listPacks: jest.fn(async () => []),
    listPixelPokemon: jest.fn(async () => []),
    updateTaskDefinitions: jest.fn(async () => []),
    createTaskDefinitions: jest.fn(async () => [{ id: 'task_new' }]),
    createAdminActionAudits: jest.fn(async () => []),
  };
  Object.assign(svc, fns);
  const em = { execute: jest.fn(async () => []) };
  return { svc, ctx: { transactionManager: em } as never, ...fns };
}

const base = {
  id: 'task_1',
  kind: 'achievement' as const,
  title: 'Vault 2',
  requirement: { type: 'vault_count', count: 2 },
  reward: { type: 'card', card_handle: 'gone-card' },
  sort: 0,
  adminId: 'adm_1',
  reason: 'retire',
};

describe('saveTaskDefinition re-validates targets only when they change', () => {
  it('Retire (active toggle) on a task whose reward card was deleted saves', async () => {
    const f = fakeSave();
    await expect(
      f.svc.saveTaskDefinition({ ...base, active: false }, f.ctx),
    ).resolves.toEqual({ id: 'task_1' });
    expect(f.listCards).not.toHaveBeenCalled();
    expect(f.updateTaskDefinitions).toHaveBeenCalledWith(
      {
        selector: { id: 'task_1' },
        data: expect.objectContaining({ active: false }),
      },
      expect.anything(),
    );
    expect(f.createAdminActionAudits).toHaveBeenCalledTimes(1);
  });

  it('the comparison is key-order insensitive (jsonb does not keep ours)', async () => {
    const f = fakeSave({
      ...EXISTING,
      reward: { card_handle: 'gone-card', type: 'card' },
      requirement: { count: 2, type: 'vault_count' },
    });
    await expect(
      f.svc.saveTaskDefinition({ ...base, active: false }, f.ctx),
    ).resolves.toEqual({ id: 'task_1' });
    expect(f.listCards).not.toHaveBeenCalled();
    expect(f.listPacks).not.toHaveBeenCalled();
  });

  it('a CHANGED reward is still checked — and a missing card still 400s', async () => {
    const f = fakeSave();
    await expect(
      f.svc.saveTaskDefinition(
        {
          ...base,
          active: true,
          reward: { type: 'card', card_handle: 'other-card' },
        },
        f.ctx,
      ),
    ).rejects.toThrow(/Reward card 'other-card' does not exist/);
    expect(f.listCards).toHaveBeenCalledWith(
      { handle: 'other-card' },
      expect.anything(),
      expect.anything(),
    );
    expect(f.updateTaskDefinitions).not.toHaveBeenCalled();
  });

  it('a create always checks its targets', async () => {
    const f = fakeSave(null);
    await expect(
      f.svc.saveTaskDefinition({ ...base, id: undefined, active: true }, f.ctx),
    ).rejects.toThrow(/does not exist/);
  });

  it('rip_count.pack_id must name an existing pack', async () => {
    const f = fakeSave(null);
    await expect(
      f.svc.saveTaskDefinition(
        {
          kind: 'weekly',
          title: 'Rip 3 of a pack',
          requirement: { type: 'rip_count', count: 3, pack_id: 'no-such-pack' },
          reward: { type: 'credit', amount_myr: 1 },
          active: true,
          sort: 0,
          adminId: 'adm_1',
          reason: 'seed',
        },
        f.ctx,
      ),
    ).rejects.toThrow(/Requirement pack 'no-such-pack' does not exist/);
    expect(f.listPacks).toHaveBeenCalledWith(
      { slug: 'no-such-pack' },
      expect.anything(),
      expect.anything(),
    );
    expect(f.createTaskDefinitions).not.toHaveBeenCalled();
  });

  it('vault_pixel_count.pixel_pokemon_id must name an existing pixel Pokémon (singular runtime name)', async () => {
    const f = fakeSave(null);
    await expect(
      f.svc.saveTaskDefinition(
        {
          kind: 'achievement',
          title: 'Vault 2 Pikachu',
          requirement: {
            type: 'vault_pixel_count',
            count: 2,
            pixel_pokemon_id: 'px_nope',
          },
          reward: { type: 'credit', amount_myr: 1 },
          active: true,
          sort: 0,
          adminId: 'adm_1',
          reason: 'seed',
        },
        f.ctx,
      ),
    ).rejects.toThrow(/Requirement pixel Pokémon 'px_nope' does not exist/);
    expect(f.listPixelPokemon).toHaveBeenCalledWith(
      { id: 'px_nope' },
      expect.anything(),
      expect.anything(),
    );
  });

  it('an unchanged requirement whose pack was deleted does not block the save either', async () => {
    const f = fakeSave({
      ...EXISTING,
      kind: 'weekly',
      requirement: { type: 'rip_count', count: 3, pack_id: 'gone-pack' },
      reward: { type: 'credit', amount_myr: 1 },
    });
    await expect(
      f.svc.saveTaskDefinition(
        {
          ...base,
          kind: 'weekly',
          requirement: { type: 'rip_count', count: 3, pack_id: 'gone-pack' },
          reward: { type: 'credit', amount_myr: 1 },
          active: false,
        },
        f.ctx,
      ),
    ).resolves.toEqual({ id: 'task_1' });
    expect(f.listPacks).not.toHaveBeenCalled();
  });
});

describe('taskFactsFor reads the VIP high-water mark', () => {
  it('reach_level is measured against highest_level_ever, never current_level', async () => {
    const svc = Object.create(
      PacksModuleService.prototype,
    ) as PacksModuleService;
    // Parameters declared so mock.calls[0][1] indexes under `strict`.
    const listVipMemberStates = jest.fn(
      async (_selector: unknown, _config?: unknown) => [
        // A clawback dropped the net level below the peak.
        { highest_level_ever: 10, current_level: 9 },
      ],
    );
    Object.assign(svc, {
      listDailyCheckins: jest.fn(async () => []),
      listVipMemberStates,
    });
    const em = { execute: jest.fn(async () => []) };
    const facts: TaskFacts = await (
      svc as unknown as {
        taskFactsFor: (
          input: { customerId: string; week: ReturnType<typeof taskWeekFor> },
          ctx: unknown,
        ) => Promise<TaskFacts>;
      }
    ).taskFactsFor(
      { customerId: 'cus_1', week: taskWeekFor(new Date()) },
      { manager: em },
    );
    expect(facts.vipLevel).toBe(10);
    // The select names the column — a `current_level`-only select would
    // read undefined and silently fall back to 1.
    expect(listVipMemberStates.mock.calls[0][1]).toMatchObject({
      select: ['highest_level_ever'],
    });
  });
});
