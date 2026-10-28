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
      'procurement:read',
      'purchase_invoice:read',
      'purchase_invoice:update',
      'store:read',
    ]);
    expect(STOCK_KEEPER_ROLE).toBe('Stock keeper');
  });

  it('names only declared resources (core, or the custom admin table)', () => {
    const known = new Set<string>([
      'store',
      'inventory_item',
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
    ]) {
      expect(keys).not.toContain(k);
    }
    expect(keys.some((k) => k.endsWith(':delete'))).toBe(false);
  });
});
