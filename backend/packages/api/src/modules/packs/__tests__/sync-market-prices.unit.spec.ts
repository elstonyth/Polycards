import {
  refreshCardPrice,
  recordPriceHistory,
  MAX_MARKET_VALUE_USD,
  MAX_SYNC_DELTA_RATIO,
  type CardRow,
  type RefreshDeps,
  type CardPriceUpdate,
} from '../sync-market-prices';

const card = (over: Partial<CardRow>): CardRow => ({
  id: 'card_1',
  handle: 'test-card',
  pc_product_id: '6910',
  pc_grade: 'PSA 10',
  market_value: 150,
  ...over,
});

const deps = (pennies: number) => {
  const updates: CardPriceUpdate[] = [];
  return {
    updates,
    d: {
      pcFetch: async () => ({
        kind: 'ok' as const,
        data: { id: '6910', 'manual-only-price': pennies },
      }),
      updateCards: async (u: Parameters<RefreshDeps['updateCards']>[0]) => {
        updates.push(...u);
        return true;
      },
      now: new Date('2026-10-16T03:00:00Z'),
    },
  };
};

const legacyCard = card({
  id: 'c1',
  handle: 'charizard-psa-10',
  market_value: 100,
});

test('updates from tier price', async () => {
  const upd: CardPriceUpdate[] = [];
  const r = await refreshCardPrice(legacyCard, {
    pcFetch: async () => ({
      kind: 'ok',
      data: { id: '6910', 'manual-only-price': 15000 },
    }),
    updateCards: async (u) => {
      upd.push(u[0]);
      return true;
    },
    now: new Date('2026-07-01T00:00:00Z'),
  });
  expect(r.newValue).toBe(150);
  expect(r.changed).toBe(true);
  expect(upd[0].market_value).toBe(150);
});

test('keeps last-known on error', async () => {
  const updateCards = jest.fn().mockResolvedValue(true);
  const r = await refreshCardPrice(legacyCard, {
    pcFetch: async () => ({ kind: 'error', message: 'boom' }),
    updateCards,
    now: new Date('2026-07-01T00:00:00Z'),
  });
  expect(r.changed).toBe(false);
  expect(r.skippedReason).toBe('boom');
  expect(updateCards).toHaveBeenCalledWith([
    { id: 'c1', pc_pending_price: null, pc_sync_error: 'boom' },
  ]);
});

test('skips zero price', async () => {
  const updateCards = jest.fn().mockResolvedValue(true);
  const r = await refreshCardPrice(legacyCard, {
    pcFetch: async () => ({
      kind: 'ok',
      data: { id: '6910', 'manual-only-price': 0 },
    }),
    updateCards,
    now: new Date('2026-07-01T00:00:00Z'),
  });
  expect(r.changed).toBe(false);
  expect(r.skippedReason).toMatch(/no usable price/i);
  expect(updateCards).toHaveBeenCalledWith([
    { id: 'c1', pc_pending_price: null, pc_sync_error: 'no usable price' },
  ]);
});

