import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { mintSuperAdmin, postStoreCustomer, unwrapResponse } from './utils';
import { VIP_LEVELS } from '../../src/scripts/vip-levels.data';

/**
 * The HTTP boundary of the three live admin commission routes (#432).
 *
 * c7447424 deleted the referral/commission specs when the referral WRITE paths
 * were retired, but POST /admin/commissions/:id/{reverse,suspend,unsuspend} are
 * still mounted and still rate-limited. reverseCommission kept service-level
 * coverage (customer-360, vip-3a-e2e, audit-for-customer); what went with the
 * deletion was everything the boundary owns and the service cannot assert:
 * auth, reason validation, and — the one that matters on a money route — that
 * admin_id comes from the verified session and NEVER from the request body.
 */

jest.setTimeout(240 * 1000);
const PASSWORD = 'admin-commissions-pw-1'; // gitleaks:allow

// These three routes sit on adminActionRateLimit (30 per 10s by default). This
// suite makes ~20 admin calls back to back, so the knobs are raised for the
// whole file — the limiter has its own suites, and a 429 here would read as a
// failed assertion instead of as a limiter working.
const RATE_ENV = {
  ADMIN_ACTION_RATE_BURST_LIMIT: '200',
  ADMIN_ACTION_RATE_BURST_WINDOW_MS: '60000',
  ADMIN_ACTION_RATE_LIMIT: '1000',
  ADMIN_ACTION_RATE_WINDOW_MS: '3600000',
};

const ACTIONS = ['reverse', 'suspend', 'unsuspend'] as const;

