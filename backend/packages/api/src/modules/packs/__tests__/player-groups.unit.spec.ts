import type { MedusaContainer } from '@medusajs/framework/types';
import { ensureDefaultPlayerGroup, setPlayerGroup } from '../player-groups';
import { DEFAULT_PLAYER_GROUP_NAME } from '../odds-sets';

// Exclusive membership is what makes resolveOddsSetForCustomer's "multi-group
// is harmless in practice" claim true, so it is worth pinning: every write on
// our surfaces routes through setPlayerGroup, and a refactor that reordered or
// dropped the remove half would reintroduce exactly the silent wrong-odds bug
// the DEFAULT-skip exists to contain.

type Group = { id: string; name: string; metadata?: Record<string, unknown> };

function buildContainer(opts: {
  groups?: Group[];
  memberships?: Group[];
  customerMissing?: boolean;
  createThrows?: boolean;
}) {
  const calls = {
    added: [] as { customer_id: string; customer_group_id: string }[],
    removed: [] as { customer_id: string; customer_group_id: string }[],
    created: [] as { name: string; metadata?: Record<string, unknown> }[],
    updated: [] as { id: string; metadata?: Record<string, unknown> }[],
  };
  let groups = [...(opts.groups ?? [])];

  const service = {
    retrieveCustomer: jest.fn(async (id: string) => {
      if (opts.customerMissing) throw new Error('Customer not found');
      return { id };
    }),
    retrieveCustomerGroup: jest.fn(async (id: string) => {
      const g = groups.find((x) => x.id === id);
      if (!g) throw new Error('Customer group not found');
      return g;
    }),
    // Two shapes in one stub, keyed on the filter the caller passes:
    // `{ customers }` asks for one player's memberships, `{}` asks for the
    // whole group list (ensureDefaultPlayerGroup's marker scan).
    listCustomerGroups: jest.fn(async (filters: Record<string, unknown>) =>
      'customers' in filters ? (opts.memberships ?? []) : groups,
    ),
    createCustomerGroups: jest.fn(
      async (data: { name: string; metadata?: Record<string, unknown> }) => {
        if (opts.createThrows) {
          // Simulate the unique-name race: the winner's row appears, then our
          // insert is rejected.
          groups = [
            ...groups,
            { id: 'cg_raced', name: data.name, metadata: data.metadata },
          ];
          throw new Error('duplicate key value violates unique constraint');
        }
        calls.created.push(data);
        const row = { id: 'cg_new', name: data.name, metadata: data.metadata };
        groups = [...groups, row];
        return row;
      },
    ),
    updateCustomerGroups: jest.fn(
      async (id: string, data: { metadata?: Record<string, unknown> }) => {
        calls.updated.push({ id, ...data });
        const i = groups.findIndex((g) => g.id === id);
        // Medusa MERGES metadata per key — mirror that, or the adoption test
        // would pass against a stub that silently drops odds_set.
        groups[i] = {
          ...groups[i],
          metadata: { ...groups[i].metadata, ...data.metadata },
        };
        return groups[i];
      },
    ),
    addCustomerToGroup: jest.fn(async (pair) => {
      calls.added.push(...(Array.isArray(pair) ? pair : [pair]));
      return { id: 'cgc_1' };
    }),
    removeCustomerFromGroup: jest.fn(async (pairs) => {
      calls.removed.push(...(Array.isArray(pairs) ? pairs : [pairs]));
    }),
  };

  return {
    container: { resolve: () => service } as unknown as MedusaContainer,
    service,
    calls,
    currentGroups: () => groups,
  };
}

describe('ensureDefaultPlayerGroup', () => {
  it('creates the group with the marker and set 1 when none exists', async () => {
    const { container, calls } = buildContainer({ groups: [] });
    const g = await ensureDefaultPlayerGroup(container);
    expect(g.name).toBe(DEFAULT_PLAYER_GROUP_NAME);
    expect(calls.created).toEqual([
      {
        name: DEFAULT_PLAYER_GROUP_NAME,
        metadata: { odds_set: 1, is_default: true },
      },
    ]);
  });

  it('reuses a marked group even after it was renamed', async () => {
    const { container, calls } = buildContainer({
      groups: [{ id: 'cg_1', name: 'House', metadata: { is_default: true } }],
    });
    const g = await ensureDefaultPlayerGroup(container);
    expect(g.id).toBe('cg_1');
    // The whole point: no second DEFAULT is created beside the renamed one.
    expect(calls.created).toHaveLength(0);
  });

  // Production already has a DEFAULT row that predates the marker. It must be
  // adopted, not duplicated, or the group the operator sees stops being the
  // one the code uses.
  it('adopts a pre-marker DEFAULT row instead of creating a second one', async () => {
    const { container, calls, currentGroups } = buildContainer({
      groups: [
        {
          id: 'cg_old',
          name: DEFAULT_PLAYER_GROUP_NAME,
          metadata: { odds_set: 1 },
        },
      ],
    });
    const g = await ensureDefaultPlayerGroup(container);
    expect(g.id).toBe('cg_old');
    expect(calls.created).toHaveLength(0);
    expect(calls.updated).toEqual([
      { id: 'cg_old', metadata: { is_default: true } },
    ]);
    // The stamp must not wipe the sibling key.
    expect(currentGroups()[0].metadata).toEqual({
      odds_set: 1,
      is_default: true,
    });
  });

  it('re-reads the winner when a concurrent sign-up wins the create race', async () => {
    const { container } = buildContainer({ groups: [], createThrows: true });
    const g = await ensureDefaultPlayerGroup(container);
    expect(g.id).toBe('cg_raced');
  });

  it('rethrows when the create fails for a reason other than the race', async () => {
    const { container, service } = buildContainer({ groups: [] });
    service.createCustomerGroups.mockRejectedValueOnce(new Error('boom'));
    await expect(ensureDefaultPlayerGroup(container)).rejects.toThrow('boom');
  });
});