describe('refreshCardPrice — sanity bounds', () => {
  it('skips a change beyond MAX_SYNC_DELTA_RATIO and keeps last-known', async () => {
    const { d, updates } = deps(950 * 100); // $150 -> $950 (6.33×, beyond 5×)
    const r = await refreshCardPrice(card({}), d);
    expect(r.skippedReason).toMatch(/anomalous/);
    expect(r.newValue).toBe(150);
    expect(updates[0]).toMatchObject({
      pc_pending_price: { proposed_value: 950 },
      pc_sync_error: null,
    });
    expect(updates[0]).not.toHaveProperty('market_value');
  });

  it('skips a crash below 1/MAX_SYNC_DELTA_RATIO', async () => {
    const { d, updates } = deps(2500); // $150 -> $25 (0.167×, below 1/5)
    const r = await refreshCardPrice(card({}), d);
    expect(r.skippedReason).toMatch(/anomalous/);
    expect(updates[0]).toMatchObject({
      pc_pending_price: { proposed_value: 25 },
    });
    expect(updates[0]).not.toHaveProperty('market_value');
  });

  it('accepts a change within the ratio', async () => {
    const { d, updates } = deps(450 * 100); // 3× — within 5×
    const r = await refreshCardPrice(card({}), d);
    expect(r.changed).toBe(true);
    expect(r.newValue).toBe(450);
    expect(updates).toHaveLength(1);
  });

  it('caps first-sync values at MAX_MARKET_VALUE_USD', async () => {
    const { d, updates } = deps((MAX_MARKET_VALUE_USD + 1) * 100);
    const r = await refreshCardPrice(card({ market_value: 0 }), d);
    expect(r.skippedReason).toMatch(/cap/);
    expect(updates[0]).not.toHaveProperty('market_value');
    expect(updates[0].pc_sync_error).toMatch(/cap/);
  });

  it('sanity: ratio constant is what buyback exposure was priced against', () => {
    expect(MAX_SYNC_DELTA_RATIO).toBeGreaterThanOrEqual(2);
  });
});

