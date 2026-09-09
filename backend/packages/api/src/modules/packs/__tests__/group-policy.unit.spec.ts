import type { MedusaContainer } from '@medusajs/framework/types';
import {
  EMPTY_GROUP_POLICY,
  groupPolicyOf,
  isPartnerGroup,
  resolveGroupPolicyForCustomer,
} from '../group-policy';
import { DEFAULT_PLAYER_GROUP_NAME, resolvePlayerGroup } from '../odds-sets';

// Group metadata is admin-written, untyped JSON. Every reader below must be
// defensive the way coerceOddsSet is: a value that is not exactly what the
// policy expects is the SAFE default (no partner rate, nothing blocked,
// nothing exempt), never a guess.

describe('groupPolicyOf', () => {
  it('is empty for a group with no metadata', () => {
    expect(groupPolicyOf({ name: 'pro', metadata: null })).toEqual(
      EMPTY_GROUP_POLICY,
    );
    expect(groupPolicyOf({ name: 'pro' })).toEqual(EMPTY_GROUP_POLICY);
  });

  it('reads a partner rate as number or numeric string', () => {
    expect(
      groupPolicyOf({ name: 'pro', metadata: { partner_rate_bp: 400 } })
        .partner_rate_bp,
    ).toBe(400);
    expect(
      groupPolicyOf({ name: 'pro', metadata: { partner_rate_bp: '400' } })
        .partner_rate_bp,
    ).toBe(400);
  });

  it('rolls a non-integer, negative or junk rate to null', () => {
    for (const v of [4.5, -1, 'x', '', true, {}, null, undefined]) {
      expect(
        groupPolicyOf({ name: 'pro', metadata: { partner_rate_bp: v } })
          .partner_rate_bp,
      ).toBeNull();
    }
  });

  it('honours the toggles only when exactly true', () => {
    const on = groupPolicyOf({
      name: 'pro',
      metadata: { withdrawals_blocked: true, verification_exempt: true },
    });
    expect(on.withdrawals_blocked).toBe(true);
    expect(on.verification_exempt).toBe(true);
    for (const v of ['true', 1, 'yes', {}, null]) {
      const p = groupPolicyOf({
        name: 'pro',
        metadata: { withdrawals_blocked: v, verification_exempt: v },
      });
      expect(p.withdrawals_blocked).toBe(false);
      expect(p.verification_exempt).toBe(false);
    }
  });

  // Same rule as effectiveOddsSet on the admin: DEFAULT's members and
  // customers with NO group must behave identically, so a policy stored on
  // that row is never honoured — even by a display-only reader.
  it('pins the DEFAULT group to the empty policy whatever its row stores', () => {
    expect(
      groupPolicyOf({
        name: DEFAULT_PLAYER_GROUP_NAME,
        metadata: { partner_rate_bp: 400, withdrawals_blocked: true },
      }),
    ).toEqual(EMPTY_GROUP_POLICY);
    expect(
      groupPolicyOf({
        name: 'House',
        metadata: { is_default: true, verification_exempt: true },
      }),
    ).toEqual(EMPTY_GROUP_POLICY);
  });
});

describe('isPartnerGroup', () => {
  it('is true only with a usable rate', () => {
    expect(
      isPartnerGroup({ name: 'p', metadata: { partner_rate_bp: 300 } }),
    ).toBe(true);
    expect(
      isPartnerGroup({ name: 'p', metadata: { partner_rate_bp: null } }),
    ).toBe(false);
    expect(
      isPartnerGroup({ name: 'p', metadata: { withdrawals_blocked: true } }),
    ).toBe(false);
  });
});

describe('resolvePlayerGroup / resolveGroupPolicyForCustomer', () => {
  // listCustomerGroups is asked for created_at ASC, so fixtures are oldest-first.
  const containerWith = (
    groups: { id?: string; name: string; metadata?: Record<string, unknown> }[],
  ) =>
    ({
      resolve: () => ({
        listCustomerGroups: async () =>
          groups.map((g, i) => ({ id: g.id ?? `cg_${i}`, ...g })),
      }),
    }) as unknown as MedusaContainer;

  it('is null for an anonymous caller and for a customer in no group', async () => {
    await expect(
      resolvePlayerGroup(containerWith([]), undefined),
    ).resolves.toBeNull();
    await expect(
      resolvePlayerGroup(containerWith([]), 'cus_1'),
    ).resolves.toBeNull();
    await expect(
      resolveGroupPolicyForCustomer(containerWith([]), 'cus_1'),
    ).resolves.toBeNull();
  });

  it('skips the DEFAULT group even when it is the oldest', async () => {
    const c = containerWith([
      { name: DEFAULT_PLAYER_GROUP_NAME, metadata: { is_default: true } },
      { id: 'cg_pro', name: 'pro', metadata: { partner_rate_bp: 350 } },
    ]);
    await expect(resolvePlayerGroup(c, 'cus_1')).resolves.toMatchObject({
      id: 'cg_pro',
    });
    await expect(resolveGroupPolicyForCustomer(c, 'cus_1')).resolves.toEqual({
      group: { id: 'cg_pro', name: 'pro' },
      policy: {
        partner_rate_bp: 350,
        withdrawals_blocked: false,
        verification_exempt: false,
      },
    });
  });

  it('is null when the only membership is DEFAULT', async () => {
    const c = containerWith([
      { name: DEFAULT_PLAYER_GROUP_NAME, metadata: { partner_rate_bp: 400 } },
    ]);
    await expect(resolveGroupPolicyForCustomer(c, 'cus_1')).resolves.toBeNull();
  });

  it('keeps oldest-wins among two real groups', async () => {
    const c = containerWith([
      { id: 'cg_a', name: 'a', metadata: { withdrawals_blocked: true } },
      { id: 'cg_b', name: 'b', metadata: { partner_rate_bp: 500 } },
    ]);
    const r = await resolveGroupPolicyForCustomer(c, 'cus_1');
    expect(r?.group.id).toBe('cg_a');
    expect(r?.policy.withdrawals_blocked).toBe(true);
    expect(r?.policy.partner_rate_bp).toBeNull();
  });
});