medusaIntegrationTestRunner({
  inApp: true,
  env: RATE_ENV,
  testSuite: ({ api, getContainer }) => {
    let storeHeaders: Record<string, string>;
    let adminToken: string;
    let adminUserId: string;

    beforeEach(async () => {
      const container = getContainer();
      const apiKey = container.resolve(Modules.API_KEY);
      const key = await apiKey.createApiKeys({
        title: 'admin-commissions-test',
        type: 'publishable',
        created_by: 'admin-commissions-test',
      });
      storeHeaders = { 'x-publishable-api-key': key.token };
      const email = 'commissions-admin@test.dev';
      adminToken = await mintSuperAdmin(container, api, email, PASSWORD);
      // req.auth_context.actor_id for an admin session IS the user id — the
      // value the anti-spoof test below reads back out of the audit row.
      const userService = container.resolve(Modules.USER);
      const [user] = await userService.listUsers({ email }, { take: 1 });
      adminUserId = user.id;
    });

    const adminHeaders = () => ({ authorization: `Bearer ${adminToken}` });

    const registerCustomer = async (email: string): Promise<string> => {
      const reg = await api.post('/auth/customer/emailpass/register', {
        email,
        password: PASSWORD,
      });
      const created = await postStoreCustomer(
        api,
        getContainer(),
        { email },
        {
          headers: {
            ...storeHeaders,
            authorization: `Bearer ${reg.data.token}`,
          },
        },
      );
      return created.data.customer.id;
    };

    /** A real gen-1 commission: sponsor <- recruit, recruit opens a pack. */
    async function seedCommission(tag: string): Promise<{
      commissionId: string;
      sponsorId: string;
    }> {
      const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
      const existing = await packs.listVipLevels({}, { take: 1 });
      if (existing.length === 0) {
        await packs.createVipLevels(
          VIP_LEVELS.map((r) => ({
            level: r.level,
            spend_threshold: r.spend_threshold,
            voucher_amount: r.voucher_amount,
            box_tier: r.box_tier,
            frame_unlock: r.frame_unlock,
            direct_referral_pct: r.direct_referral_pct,
            prizes: r.prizes ?? null,
          })),
        );
      }
      const sponsorId = await registerCustomer(`comm-${tag}-sponsor@test.dev`);
      const recruitId = await registerCustomer(`comm-${tag}-recruit@test.dev`);
      // Referral writes were retired with linkSponsor; the model is kept, so
      // the edge is seeded directly for setup (same as customer-360.spec.ts).
      await packs.createReferralRelationships([
        { customer_id: recruitId, sponsor_id: sponsorId },
      ]);
      await packs.mutateCreditAtomic({
        customerId: recruitId,
        amount: 30,
        reason: 'topup',
      });
      await packs.settleOpen({
        customerId: recruitId,
        amount: -20,
        sourceTransactionId: `comm_${tag}_open`,
      });
      const [commission] = await packs.listCommissions(
        { beneficiary: sponsorId },
        { take: 1 },
      );
      return { commissionId: commission.id, sponsorId };
    }

    describe('POST /admin/commissions/:id/* — auth', () => {
      it.each(ACTIONS)('%s 401s without a token', async (action) => {
        // The id need not exist: auth runs before the handler, and a route that
        // 404d here would mean an unauthenticated caller can probe for ids.
        const res = await unwrapResponse(
          api.post(`/admin/commissions/com_nope/${action}`, {
            reason: 'no token',
          }),
        );
        expect(res.status).toBe(401);
      });
    });

    describe('POST /admin/commissions/:id/* — reason validation', () => {
      // A money route's audit trail is worth exactly what its reason field is
      // worth, so an empty or oversized reason is refused BEFORE the service is
      // reached. The block is identical in all three routes — one table.
      const BAD: [string, Record<string, unknown>][] = [
        ['missing', {}],
        ['blank', { reason: '   ' }],
        ['non-string', { reason: 42 }],
        ['over-length', { reason: 'x'.repeat(501) }],
      ];

      it.each(
        ACTIONS.flatMap((action) =>
          BAD.map(([label, body]) => [action, label, body] as const),
        ),
      )('%s rejects a %s reason', async (action, _label, body) => {
        const res = await unwrapResponse(
          api.post(`/admin/commissions/com_nope/${action}`, body, {
            headers: adminHeaders(),
          }),
        );
        expect(res.status).toBe(400);
        expect(res.data.message).toMatch(/reason/i);
      });
    });

    describe('POST /admin/commissions/:id/suspend — admin_id binding', () => {
      it('records the SESSION actor, never an admin_id from the body', async () => {
        const { commissionId } = await seedCommission('spoof');

        const res = await unwrapResponse(
          api.post(
            `/admin/commissions/${commissionId}/suspend`,
            { reason: 'anti-spoof check', admin_id: 'adm_ATTACKER' },
            { headers: adminHeaders() },
          ),
        );
        expect(res.status).toBe(200);

        // The assertion that makes this test worth having: a 200 proves nothing
        // on its own — the AUDIT ROW is where a spoofed admin_id would land.
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        const [audit] = await packs.listAdminActionAudits(
          { entity_type: 'commission', entity_id: commissionId },
          { take: 1 },
        );
        expect(audit.action).toBe('suspend_commission');
        expect(audit.admin_id).toBe(adminUserId);
        expect(audit.admin_id).not.toBe('adm_ATTACKER');
      });
    });

    describe('POST /admin/commissions/:id/reverse — admin_id binding', () => {
      it('records the SESSION actor on the clawback audit row', async () => {
        // suspend is the route the issue names, but reverse is the one that
        // moves money — its audit row is the record of who took it back.
        const { commissionId } = await seedCommission('revspoof');

        const res = await unwrapResponse(
          api.post(
            `/admin/commissions/${commissionId}/reverse`,
            { reason: 'anti-spoof check', admin_id: 'adm_ATTACKER' },
            { headers: adminHeaders() },
          ),
        );
        expect(res.status).toBe(200);

        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        const [audit] = await packs.listAdminActionAudits(
          {
            entity_type: 'commission',
            entity_id: commissionId,
            action: 'reverse_commission',
          },
          { take: 1 },
        );
        expect(audit.admin_id).toBe(adminUserId);
        expect(audit.admin_id).not.toBe('adm_ATTACKER');
      });
    });

    describe('POST /admin/commissions/:id/reverse — idempotency', () => {
      it('reports reversed: 0 on a second clawback of the same commission', async () => {
        const { commissionId, sponsorId } = await seedCommission('idem');
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        expect(await packs.creditBalance(sponsorId)).toBeGreaterThan(0);

        const first = await unwrapResponse(
          api.post(
            `/admin/commissions/${commissionId}/reverse`,
            { reason: 'first clawback' },
            { headers: adminHeaders() },
          ),
        );
        expect(first.status).toBe(200);
        expect(first.data.reversed).toBe(1);
        expect(await packs.creditBalance(sponsorId)).toBe(0);

        // A double-clawback on a live admin money route: the second call must
        // be a no-op, not a second debit off the sponsor's balance.
        const second = await unwrapResponse(
          api.post(
            `/admin/commissions/${commissionId}/reverse`,
            { reason: 'double click' },
            { headers: adminHeaders() },
          ),
        );
        expect(second.status).toBe(200);
        expect(second.data.reversed).toBe(0);
        expect(await packs.creditBalance(sponsorId)).toBe(0);
      });
    });
  },
});