describe('anomalous price confirmation', () => {
  const pending = {
    product_id: '6910',
    grade: 'PSA 10',
    baseline_value: 875,
    proposed_value: 47.5,
    first_seen_at: '2026-10-16T03:00:00.000Z',
  };
  const waitingCard = () =>
    card({ market_value: 875, pc_pending_price: pending });

  it('recovers the $875 -> $47.50 incident after two checks at least 24 hours apart', async () => {
    const first = deps(4750);
    const r1 = await refreshCardPrice(card({ market_value: 875 }), first.d);
    expect(r1.changed).toBe(false);
    expect(first.updates[0]).toEqual({
      id: 'card_1',
      pc_pending_price: pending,
      pc_sync_error: null,
    });
    const next = deps(4750);
    next.d.now = new Date('2026-10-17T03:00:00Z');
    const r2 = await refreshCardPrice(waitingCard(), next.d);
    expect(r2).toMatchObject({ oldValue: 875, newValue: 47.5, changed: true });
    expect(r2.skippedReason).toBeUndefined();
    expect(next.updates[0]).toEqual({
      id: 'card_1',
      market_value: 47.5,
      pc_synced_at: next.d.now,
      pc_pending_price: null,
      pc_sync_error: null,
    });
  });

  it('does not count duplicate or early runs as confirmation', async () => {
    const { d, updates } = deps(4750);
    d.now = new Date('2026-10-17T02:59:59Z');
    expect((await refreshCardPrice(waitingCard(), d)).changed).toBe(false);
    expect(updates[0].pc_pending_price).toEqual(pending);
    expect(updates[0]).not.toHaveProperty('market_value');
  });

  it.each([4275, 5225])(
    'accepts a confirmed quote within 10%% (%s cents)',
    async (pennies) => {
      const { d } = deps(pennies);
      d.now = new Date('2026-10-17T03:00:00Z');
      expect((await refreshCardPrice(waitingCard(), d)).newValue).toBe(
        pennies / 100,
      );
    },
  );

  it.each([4274, 5226])(
    'restarts observation when the quote moves beyond 10%% (%s cents)',
    async (pennies) => {
      const { d, updates } = deps(pennies);
      d.now = new Date('2026-10-17T03:00:00Z');
      expect((await refreshCardPrice(waitingCard(), d)).changed).toBe(false);
      expect(updates[0].pc_pending_price).toMatchObject({
        proposed_value: pennies / 100,
        first_seen_at: d.now.toISOString(),
      });
    },
  );

  it.each([
    { baseline_value: 900 },
    { product_id: 'other' },
    { grade: 'Ungraded' },
    { first_seen_at: 'invalid' },
    { first_seen_at: '2026-10-18T03:00:00Z' },
  ])('never accepts a stale or invalid observation %j', async (change) => {
    const { d, updates } = deps(4750);
    d.now = new Date('2026-10-17T03:00:00Z');
    const c = card({
      market_value: 875,
      pc_pending_price: { ...pending, ...change },
    });
    expect((await refreshCardPrice(c, d)).changed).toBe(false);
    expect(updates[0].pc_pending_price).toMatchObject({
      first_seen_at: d.now.toISOString(),
    });
  });

  it('clears pending state when a normal quote returns', async () => {
    const { d, updates } = deps(80000);
    await refreshCardPrice(waitingCard(), d);
    expect(updates[0]).toMatchObject({
      market_value: 800,
      pc_pending_price: null,
      pc_sync_error: null,
    });
  });

  it.each([
    0,
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    0.4,
    (MAX_MARKET_VALUE_USD + 1) * 100,
  ])(
    'invalid quote %s clears pending without writing money',
    async (pennies) => {
      const { d, updates } = deps(pennies);
      d.now = new Date('2026-10-17T03:00:00Z');
      expect((await refreshCardPrice(waitingCard(), d)).changed).toBe(false);
      expect(updates[0]).toMatchObject({
        pc_pending_price: null,
        pc_sync_error: expect.any(String),
      });
      expect(updates[0]).not.toHaveProperty('market_value');
    },
  );

  it.each([undefined, 'wrong-id'])(
    'rejects an unverified product identity %s',
    async (id) => {
      const { d, updates } = deps(4750);
      await refreshCardPrice(waitingCard(), {
        ...d,
        pcFetch: async () => ({
          kind: 'ok',
          data: { id, 'manual-only-price': 4750 },
        }),
      });
      expect(updates[0]).toMatchObject({
        pc_pending_price: null,
        pc_sync_error: expect.stringMatching(/identity/),
      });
      expect(updates[0]).not.toHaveProperty('market_value');
    },
  );

  it.each(['no-token', 'error'] as const)(
    'clears observations after %s',
    async (kind) => {
      const { d, updates } = deps(4750);
      await refreshCardPrice(waitingCard(), {
        ...d,
        pcFetch: async () =>
          kind === 'error'
            ? { kind, message: 'upstream unavailable' }
            : { kind },
      });
      expect(updates[0]).toMatchObject({
        pc_pending_price: null,
        pc_sync_error: expect.any(String),
      });
      expect(updates[0]).not.toHaveProperty('market_value');
    },
  );

  it.each([4750, 0, 80000])(
    'a lost atomic write never reports a price change or successful sync (%s cents)',
    async (pennies) => {
      const { d } = deps(pennies);
      d.now = new Date('2026-10-17T03:00:00Z');
      const result = await refreshCardPrice(waitingCard(), {
        ...d,
        updateCards: async () => false,
      });
      expect(result).toMatchObject({
        changed: false,
        newValue: 875,
        skippedReason: 'card changed during price check',
      });
    },
  );
});

describe('recordPriceHistory — latest-value comparison', () => {
  const mkPacks = (latest: number | null) => {
    const created: unknown[] = [];
    return {
      created,
      packs: {
        listCardPriceHistories: async () =>
          latest === null ? [] : [{ value: latest }],
        createCardPriceHistories: async (rows: unknown) =>
          void created.push(rows),
      },
    };
  };
  const result = {
    handle: 'h',
    oldValue: 100,
    newValue: 120,
    changed: false, // update committed on a PREVIOUS run; this run sees no change
  };

  it('self-heals a gap: latest history disagrees with current value', async () => {
    const { packs, created } = mkPacks(100);
    await recordPriceHistory(packs, 'card_1', { ...result, newValue: 120 });
    expect(created).toHaveLength(1);
  });

  it('skips when latest history already matches', async () => {
    const { packs, created } = mkPacks(120);
    await recordPriceHistory(packs, 'card_1', { ...result, newValue: 120 });
    expect(created).toHaveLength(0);
  });

  it('writes the baseline on first sync', async () => {
    const { packs, created } = mkPacks(null);
    await recordPriceHistory(packs, 'card_1', { ...result, newValue: 120 });
    expect(created).toHaveLength(1);
  });
});
