import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { DEFAULT_DAILY_AMOUNTS } from '../../src/modules/packs/daily-reward-validate';
import { unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

const PASSWORD = 'daily-test-password-1';

// Redesign Phase 5 — daily check-in reward. The claim is once per MYT day
// (advisory lock + unique claim row + idempotent ledger write): a first claim
// appends exactly one positive 'daily_reward' row; a same-day retry appends
// NOTHING; a claim the day after a streak_day=N claim pays day N+1.

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('daily reward claim', () => {
      let storeHeaders: Record<string, string>;

      beforeEach(async () => {
        const container = getContainer();
        const apiKeyModule = container.resolve(Modules.API_KEY);
        const key = await apiKeyModule.createApiKeys({
          title: 'daily-claim-test',
          type: 'publishable',
          created_by: 'daily-claim-test',
        });
        storeHeaders = { 'x-publishable-api-key': key.token };
      });

      const authed = (token: string): Record<string, string> => ({
        ...storeHeaders,
        authorization: `Bearer ${token}`,
      });

      const registerCustomer = async (email: string): Promise<string> => {
        const reg = await api.post('/auth/customer/emailpass/register', {
          email,
          password: PASSWORD,
        });
        await api.post(
          '/store/customers',
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
      };

      const status = (headers: Record<string, string>) =>
        unwrapResponse(api.get('/store/rewards/daily', { headers }));
      const claim = (headers: Record<string, string>) =>
        unwrapResponse(api.post('/store/rewards/daily/claim', {}, { headers }));

      const packs = () =>
        getContainer().resolve<PacksModuleService>(PACKS_MODULE);
      const ledgerRows = async () =>
        packs().listCreditTransactions({}, { take: 100 });

      it('rejects unauthenticated status and claim with 401', async () => {
        expect((await status(storeHeaders)).status).toBe(401);
        expect((await claim(storeHeaders)).status).toBe(401);
        expect(await ledgerRows()).toHaveLength(0);
      });

      it('claims day 1 once: ledger row, balance, claim row; same-day retry 409s and appends nothing', async () => {
        const token = await registerCustomer('daily-a@test.dev');

        // 1. Fresh customer: claimable day-1 state.
        const before = await status(authed(token));
        expect(before.status).toBe(200);
        expect(before.data).toMatchObject({
          enabled: true,
          claimedToday: false,
          streakDay: 1,
          todayAmount: DEFAULT_DAILY_AMOUNTS[0],
        });

        // 2. First claim pays day 1 into the ledger.
        const first = await claim(authed(token));
        expect(first.status).toBe(200);
        expect(first.data).toMatchObject({
          status: 'claimed',
          streakDay: 1,
          amount: DEFAULT_DAILY_AMOUNTS[0],
          balance: DEFAULT_DAILY_AMOUNTS[0],
        });

        const rows = await ledgerRows();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ reason: 'daily_reward' });
        expect(Number(rows[0].amount)).toBe(DEFAULT_DAILY_AMOUNTS[0]);
        // The idempotency key is carried on the row (reference and/or
        // source_transaction_id, per mutateCreditAtomic's dedupe contract).
        expect(
          [rows[0].reference, rows[0].source_transaction_id].some((v) =>
            /^daily:/.test(String(v)),
          ),
        ).toBe(true);

        // 3. Status flips to claimed-today, same streak day.
        const after = await status(authed(token));
        expect(after.data).toMatchObject({ claimedToday: true, streakDay: 1 });

        // 4. Same-day retry: 409, no second ledger row, no second claim row.
        const retry = await claim(authed(token));
        expect(retry.status).toBe(409);
        expect(retry.data.code).toBe('already_claimed');
        expect(await ledgerRows()).toHaveLength(1);
        expect(await packs().listDailyClaims({}, { take: 10 })).toHaveLength(1);
      });

      it('continues the streak: a claim the day after streak_day N pays N+1, and day 7 wraps to 1', async () => {
        const token = await registerCustomer('daily-b@test.dev');

        // Seed YESTERDAY's claim directly (no clock control in the harness) so
        // today's claim must read it and pay streak day 2.
        const me = await unwrapResponse(
          api.get('/store/customers/me', { headers: authed(token) }),
        );
        const customerId = me.data.customer.id;
        const yesterday = new Intl.DateTimeFormat('en-CA', {
          timeZone: 'Asia/Kuala_Lumpur',
        }).format(new Date(Date.now() - 86_400_000));
        await packs().createDailyClaims([
          {
            customer_id: customerId,
            claim_day: yesterday,
            streak_day: 1,
            amount: DEFAULT_DAILY_AMOUNTS[0],
          },
        ]);

        const st = await status(authed(token));
        expect(st.data).toMatchObject({
          claimedToday: false,
          streakDay: 2,
          todayAmount: DEFAULT_DAILY_AMOUNTS[1],
        });

        const res = await claim(authed(token));
        expect(res.status).toBe(200);
        expect(res.data).toMatchObject({
          status: 'claimed',
          streakDay: 2,
          amount: DEFAULT_DAILY_AMOUNTS[1],
        });

        // Wrap check: a streak_day=7 claim yesterday means today pays day 1
        // again (fresh customer to avoid the just-claimed today row).
        const token2 = await registerCustomer('daily-c@test.dev');
        const me2 = await unwrapResponse(
          api.get('/store/customers/me', { headers: authed(token2) }),
        );
        await packs().createDailyClaims([
          {
            customer_id: me2.data.customer.id,
            claim_day: yesterday,
            streak_day: 7,
            amount: DEFAULT_DAILY_AMOUNTS[6],
          },
        ]);
        const wrapped = await status(authed(token2));
        expect(wrapped.data).toMatchObject({ streakDay: 1 });
      });

      it('respects the admin kill switch: disabled settings 409 the claim and pay nothing', async () => {
        const token = await registerCustomer('daily-d@test.dev');
        await packs().editDailyRewardSettings({
          patch: { enabled: false },
          adminId: 'admin-test',
          reason: 'integration test kill switch',
        });

        const st = await status(authed(token));
        expect(st.data.enabled).toBe(false);

        const res = await claim(authed(token));
        expect(res.status).toBe(409);
        expect(res.data.code).toBe('disabled');
        expect(await ledgerRows()).toHaveLength(0);
      });

      it('admin settings edit validates and applies custom amounts to the next claim', async () => {
        const token = await registerCustomer('daily-e@test.dev');
        const amounts = [2, 2, 2, 2, 2, 2, 20];
        await packs().editDailyRewardSettings({
          patch: { amounts },
          adminId: 'admin-test',
          reason: 'integration test amounts',
        });

        const res = await claim(authed(token));
        expect(res.status).toBe(200);
        expect(res.data).toMatchObject({ amount: 2, streakDay: 1 });

        // The audit trail recorded the edit.
        const audits = await packs().listAdminActionAudits(
          { action: 'edit_daily_reward_settings' },
          { take: 10 },
        );
        expect(audits).toHaveLength(1);
      });
    });
  },
});
