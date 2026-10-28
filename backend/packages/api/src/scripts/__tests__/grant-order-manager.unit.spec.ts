import {
  ORDER_MANAGER_POLICIES,
  ORDER_MANAGER_ROLE,
} from '../grant-order-manager';
import { CUSTOM_ADMIN_RESOURCES } from '../../api/admin-rbac';

// The Order manager handles delivery orders and nothing past the All Orders
// page: one extra policy here widens a staff login beyond what was asked.
describe('Order manager role', () => {
  it('holds exactly the All Orders policies', () => {
    expect(
      ORDER_MANAGER_POLICIES.map((p) => `${p.resource}:${p.operation}`).sort(),
    ).toEqual([
      'delivery_order:read',
      'delivery_order:update',
      'media:update',
      'pull:read',
    ]);
    expect(ORDER_MANAGER_ROLE).toBe('Order manager');
  });

  it('names only declared resources (core, or the custom admin table)', () => {
    const known = new Set<string>([
      'payment',
      ...Object.values(CUSTOM_ADMIN_RESOURCES),
    ]);
    for (const p of ORDER_MANAGER_POLICIES) {
      expect(known.has(p.resource)).toBe(true);
    }
  });

  it('never opens players, payouts, bank numbers or partner passwords', () => {
    const keys = ORDER_MANAGER_POLICIES.map(
      (p) => `${p.resource}:${p.operation}`,
    );
    for (const k of [
      'customer:read',
      'payment:read',
      'payment:update',
      'customer_bank_account:read',
      'partner_credential:read',
    ]) {
      expect(keys).not.toContain(k);
    }
  });
});
