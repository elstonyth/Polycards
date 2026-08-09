import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { mintSuperAdmin, postStoreCustomer, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

const PASSWORD = 'adjust-audit-test-password-1';
const ADMIN_EMAIL = 'adjust-audit-admin@test.dev';

// Credit adjustment audit: every admin credit adjustment must atomically write
// an admin_action_audit row with the server-derived actor_id — never from the
// request body. This file tests the new audit path; the original credit-adjust
// behaviour (balance moves, validation, 401, etc.) lives in credit-adjust.spec.ts.

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('admin credit adjustment — audit trail', () => {
      let adminToken: string;
      let storeHeaders: Record<string, string>;

      beforeEach(async () => {
        const container = getContainer();
        const apiKeyModule = container.resolve(Modules.API_KEY);
        const key = await apiKeyModule.createApiKeys({
          title: 'adjust-audit-test',
          type: 'publishable',
          created_by: 'adjust-audit-test',
        });
        storeHeaders = { 'x-publishable-api-key': key.token };
        adminToken = await mintSuperAdmin(container, api, ADMIN_EMAIL, PASSWORD);
      });

      const adminHeaders = (): Record<string, string> => ({
        authorization: `Bearer ${adminToken}`,
      });

      const registerCustomer = async (
        email: string,
      ): Promise<{ token: string; id: string }> => {
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
        const login = await api.post('/auth/customer/emailpass', {
          email,
          password: PASSWORD,
        });
        return { token: login.data.token, id: created.data.customer.id };
      };

      it('an admin credit adjustment writes an audit row with the server-derived admin_id', async () => {
        const { id: cid } = await registerCustomer(
          'adjust-audit-customer-a@test.dev',
        );
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        // Unique note scopes this assertion to its own audit row (entity_id stores
        // the credit-transaction id, not the customer id, so filtering by entity_id
        // would match nothing — filter by reason/note instead).
        const note = 'goodwill-adjust-audit-a';

        const res = await unwrapResponse(
          api.post(
            `/admin/customers/${cid}/credits`,
            { amount: 5, note },
            { headers: adminHeaders() },
          ),
        );
        expect(res.status).toBe(200);
        expect(res.data).toMatchObject({ amount: 5, balance: 5 });

        const [aud] = await packs.listAdminActionAudits(
          { entity_type: 'credit', action: 'adjust_credit', reason: note },
          { take: 1, order: { created_at: 'DESC' } },
        );
        expect(aud).toBeDefined();
        expect(aud.admin_id).toBeTruthy(); // from the session, not the body
        expect(aud.reason).toBe(note);
        expect(aud.entity_type).toBe('credit');
        expect(aud.action).toBe('adjust_credit');

        // Cross-check (POLYCARD-BACK Epic 4 Task 5): the AD ledger row and
        // this audit row describe the SAME event from two angles — join on
        // ref_id/entity_id (both are the credit_transaction id) and confirm
        // they carry the same reason/note text, so a reviewer can cross-check
        // either view.
        const [ledgerRow] = await packs.listLedgerEntries(
          { type: 'AD', ref_id: aud.entity_id },
          { take: 1 },
        );
        expect(ledgerRow).toBeDefined();
        expect((ledgerRow.payload as { reason: string } | null)?.reason).toBe(
          aud.reason,
        );
      });

      it('audit admin_id is not taken from the request body', async () => {
        const { id: cid } = await registerCustomer(
          'adjust-audit-customer-b@test.dev',
        );
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        // Unique note scopes this assertion to its own audit row.
        const note = 'injection-attempt-adjust-audit-b';

        const res = await unwrapResponse(
          api.post(
            `/admin/customers/${cid}/credits`,
            // Attempt to inject a fake admin_id via the body — must be ignored
            { amount: 3, note, admin_id: 'evil_fake_id' },
            { headers: adminHeaders() },
          ),
        );
        expect(res.status).toBe(200);

        const [aud] = await packs.listAdminActionAudits(
          { entity_type: 'credit', action: 'adjust_credit', reason: note },
          { take: 1, order: { created_at: 'DESC' } },
        );
        expect(aud.admin_id).not.toBe('evil_fake_id');
        expect(aud.admin_id).toBeTruthy();
      });
    });
  },
});
