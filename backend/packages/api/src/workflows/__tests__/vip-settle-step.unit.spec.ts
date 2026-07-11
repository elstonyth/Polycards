/**
 * VIP settlement is part of the open saga itself (sim day-3 vip-integrity HIGH).
 *
 * The bug: open-batch (and open-pack) settled VIP ONLY via the post-commit
 * vip.spend_settled event. Event delivery is at-most-once (Redis/BullMQ queue,
 * shared across processes in dev) — a lost event permanently strands every
 * ladder rung the open crossed and leaves GET /store/vip self-contradictory
 * (next.remaining=0 while level never advances), because nothing re-settles
 * until the customer's NEXT open.
 *
 * The fix under test: both open workflows call the idempotent
 * grantLevelUpRewards synchronously (settleVipStep) after the charge commits,
 * so every rung crossed by the open — one or several — is granted before the
 * response returns. The event + subscriber stay as the redelivery healer.
 *
 * These tests run the REAL workflows against a mocked container (no DB): the
 * rung enumeration itself (levelsToGrant / grantLevelUpRewards multi-rung) is
 * covered by vip-rewards.unit.spec.ts and level-up-grant.spec.ts.
 */
import { MedusaError, Modules } from '@medusajs/framework/utils';
import { createMedusaContainer } from '@medusajs/framework/utils';
import { asValue } from 'awilix';
import { openPackWorkflow } from '../open-pack';
import { openBatchWorkflow } from '../open-batch';

jest.setTimeout(60000);

type Harness = {
  container: ReturnType<typeof createMedusaContainer>;
  calls: {
    settleOpen: Array<{ customerId: string; sourceTransactionId: string }>;
    grantLevelUpRewards: Array<{ customerId: string; openId: string }>;
    reverseOpen: string[];
    notifications: Array<Record<string, unknown>>;
  };
};

function buildHarness(opts: {
  gained?: number[];
  grantThrows?: boolean;
}): Harness {
  const calls: Harness['calls'] = {
    settleOpen: [],
    grantLevelUpRewards: [],
    reverseOpen: [],
    notifications: [],
  };

  const packsService = {
    listPacks: async () => [
      { id: 'pack_1', slug: 'test-pack', price: 10, active: true },
    ],
    listPackOdds: async () => [
      { id: 'odds_1', pack_id: 'pack_1', card_id: 'card-a', weight: 1 },
    ],
    listCards: async () => [
      {
        id: 'c1',
        handle: 'card-a',
        name: 'Card A',
        market_value: 5,
        rarity: 'common',
      },
    ],
    settleOpen: async (input: {
      customerId: string;
      sourceTransactionId: string;
    }) => {
      calls.settleOpen.push({
        customerId: input.customerId,
        sourceTransactionId: input.sourceTransactionId,
      });
      return { balance: 90 };
    },
    reverseOpen: async (openId: string) => {
      calls.reverseOpen.push(openId);
    },
    grantLevelUpRewards: async (customerId: string, openId: string) => {
      calls.grantLevelUpRewards.push({ customerId, openId });
      if (opts.grantThrows) {
        throw new Error('grant path exploded');
      }
      return { gained: opts.gained ?? [] };
    },
    creditBalance: async () => 100,
    createPulls: async (rows: Array<Record<string, unknown>>) =>
      rows.map((r, i) => ({
        id: `pull_${i + 1}`,
        ...r,
        revealed_at: null,
        stock_earmarked: false,
      })),
    createPull: async (row: Record<string, unknown>) => ({
      id: 'pull_1',
      ...row,
      revealed_at: null,
      stock_earmarked: false,
    }),
    updatePulls: async () => [],
    deletePulls: async () => undefined,
    deletePull: async () => undefined,
  };

  const container = createMedusaContainer();
  container.register({
    packs: asValue(packsService),
    event_bus: asValue({
      emit: async () => undefined,
      releaseGroupedEvents: async () => undefined,
      clearGroupedEvents: async () => undefined,
    }),
    [Modules.NOTIFICATION]: asValue({
      createNotifications: async (n: Record<string, unknown>) => {
        calls.notifications.push(n);
        return [n];
      },
    }),
    logger: asValue({
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    }),
    query: asValue({ graph: async () => ({ data: [] }) }),
    inventory: asValue({
      adjustInventory: async () => {
        throw new MedusaError(MedusaError.Types.NOT_FOUND, 'untracked');
      },
    }),
  });

  return { container, calls };
}

