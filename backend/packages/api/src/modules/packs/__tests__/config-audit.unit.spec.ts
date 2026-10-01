import {
  CONFIG_AUDIT_REASON,
  configAuditRow,
  oddsSnapshot,
  packConfig,
  sameConfig,
} from '../config-audit';

describe('oddsSnapshot', () => {
  it('keeps every column that decides a draw, card rows only, sorted by card', () => {
    const snap = oddsSnapshot([
      {
        card_id: 'zeta',
        rarity: 'Rare',
        weight: 220_000,
        weight_2: 150_000,
        weight_3: null,
        locked: false,
        top_hit_order: 2,
      },
      // reward row (no card) — not part of a card pool snapshot
      { card_id: null, rarity: null, weight: 5, locked: false },
      {
        card_id: 'alpha',
        rarity: 'Immortal',
        weight: 1_000,
        locked: true,
      },
    ]);
    expect(snap).toEqual({
      odds: [
        {
          card_id: 'alpha',
          rarity: 'Immortal',
          weight: 1_000,
          weight_2: null,
          weight_3: null,
          locked: true,
          top_hit_order: null,
        },
        {
          card_id: 'zeta',
          rarity: 'Rare',
          weight: 220_000,
          weight_2: 150_000,
          weight_3: null,
          locked: false,
          top_hit_order: 2,
        },
      ],
    });
  });

  it('records a legacy null rarity as Common, the tier the draw uses', () => {
    expect(
      oddsSnapshot([{ card_id: 'a', rarity: null, weight: 1, locked: false }])
        .odds[0].rarity,
    ).toBe('Common');
  });
});

describe('packConfig', () => {
  it('captures the settings that decide price, odds display and buyback', () => {
    // A stored row: ids and timestamps are not configuration and are dropped.
    const stored = {
      id: 'pack_1',
      created_at: new Date(),
      slug: 'bronze-pack',
      title: 'Bronze Pack',
      category: 'pokemon',
      status: 'active',
      price: '300', // bigNumber can come back as a string
      buyback_percent: 100,
      target_rtp_bps: 7000,
      boost: false,
      rank: 2,
      image: '/b.webp',
      display_image: null,
      published_odds: { tiers: { Immortal: 0.1 } },
      tier_ranges: null,
    };
    expect(packConfig(stored)).toEqual({
      slug: 'bronze-pack',
      title: 'Bronze Pack',
      category: 'pokemon',
      status: 'active',
      price: 300,
      buyback_percent: 100,
      target_rtp_bps: 7000,
      boost: false,
      rank: 2,
      image: '/b.webp',
      display_image: null,
      published_odds: { tiers: { Immortal: 0.1 } },
      tier_ranges: null,
    });
  });
});

describe('sameConfig', () => {
  it('ignores key order, so a save that changed nothing is not recorded', () => {
    expect(
      sameConfig(
        { a: 1, nested: { x: 1, y: [1, 2] } },
        { nested: { y: [1, 2], x: 1 }, a: 1 },
      ),
    ).toBe(true);
  });

  it('sees a changed value anywhere in the tree', () => {
    expect(
      sameConfig({ tiers: { Immortal: 0.2 } }, { tiers: { Immortal: 0.1 } }),
    ).toBe(false);
    expect(sameConfig({ a: null }, { a: 0 })).toBe(false);
  });
});

describe('configAuditRow', () => {
  it('builds the row with the automatic reason', () => {
    expect(
      configAuditRow({
        adminId: 'user_1',
        entityType: 'pack',
        entityId: 'bronze-pack',
        action: 'edit_odds',
        before: { odds: [] },
        after: { odds: [] },
      }),
    ).toEqual({
      admin_id: 'user_1',
      entity_type: 'pack',
      entity_id: 'bronze-pack',
      action: 'edit_odds',
      before: { odds: [] },
      after: { odds: [] },
      reason: CONFIG_AUDIT_REASON,
    });
  });

  it('refuses to build a row without an acting admin', () => {
    expect(() =>
      configAuditRow({
        adminId: '',
        entityType: 'pack',
        entityId: 'bronze-pack',
        action: 'edit',
        before: null,
        after: null,
      }),
    ).toThrow(/admin/);
  });
});
