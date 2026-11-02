import {
  STOCK_KEEPER_POLICIES,
  STOCK_KEEPER_ROLE,
} from '../grant-stock-keeper';
import { CUSTOM_ADMIN_RESOURCES } from '../../api/admin-rbac';

// The Stock keeper views stock and records goods receive notes and purchase
// invoices (owner, 2026-10-28: "view and record"). One extra policy here
// widens a staff login beyond what was asked.
describe('Stock keeper role', () => {
  it('holds exactly the view-and-record stock policies', () => {
    expect(
      STOCK_KEEPER_POLICIES.map((p) => `${p.resource}:${p.operation}`).sort(),
    ).toEqual([
      'goods_receive_note:read',
      'goods_receive_note:update',
      'inventory:read',
      'inventory_item:read',
      'media:update',
      'pricecharting:read',
      'pricing:read',
      'procurement:read',
      'product:create',
      'product:read',
      'purchase_invoice:read',
      'purchase_invoice:update',
      'store:read',
      'tcg:read',
    ]);
    expect(STOCK_KEEPER_ROLE).toBe('Stock keeper');
  });

  it('names only declared resources (core, or the custom admin table)', () => {
    const known = new Set<string>([
      'store',
      'inventory_item',
      'product',
      ...Object.values(CUSTOM_ADMIN_RESOURCES),
    ]);
    for (const p of STOCK_KEEPER_POLICIES) {
      expect(known.has(p.resource)).toBe(true);
    }
  });

  it('never opens players, money, card registration or deletes', () => {
    const keys = STOCK_KEEPER_POLICIES.map(
      (p) => `${p.resource}:${p.operation}`,
    );
    for (const k of [
      'customer:read',
      'payment:read',
      'payment:update',
      'customer_bank_account:read',
      'partner_credential:read',
      'card:update',
      'gacha:update',
      'pricing:update',
      'product:update',
    ]) {
      expect(keys).not.toContain(k);
    }
    expect(keys.some((k) => k.endsWith(':delete'))).toBe(false);
  });
});

// stockKeeperRoleId against a fake RBAC service: the reuse guard (review
// finding on #886) and the created / reused / links-added report.
import { stockKeeperRoleId } from '../grant-stock-keeper';

type Row = { id: string; [k: string]: unknown };
const fakeScope = (opts: { roles: Row[]; links: Row[]; policies: Row[] }) => {
  const created: { roles: Row[]; links: Row[] } = { roles: [], links: [] };
  const rbac = {
    listRbacRoles: async () => opts.roles,
    listRbacPolicies: async (f: { id?: string[]; resource?: string; operation?: string }) =>
      f.id
        ? opts.policies.filter((p) => f.id!.includes(p.id))
        : opts.policies.filter(
            (p) => p.key === `${f.resource}:${f.operation}`,
          ),
    listRbacRolePolicies: async (f: { role_id: string; policy_id?: string }) =>
      [...opts.links, ...created.links].filter(
        (l) =>
          l.role_id === f.role_id &&
          (f.policy_id === undefined || l.policy_id === f.policy_id),
      ),
    createRbacRoles: async (r: Record<string, unknown>) => {
      const role = { id: 'role_new', ...r };
      created.roles.push(role);
      return role;
    },
    createRbacRolePolicies: async (l: { role_id: string; policy_id: string }) => {
      created.links.push({ id: `link_${created.links.length}`, ...l });
    },
  };
  return {
    scope: { resolve: () => rbac } as never,
    created,
  };
};
const allPolicies = STOCK_KEEPER_POLICIES.map((p, i) => ({
  id: `pol_${i}`,
  key: `${p.resource}:${p.operation}`,
}));

describe('stockKeeperRoleId', () => {
  it('creates the role and links every policy when none exists', async () => {
    const { scope, created } = fakeScope({
      roles: [],
      links: [],
      policies: allPolicies,
    });
    expect(await stockKeeperRoleId(scope)).toEqual({
      id: 'role_new',
      created: true,
      added: STOCK_KEEPER_POLICIES.length,
    });
    expect(created.roles).toHaveLength(1);
  });

  it('reuses a matching role and adds only missing links', async () => {
    const { scope, created } = fakeScope({
      roles: [{ id: 'role_sk' }],
      links: [{ id: 'l0', role_id: 'role_sk', policy_id: 'pol_0' }],
      policies: allPolicies,
    });
    expect(await stockKeeperRoleId(scope)).toEqual({
      id: 'role_sk',
      created: false,
      added: STOCK_KEEPER_POLICIES.length - 1,
    });
    expect(created.roles).toHaveLength(0);
  });

  it('refuses a same-named role that holds anything extra, writing nothing', async () => {
    const { scope, created } = fakeScope({
      roles: [{ id: 'role_sk' }],
      links: [{ id: 'l0', role_id: 'role_sk', policy_id: 'pol_x' }],
      policies: [...allPolicies, { id: 'pol_x', key: 'customer:read' }],
    });
    await expect(stockKeeperRoleId(scope)).rejects.toThrow(
      /outside this script's list: customer:read/,
    );
    expect(created.links).toHaveLength(0);
  });

  it('fails closed before any write when a declared policy row is missing', async () => {
    const { scope, created } = fakeScope({
      roles: [],
      links: [],
      policies: allPolicies.slice(1),
    });
    await expect(stockKeeperRoleId(scope)).rejects.toThrow(
      /No live RBAC policy/,
    );
    expect(created.roles).toHaveLength(0);
  });
});