describe('setPlayerGroup', () => {
  const PRO = { id: 'cg_pro', name: 'pro', metadata: { odds_set: 2 } };
  const DEF = {
    id: 'cg_def',
    name: DEFAULT_PLAYER_GROUP_NAME,
    metadata: { odds_set: 1, is_default: true },
  };

  it('adds the target and clears every other membership', async () => {
    const { container, calls } = buildContainer({
      groups: [DEF, PRO],
      memberships: [DEF],
    });
    const g = await setPlayerGroup(container, 'cus_1', PRO.id);
    expect(g.id).toBe(PRO.id);
    expect(calls.added).toEqual([
      { customer_id: 'cus_1', customer_group_id: PRO.id },
    ]);
    expect(calls.removed).toEqual([
      { customer_id: 'cus_1', customer_group_id: DEF.id },
    ]);
  });

  // Order is load-bearing: remove-then-add would leave the player in NO group
  // if the second half failed. Two groups is recoverable; none is not.
  it('adds before it removes', async () => {
    const { container, service } = buildContainer({
      groups: [DEF, PRO],
      memberships: [DEF],
    });
    await setPlayerGroup(container, 'cus_1', PRO.id);
    expect(service.addCustomerToGroup.mock.invocationCallOrder[0]).toBeLessThan(
      service.removeCustomerFromGroup.mock.invocationCallOrder[0],
    );
  });

  it('collapses a multi-group player onto the target in one call', async () => {
    const other = { id: 'cg_whale', name: 'whale', metadata: { odds_set: 3 } };
    const { container, calls } = buildContainer({
      groups: [DEF, PRO, other],
      memberships: [DEF, other],
    });
    await setPlayerGroup(container, 'cus_1', PRO.id);
    expect(calls.removed.map((r) => r.customer_group_id).sort()).toEqual(
      [DEF.id, other.id].sort(),
    );
  });

  it('is a no-op add when the player is already in the target', async () => {
    const { container, calls } = buildContainer({
      groups: [DEF, PRO],
      memberships: [PRO],
    });
    await setPlayerGroup(container, 'cus_1', PRO.id);
    expect(calls.added).toHaveLength(0);
    expect(calls.removed).toHaveLength(0);
  });

  // null means "back to the default group", never "no group" — otherwise the
  // Players list would show a blank cell after a move.
  it('falls back to the default group when groupId is null', async () => {
    const { container, calls } = buildContainer({
      groups: [DEF, PRO],
      memberships: [PRO],
    });
    const g = await setPlayerGroup(container, 'cus_1', null);
    expect(g.id).toBe(DEF.id);
    expect(calls.added).toEqual([
      { customer_id: 'cus_1', customer_group_id: DEF.id },
    ]);
    expect(calls.removed).toEqual([
      { customer_id: 'cus_1', customer_group_id: PRO.id },
    ]);
  });

  it('rejects an unknown group before writing anything', async () => {
    const { container, calls } = buildContainer({
      groups: [DEF],
      memberships: [DEF],
    });
    await expect(
      setPlayerGroup(container, 'cus_1', 'cg_nope'),
    ).rejects.toThrow();
    expect(calls.added).toHaveLength(0);
    expect(calls.removed).toHaveLength(0);
  });

  // Guards the customer BEFORE any write: letting a bad id reach
  // addCustomerToGroup surfaces a raw FK error as a 500.
  it('rejects an unknown customer before writing anything', async () => {
    const { container, calls } = buildContainer({
      groups: [DEF, PRO],
      memberships: [],
      customerMissing: true,
    });
    await expect(
      setPlayerGroup(container, 'cus_gone', PRO.id),
    ).rejects.toThrow();
    expect(calls.added).toHaveLength(0);
    expect(calls.removed).toHaveLength(0);
  });
});
