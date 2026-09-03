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
          ['post', '/store/referral/bind'],
        ] as const) {
          const res = await unwrapResponse(
            method === 'get'
              ? api.get(path, { headers: storeHeaders })
              : api.post(
                  path,
                  { referrer_code: 'ZZZZZZZZ' },
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

      it('never hands two customers the same code, and never re-rolls one', async () => {
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        const customers = getContainer().resolve(Modules.CUSTOMER);
        const [a] = await customers.listCustomers({
          email: 'referrer@test.dev',
        });
        const [b] = await customers.listCustomers({
          email: 'recruit@test.dev',
        });
        // Scripted generator: the second customer's first candidate collides
        // with the first customer's code and must be skipped.
        const script = ['AAAAAAAA', 'AAAAAAAA', 'BBBBBBBB'];
        const generate = () => script.shift() ?? 'CCCCCCCC';

        expect(
          await packs.assignReferralCode({ customerId: a.id, generate }),
        ).toBe('AAAAAAAA');
        expect(
          await packs.assignReferralCode({ customerId: b.id, generate }),
        ).toBe('BBBBBBBB');
        // Idempotent: the generator is not even consulted once a code exists.
        expect(
          await packs.assignReferralCode({ customerId: a.id, generate }),
        ).toBe('AAAAAAAA');
        expect(script).toEqual([]);
      });

      it('bind → close → approve → pay round-trips through every surface', async () => {
        // Referrer's code from their own panel — assigned on first read,
        // stable after that.
        const rPanel = await unwrapResponse(
          api.get('/store/referral', { headers: authed(referrerToken) }),
        );
        expect(rPanel.status).toBe(200);
        const code: string = rPanel.data.code;
        expect(code).toMatch(/^[A-Z0-9]{8}$/);
        expect(rPanel.data.handle).toBeTruthy();
        expect(rPanel.data.downline_count).toBe(0);
        const rRead = await unwrapResponse(
          api.get('/store/referral', { headers: authed(referrerToken) }),
        );
        expect(rRead.data.code).toBe(code);

        // Public lookup (no auth): a known code — however it was pasted —
        // answers with public display fields only; unknown and malformed
        // codes are both 404.
        const found = await unwrapResponse(
          api.get(`/store/referral/codes/${code.toLowerCase()}`, {
            headers: storeHeaders,
          }),
        );
        expect(found.status).toBe(200);
        expect(found.data).toEqual({
          code,
          handle: rPanel.data.handle,
          name: expect.any(String),
        });
        expect(JSON.stringify(found.data)).not.toContain('referrer@test.dev');
        const missing = await unwrapResponse(
          api.get('/store/referral/codes/ZZZZZZZZ', { headers: storeHeaders }),
        );
        expect(missing.status).toBe(404);
        const junk = await unwrapResponse(
          api.get('/store/referral/codes/not-a-code', {
            headers: storeHeaders,
          }),
        );
        expect(junk.status).toBe(404);

        // Bind: malformed → 400; self → refused; unknown → not found; the
        // recruit binds with a pasted-looking code; double bind refused.
        // (Spread across the two tokens — the bind limiter allows 3/min each.)
        const malformed = await unwrapResponse(
          api.post(
            '/store/referral/bind',
            { referrer_code: 'abc' },
            { headers: authed(referrerToken) },
          ),
        );
        expect(malformed.status).toBe(400);
        const self = await unwrapResponse(
          api.post(
            '/store/referral/bind',
            { referrer_code: code },
            { headers: authed(referrerToken) },
          ),
        );
        expect(self.data).toEqual({ bound: false, reason: 'self' });
        const nobody = await unwrapResponse(
          api.post(
            '/store/referral/bind',
            { referrer_code: 'ZZZZZZZZ' },
            { headers: authed(recruitToken) },
          ),
        );
        expect(nobody.data).toEqual({
          bound: false,
          reason: 'referrer_not_found',
        });
        const bind = await unwrapResponse(
          api.post(
            '/store/referral/bind',
            { referrer_code: ` ${code.toLowerCase()} ` },
            { headers: authed(recruitToken) },
          ),
        );
        expect(bind.data).toEqual({ bound: true });
        const again = await unwrapResponse(
          api.post(
            '/store/referral/bind',
            { referrer_code: code },
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
