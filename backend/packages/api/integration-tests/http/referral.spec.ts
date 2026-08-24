// integration-tests/http/referral.spec.ts
// The referral rebuild's HTTP surface (spec 2026-08-24):
//   (auth)  every store/admin route 401s without a bearer
//   (bind)  invite handle → permanent attribution; self + double bind refused
//   (loop)  close → admin review → approve → pay → store history shows paid
//   (admin) partner-rate bounds enforced; settings edit persists
import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { referralWeekFor } from '../../src/modules/packs/referral';
import { mintSuperAdmin, postStoreCustomer, unwrapResponse } from './utils';

jest.setTimeout(300 * 1000);

const PASSWORD = 'referral-http-test-pw-1';
const ADMIN_EMAIL = 'referral-admin@test.dev';

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('referral HTTP surface', () => {
      let storeHeaders: Record<string, string>;
      let adminToken: string;
      let referrerToken: string;
      let recruitToken: string;

      const authed = (token: string): Record<string, string> => ({
        ...storeHeaders,
        authorization: `Bearer ${token}`,
      });
      const adminHeaders = (): Record<string, string> => ({
        authorization: `Bearer ${adminToken}`,
      });

      async function registerAndLogin(email: string): Promise<string> {
        const reg = await api.post('/auth/customer/emailpass/register', {
          email,
          password: PASSWORD,
        });
        await postStoreCustomer(
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
        const login = await api.post('/auth/customer/emailpass', {
          email,
          password: PASSWORD,
        });
        return login.data.token;
      }

      beforeEach(async () => {
        const container = getContainer();
        const apiKeyModule = container.resolve(Modules.API_KEY);
        const key = await apiKeyModule.createApiKeys({
          title: 'referral-test',
          type: 'publishable',
          created_by: 'referral-test',
        });
        storeHeaders = { 'x-publishable-api-key': key.token };
        adminToken = await mintSuperAdmin(
          container,
          api,
          ADMIN_EMAIL,
          PASSWORD,
        );
        referrerToken = await registerAndLogin('referrer@test.dev');
        recruitToken = await registerAndLogin('recruit@test.dev');
      });

      it('401s without auth on every new route', async () => {
        for (const [method, path] of [
          ['get', '/store/referral'],
          ['get', '/store/vip-rebate'],
          ['post', '/store/referral/bind'],
        ] as const) {
          const res = await unwrapResponse(
            method === 'get'
              ? api.get(path, { headers: storeHeaders })
              : api.post(
                  path,
                  { referrer_handle: 'x-000000' },
                  { headers: storeHeaders },
                ),
          );
          expect(res.status).toBe(401);
        }
        for (const [method, path] of [
          ['get', '/admin/referrals/settings'],
          ['post', '/admin/referrals/settings'],
          ['get', '/admin/referrals/settlements'],
        ] as const) {
          const res = await unwrapResponse(
            method === 'get' ? api.get(path) : api.post(path, {}),
          );
          expect(res.status).toBe(401);
        }
      });

      it('bind → close → approve → pay round-trips through every surface', async () => {
        // Referrer's handle from their own panel.
        const rPanel = await unwrapResponse(
          api.get('/store/referral', { headers: authed(referrerToken) }),
        );
        expect(rPanel.status).toBe(200);
        const handle: string = rPanel.data.handle;
        expect(handle).toBeTruthy();
        expect(rPanel.data.downline_count).toBe(0);

        // Self-bind refused; recruit binds; double bind refused.
        const self = await unwrapResponse(
          api.post(
            '/store/referral/bind',
            { referrer_handle: handle },
            { headers: authed(referrerToken) },
          ),
        );
        expect(self.data).toEqual({ bound: false, reason: 'self' });
        const bind = await unwrapResponse(
          api.post(
            '/store/referral/bind',
            { referrer_handle: handle },
            { headers: authed(recruitToken) },
          ),
        );
        expect(bind.data).toEqual({ bound: true });
        const again = await unwrapResponse(
          api.post(
            '/store/referral/bind',
            { referrer_handle: handle },
            { headers: authed(recruitToken) },
          ),
        );
        expect(again.data).toEqual({ bound: false, reason: 'already_bound' });

        // Recruit spends RM1000 this week (seeded straight into the ledger).
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        const recruitPanel = await unwrapResponse(
          api.get('/store/referral', { headers: authed(recruitToken) }),
        );
        expect(recruitPanel.status).toBe(200);
        // Identify the recruit's customer_id via the attribution row.
        const [attribution] = await packs.listReferralAttributions(
          {},
          { take: 1 },
        );
        await packs.createCreditTransactions([
          {
            customer_id: attribution.customer_id,
            amount: -1000,
            reason: 'pack_open',
          },
        ]);

        // Live panel reflects the still-open week.
        const rLive = await unwrapResponse(
          api.get('/store/referral', { headers: authed(referrerToken) }),
        );
        expect(rLive.data.downline_count).toBe(1);
        expect(rLive.data.week.turnover_cents).toBe(100_000);
        expect(rLive.data.week.rate_bp).toBe(50);
        expect(rLive.data.week.projected_cents).toBe(500);

        // Tuesday close (the current, still-open week — closed explicitly).
        const week = referralWeekFor(new Date());
        const closed = await packs.closeReferralWeek({
          weekStartIso: week.weekStartIso,
        });
        expect(closed.created).toBe(true);

        // Admin: list shows the draft; detail carries the line.
        const list = await unwrapResponse(
          api.get('/admin/referrals/settlements', { headers: adminHeaders() }),
        );
        expect(list.status).toBe(200);
        expect(list.data.settlements).toHaveLength(1);
        expect(list.data.settlements[0].status).toBe('draft');
        const detail = await unwrapResponse(
          api.get(`/admin/referrals/settlements/${closed.settlementId}`, {
            headers: adminHeaders(),
          }),
        );
        expect(detail.data.lines.length).toBeGreaterThanOrEqual(1);

        // Approve, then pay.
        const approve = await unwrapResponse(
          api.post(
            `/admin/referrals/settlements/${closed.settlementId}/approve`,
            {},
            { headers: adminHeaders() },
          ),
        );
        expect(approve.status).toBe(200);
        const pay = await unwrapResponse(
          api.post(
            `/admin/referrals/settlements/${closed.settlementId}/pay`,
            {},
            { headers: adminHeaders() },
          ),
        );
        expect(pay.status).toBe(200);
        expect(pay.data.paid).toBeGreaterThanOrEqual(1);

        // The referrer's history shows the paid commission.
        const rAfter = await unwrapResponse(
          api.get('/store/referral', { headers: authed(referrerToken) }),
        );
        expect(rAfter.data.history).toHaveLength(1);
        expect(rAfter.data.history[0].status).toBe('paid');
        expect(rAfter.data.history[0].amount_cents).toBe(500);
      });

      it('vip-rebate panel returns level and empty history for a fresh customer', async () => {
        const res = await unwrapResponse(
          api.get('/store/vip-rebate', { headers: authed(recruitToken) }),
        );
        expect(res.status).toBe(200);
        expect(res.data.level).toBe(1);
        expect(res.data.history).toEqual([]);
        expect(res.data.week.turnover_cents).toBe(0);
      });

      it('admin settings edit persists and partner-rate enforces bounds', async () => {
        const before = await unwrapResponse(
          api.get('/admin/referrals/settings', { headers: adminHeaders() }),
        );
        expect(before.data.tiers[0]).toEqual({ min_cents: 0, rate_bp: 50 });

        const edited = await unwrapResponse(
          api.post(
            '/admin/referrals/settings',
            {
              tiers: [
                { min_cents: 0, rate_bp: 75 },
                { min_cents: 1_000_000, rate_bp: 150 },
              ],
              reason: 'http test edit',
            },
            { headers: adminHeaders() },
          ),
        );
        expect(edited.status).toBe(200);
        expect(edited.data.tiers).toHaveLength(2);
        expect(edited.data.tiers[0].rate_bp).toBe(75);

        // Partner rate on the recruit: out-of-bounds refused, in-bounds lands.
        const [attribution] = await getContainer()
          .resolve<PacksModuleService>(PACKS_MODULE)
          .listReferralAttributions({}, { take: 1 });
        const someCustomerId = attribution?.customer_id ?? 'cus_absent';
        const low = await unwrapResponse(
          api.post(
            `/admin/customers/${someCustomerId}/partner-rate`,
            { rate_bp: 10, reason: 'too low' },
            { headers: adminHeaders() },
          ),
        );
        expect(low.status).toBe(400);
        const ok = await unwrapResponse(
          api.post(
            `/admin/customers/${someCustomerId}/partner-rate`,
            { rate_bp: 400, reason: 'partner onboarding' },
            { headers: adminHeaders() },
          ),
        );
        expect(ok.status).toBe(200);
        const card = await unwrapResponse(
          api.get(`/admin/customers/${someCustomerId}/referral`, {
            headers: adminHeaders(),
          }),
        );
        expect(card.status).toBe(200);
        expect(card.data.partner_referral_bp).toBe(400);
      });
    });
  },
});
