import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { mintSuperAdmin, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

const PASSWORD = 'payout-details-test-password-1'; // gitleaks:allow
const ADMIN_EMAIL = 'payout-details@test.dev';

const BANK_MSG =
  'bank_account_number must be 1–34 chars of digits, spaces or hyphens.';

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('player payout details (POLYCARD-BACK §4.3)', () => {
      let adminToken: string;

      beforeEach(async () => {
        const container = getContainer();
        adminToken = await mintSuperAdmin(container, api, ADMIN_EMAIL, PASSWORD);
      });

      const adminHeaders = (): Record<string, string> => ({
        authorization: `Bearer ${adminToken}`,
      });

      it('GET before any save → 200 { details: null }', async () => {
        const res = await unwrapResponse(
          api.get('/admin/customers/cust_payout_1/payout-details', {
            headers: adminHeaders(),
          }),
        );
        expect(res.status).toBe(200);
        expect(res.data.details).toBeNull();
      });

      it('POST → 200 echo, and GET round-trips the saved details', async () => {
        const cid = 'cust_payout_2';
        const body = {
          bank_name: 'Maybank',
          bank_account_number: '1234567890',
          account_holder_name: 'Ada',
        };

        const post = await unwrapResponse(
          api.post(`/admin/customers/${cid}/payout-details`, body, {
            headers: adminHeaders(),
          }),
        );
        expect(post.status).toBe(200);
        expect(post.data.details).toEqual(body);

        const get = await unwrapResponse(
          api.get(`/admin/customers/${cid}/payout-details`, {
            headers: adminHeaders(),
          }),
        );
        expect(get.status).toBe(200);
        expect(get.data.details).toEqual(body);
      });

      it('account_holder_name is optional — omitted stores null', async () => {
        const cid = 'cust_payout_3';
        const res = await unwrapResponse(
          api.post(
            `/admin/customers/${cid}/payout-details`,
            { bank_name: 'CIMB', bank_account_number: '7000 1234-5' },
            { headers: adminHeaders() },
          ),
        );
        expect(res.status).toBe(200);
        expect(res.data.details).toEqual({
          bank_name: 'CIMB',
          bank_account_number: '7000 1234-5',
          account_holder_name: null,
        });
      });

      it('second POST upserts — overwrites in place, still ONE row', async () => {
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        const cid = 'cust_payout_4';

        await unwrapResponse(
          api.post(
            `/admin/customers/${cid}/payout-details`,
            {
              bank_name: 'Maybank',
              bank_account_number: '1111111111',
              account_holder_name: 'Ada',
            },
            { headers: adminHeaders() },
          ),
        );
        const second = await unwrapResponse(
          api.post(
            `/admin/customers/${cid}/payout-details`,
            {
              bank_name: 'Public Bank',
              bank_account_number: '2222222222',
              account_holder_name: 'Grace',
            },
            { headers: adminHeaders() },
          ),
        );
        expect(second.status).toBe(200);

        const rows = await packs.listPlayerPayoutDetails({ customer_id: cid });
        expect(rows).toHaveLength(1);
        expect(rows[0].bank_name).toBe('Public Bank');
        expect(rows[0].bank_account_number).toBe('2222222222');
        expect(rows[0].account_holder_name).toBe('Grace');
      });

      it('POST → 400 on invalid bank_name / bank_account_number / holder', async () => {
        const cid = 'cust_payout_5';
        const cases: [Record<string, unknown>, string][] = [
          // bank_name: missing, blank, over 100
          [{ bank_account_number: '123' }, 'bank_name is required (1–100 chars).'],
          [
            { bank_name: '   ', bank_account_number: '123' },
            'bank_name is required (1–100 chars).',
          ],
          [
            { bank_name: 'x'.repeat(101), bank_account_number: '123' },
            'bank_name is required (1–100 chars).',
          ],
          // bank_account_number: missing, blank, over 34, illegal chars
          [{ bank_name: 'Maybank' }, BANK_MSG],
          [{ bank_name: 'Maybank', bank_account_number: '   ' }, BANK_MSG],
          [
            { bank_name: 'Maybank', bank_account_number: '1'.repeat(35) },
            BANK_MSG,
          ],
          [{ bank_name: 'Maybank', bank_account_number: 'MY12ABC' }, BANK_MSG],
          [{ bank_name: 'Maybank', bank_account_number: 12345 }, BANK_MSG],
          // holder over 100
          [
            {
              bank_name: 'Maybank',
              bank_account_number: '123',
              account_holder_name: 'x'.repeat(101),
            },
            'account_holder_name must be 100 chars or fewer.',
          ],
        ];
        for (const [body, message] of cases) {
          const res = await unwrapResponse(
            api.post(`/admin/customers/${cid}/payout-details`, body, {
              headers: adminHeaders(),
            }),
          );
          expect(res.status).toBe(400);
          expect(res.data.message).toBe(message);
        }
        // Nothing was persisted by any rejected write.
        const get = await unwrapResponse(
          api.get(`/admin/customers/${cid}/payout-details`, {
            headers: adminHeaders(),
          }),
        );
        expect(get.data.details).toBeNull();
      });

      it('POST writes an audit row that never carries the account number', async () => {
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        const cid = 'cust_payout_6';
        const accountNumber = '9876543210';

        await unwrapResponse(
          api.post(
            `/admin/customers/${cid}/payout-details`,
            {
              bank_name: 'Maybank',
              bank_account_number: accountNumber,
              account_holder_name: 'Ada',
            },
            { headers: adminHeaders() },
          ),
        );

        const [aud] = await packs.listAdminActionAudits(
          { entity_type: 'customer', entity_id: cid },
          { take: 1 },
        );
        expect(aud.action).toBe('edit');
        expect(aud.reason).toBe('payout details updated');
        // Bank details are admin-auth-only; the audit feed must not become a
        // second copy of the account number (or the holder's name).
        expect(JSON.stringify([aud.before, aud.after])).not.toContain(
          accountNumber,
        );
        expect(JSON.stringify([aud.before, aud.after])).not.toContain('Ada');
        // First save: nothing before, last4 after.
        expect(aud.before).toEqual({ bank_name: null, account_last4: null });
        expect(aud.after).toEqual({
          bank_name: 'Maybank',
          account_last4: '3210',
        });
      });

      // Without a last4 on both sides, redirecting a payout to a DIFFERENT
      // account at the SAME bank produced an audit row identical to a no-op.
      it('audits the account change via last4 on both sides', async () => {
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        const cid = 'cust_payout_7';
        const first = '1111114321';
        const second = '2222225678';

        for (const bank_account_number of [first, second]) {
          await unwrapResponse(
            api.post(
              `/admin/customers/${cid}/payout-details`,
              {
                bank_name: 'Maybank', // same bank both times
                bank_account_number,
                account_holder_name: 'Ada',
              },
              { headers: adminHeaders() },
            ),
          );
        }

        const rows = await packs.listAdminActionAudits(
          { entity_type: 'customer', entity_id: cid },
          {},
        );
        expect(rows).toHaveLength(2);
        // No ordering guarantee on the list — key off the second save's last4.
        const changeRow = rows.find(
          (r) =>
            (r.after as { account_last4?: string } | null)?.account_last4 ===
            '5678',
        );
        expect(changeRow).toBeDefined();
        expect(changeRow!.before).toEqual({
          bank_name: 'Maybank',
          account_last4: '4321',
        });
        // The full numbers still never reach the audit feed.
        const dump = JSON.stringify(rows.map((r) => [r.before, r.after]));
        expect(dump).not.toContain(first);
        expect(dump).not.toContain(second);
      });

      // bank_account_number accepts 1–34 chars, so a <=4-digit account's
      // "last4" would be the ENTIRE number. It must stay null instead.
      it('omits last4 for an account too short to redact', async () => {
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        const cid = 'cust_payout_8';
        const accountNumber = '4321';

        await unwrapResponse(
          api.post(
            `/admin/customers/${cid}/payout-details`,
            {
              bank_name: 'Maybank',
              bank_account_number: accountNumber,
              account_holder_name: null,
            },
            { headers: adminHeaders() },
          ),
        );

        const [aud] = await packs.listAdminActionAudits(
          { entity_type: 'customer', entity_id: cid },
          { take: 1 },
        );
        expect(aud.after).toEqual({
          bank_name: 'Maybank',
          account_last4: null,
        });
        expect(JSON.stringify([aud.before, aud.after])).not.toContain(
          accountNumber,
        );
      });
    });
  },
});
