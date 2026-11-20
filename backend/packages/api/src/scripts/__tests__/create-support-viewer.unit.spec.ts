import {
  SUPPORT_VIEWER_POLICIES,
  SUPPORT_VIEWER_ROLE,
} from '../create-support-viewer';
import {
  CUSTOMER_SUPPORT_WRITE,
  CUSTOM_ADMIN_RESOURCES,
  SECRET_READS,
} from '../../api/admin-rbac';
import { assistantPolicies } from '../../policies/assistant';
import { customerSupportPolicies } from '../../policies/customer-support';

// The Customer support role reads, and writes only through its own narrow
// policies: never customer:update, payment:update or any custom screen's
// update, which would let a support login edit balances, approve payouts or
// change players beyond the support fixes.
describe('Customer support role', () => {
  it('writes only the assistant unban and the support fixes (owner, 2026-11-03 / 2026-11-19)', () => {
    expect(SUPPORT_VIEWER_POLICIES.length).toBeGreaterThan(0);
    for (const p of SUPPORT_VIEWER_POLICIES) {
      expect(
        p.operation === 'read' ||
          (p.resource === 'assistant_unban' && p.operation === 'update') ||
          (p.resource === CUSTOMER_SUPPORT_WRITE.resource &&
            p.operation === CUSTOMER_SUPPORT_WRITE.operation),
      ).toBe(true);
    }
  });

  it('declares the support-fix policy, so the boot sync keeps it', () => {
    expect(
      customerSupportPolicies.policies.map(
        (p) => `${p.resource}:${p.operation}`,
      ),
    ).toEqual(['customer_support:update']);
  });

  it('names only declared resources (core, the custom admin table, secret reads, support fixes)', () => {
    const known = new Set<string>([
      'store',
      'customer',
      'payment',
      ...Object.values(CUSTOM_ADMIN_RESOURCES),
      ...assistantPolicies.policies.map((p) => p.resource),
      ...SECRET_READS.map((s) => s.resource),
      CUSTOMER_SUPPORT_WRITE.resource,
    ]);
    for (const p of SUPPORT_VIEWER_POLICIES)
      expect(known.has(p.resource)).toBe(true);
  });

  it('covers players, payments, orders and banks, and never the dashboard figures or partner passwords', () => {
    const resources = SUPPORT_VIEWER_POLICIES.map((p) => p.resource);
    expect(resources).toEqual(
      expect.arrayContaining([
        'player',
        'customer',
        'payment',
        'delivery_order',
        'store',
        'customer_bank_account',
      ]),
    );
    expect(resources).not.toContain('stats');
    expect(resources).not.toContain('profit_report');
    expect(resources).not.toContain('partner_credential');
    expect(SUPPORT_VIEWER_ROLE).toBe('Customer support');
  });
});
