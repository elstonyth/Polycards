import {
  SUPPORT_VIEWER_POLICIES,
  SUPPORT_VIEWER_ROLE,
} from '../create-support-viewer';
import { CUSTOM_ADMIN_RESOURCES } from '../../api/admin-rbac';
import { assistantPolicies } from '../../policies/assistant';

// The Support viewer must stay VIEW-ONLY on admin routes: a write policy there
// would let a support login edit balances, approve payouts or change players.
// Its one write is the assistant's unban, which no admin route checks.
describe('Support viewer role', () => {
  it('holds read policies only, beside the assistant unban (owner, 2026-11-03)', () => {
    expect(SUPPORT_VIEWER_POLICIES.length).toBeGreaterThan(0);
    for (const p of SUPPORT_VIEWER_POLICIES) {
      expect(
        p.operation === 'read' ||
          (p.resource === 'assistant_unban' && p.operation === 'update'),
      ).toBe(true);
    }
  });

  it('names only declared resources (core, or the custom admin table)', () => {
    const known = new Set<string>([
      'store',
      'customer',
      'payment',
      ...Object.values(CUSTOM_ADMIN_RESOURCES),
      ...assistantPolicies.policies.map((p) => p.resource),
    ]);
    for (const p of SUPPORT_VIEWER_POLICIES)
      expect(known.has(p.resource)).toBe(true);
  });

  it('covers players, payments and delivery orders, and never the dashboard figures', () => {
    const resources = SUPPORT_VIEWER_POLICIES.map((p) => p.resource);
    expect(resources).toEqual(
      expect.arrayContaining([
        'player',
        'customer',
        'payment',
        'delivery_order',
        'store',
      ]),
    );
    expect(resources).not.toContain('stats');
    expect(resources).not.toContain('profit_report');
    // Partner passwords and full bank numbers (api/admin-rbac.ts SECRET_READS).
    expect(resources).not.toContain('partner_credential');
    expect(resources).not.toContain('customer_bank_account');
    expect(SUPPORT_VIEWER_ROLE).toBe('Support viewer');
  });
});
