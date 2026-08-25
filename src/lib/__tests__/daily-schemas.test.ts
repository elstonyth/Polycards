import { describe, it, expect } from 'vitest';
import { DailyStateSchema, parseOne } from '@/lib/data/schemas';

// The daily box was removed 2026-08-25, taking DrawBoxSchema and the state's
// `box` / `ship_prizes` fields with it. What GET /store/daily still serves is
// the VIP voucher/frame grant list, which is what this now pins.
describe('DailyStateSchema', () => {
  const fullFixture = {
    redemption_enabled: true,
    vouchers: {
      claimable: [
        {
          id: 'grant_1',
          kind: 'voucher',
          level: 4,
          payload: { amount_myr: 10 },
          granted_at: '2026-07-04T00:00:00.000Z',
        },
      ],
      claimed: [
        {
          id: 'grant_2',
          kind: 'frame',
          level: 2,
          payload: null,
          granted_at: '2026-07-01T00:00:00.000Z',
        },
      ],
    },
  };

  it('parses a full fixture (both voucher lists)', () => {
    const parsed = parseOne(DailyStateSchema, fullFixture);
    expect(parsed).not.toBeNull();
    expect(parsed?.redemption_enabled).toBe(true);
    expect(parsed?.vouchers.claimable).toHaveLength(1);
    expect(parsed?.vouchers.claimed).toHaveLength(1);
    // level is a required top-level GrantView field (packs/service.ts), not
    // read from payload — assert it round-trips for both grant lists.
    expect(parsed?.vouchers.claimable[0]?.level).toBe(4);
    expect(parsed?.vouchers.claimed[0]?.level).toBe(2);
  });

  it('rejects the whole state when a voucher grant is missing level', () => {
    const badGrant = {
      id: 'grant_3',
      kind: 'voucher',
      payload: { amount_myr: 10 },
      granted_at: '2026-07-04T00:00:00.000Z',
    };
    const parsed = parseOne(DailyStateSchema, {
      ...fullFixture,
      vouchers: { claimable: [badGrant], claimed: [] },
    });
    expect(parsed).toBeNull();
  });

  it("still parses a historical grant whose origin is 'box'", () => {
    // The box is gone but its grant rows are not: narrowing the enum here
    // would make an old row vanish from the customer's own reward list.
    const parsed = parseOne(DailyStateSchema, {
      ...fullFixture,
      vouchers: {
        claimable: [
          {
            id: 'grant_box',
            kind: 'voucher',
            level: 7,
            origin: 'box',
            payload: { amount_myr: 3 },
            granted_at: '2026-07-02T00:00:00.000Z',
          },
        ],
        claimed: [],
      },
    });
    expect(parsed?.vouchers.claimable[0]?.origin).toBe('box');
  });

  it('drops invalid shapes (missing redemption_enabled)', () => {
    const rest: Record<string, unknown> = { ...fullFixture };
    delete rest.redemption_enabled;
    expect(parseOne(DailyStateSchema, rest)).toBeNull();
  });
});