describe('open-batch settles VIP synchronously (sim day-3 vip-integrity)', () => {
  it('grants the rung crossed by the batch before the workflow returns', async () => {
    const { container, calls } = buildHarness({ gained: [23] });

    await openBatchWorkflow(container).run({
      input: { pack_id: 'test-pack', customer_id: 'cus_1', count: 3 },
    });

    // The settlement ran in-saga, for the right customer, anchored on the SAME
    // open_id the charge row was written with.
    expect(calls.grantLevelUpRewards).toHaveLength(1);
    expect(calls.grantLevelUpRewards[0].customerId).toBe('cus_1');
    expect(calls.settleOpen).toHaveLength(1);
    expect(calls.grantLevelUpRewards[0].openId).toBe(
      calls.settleOpen[0].sourceTransactionId,
    );

    // The consolidated vip_level_up feed notification fired for the gained rung.
    expect(calls.notifications).toHaveLength(1);
    expect(calls.notifications[0]).toMatchObject({
      receiver_id: 'cus_1',
      template: 'vip_level_up',
      data: { levels: [23] },
      idempotency_key: `${calls.grantLevelUpRewards[0].openId}:levelup`,
    });
  });

  it('a batch crossing TWO rungs notifies both gained levels', async () => {
    const { container, calls } = buildHarness({ gained: [22, 23] });

    await openBatchWorkflow(container).run({
      input: { pack_id: 'test-pack', customer_id: 'cus_1', count: 3 },
    });

    expect(calls.grantLevelUpRewards).toHaveLength(1);
    expect(calls.notifications).toHaveLength(1);
    expect(calls.notifications[0]).toMatchObject({
      data: { levels: [22, 23] },
    });
  });

  it('no rung crossed → no notification, workflow still succeeds', async () => {
    const { container, calls } = buildHarness({ gained: [] });

    const { result } = await openBatchWorkflow(container).run({
      input: { pack_id: 'test-pack', customer_id: 'cus_1', count: 2 },
    });

    expect(calls.grantLevelUpRewards).toHaveLength(1);
    expect(calls.notifications).toHaveLength(0);
    expect(result.pulls).toHaveLength(2);
  });

  it('a grant failure NEVER voids the paid open (best-effort, event heals)', async () => {
    const { container, calls } = buildHarness({ grantThrows: true });

    const { result } = await openBatchWorkflow(container).run({
      input: { pack_id: 'test-pack', customer_id: 'cus_1', count: 3 },
    });

    // The open stands: pulls returned, charge NOT compensated.
    expect(result.pulls).toHaveLength(3);
    expect(calls.reverseOpen).toHaveLength(0);
  });
});

describe('open-pack settles VIP synchronously (same seam, single path)', () => {
  it('grants the rung crossed by a single open before the workflow returns', async () => {
    const { container, calls } = buildHarness({ gained: [22] });

    await openPackWorkflow(container).run({
      input: { pack_id: 'test-pack', customer_id: 'cus_1' },
    });

    expect(calls.grantLevelUpRewards).toHaveLength(1);
    expect(calls.grantLevelUpRewards[0].customerId).toBe('cus_1');
    expect(calls.grantLevelUpRewards[0].openId).toBe(
      calls.settleOpen[0].sourceTransactionId,
    );
    expect(calls.notifications).toHaveLength(1);
    expect(calls.notifications[0]).toMatchObject({
      data: { levels: [22] },
    });
  });
});
