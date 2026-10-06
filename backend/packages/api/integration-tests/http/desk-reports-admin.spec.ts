import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { DESK_BOT_ROLE } from '../../src/api/reports/admin/proxy';
import { mintSuperAdmin, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

// The desk bots' read-only admin proxy (GET /reports/admin/read): any desk
// key reads any admin dashboard screen, through a minted token whose only role
// is "Desk bots (read-only)" (*:read), GET only, with the sensitive screens
// blocked.
const STORE_KEY = 's'.repeat(48);
process.env.REPORT_KEY_STORE = STORE_KEY;
process.env.DESK_REPORTS_RATE_BURST_LIMIT = '1000';
process.env.DESK_REPORTS_RATE_LIMIT = '6000';
const DAY_MS = 24 * 60 * 60 * 1000;

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    const packs = () =>
      getContainer().resolve<PacksModuleService>(PACKS_MODULE);
    const read = (path: string, extra = '', key: string | null = STORE_KEY) =>
      unwrapResponse(
        api.get(
          `/reports/admin/read?path=${encodeURIComponent(path)}${extra}`,
          { headers: key ? { 'x-report-key': key } : {} },
        ),
      );

    describe('GET /reports/admin/read', () => {
      let adminToken: string;

      beforeEach(async () => {
        adminToken = await mintSuperAdmin(
          getContainer(),
          api,
          'proxy-admin@test.dev',
          'proxy-admin-pw-1',
        );
        await packs().createChallengeSchedules([
          {
            starts_at: new Date(Date.now() + 2 * DAY_MS),
            label: 'Next week',
            // A json column: the model types it as a record.
            stages: [
              {
                stage_number: 1,
                threshold_myr: 1000,
                rank_rewards: [{ rank: 1, card_id: null, credits: 500 }],
              },
            ] as unknown as Record<string, unknown>,
          },
        ]);
      });

      it('answers exactly what the admin dashboard gets, for a desk key', async () => {
        const direct = await api.get('/admin/challenge/schedule', {
          headers: { authorization: `Bearer ${adminToken}` },
        });
        const res = await read('/admin/challenge/schedule');
        expect(res.status).toBe(200);
        expect(res.data).toEqual({ truncated: false, data: direct.data });
        expect(JSON.stringify(res.data)).toContain('Next week');
      });

      it('reads core admin screens through a read-only role', async () => {
        const res = await read('/admin/customers', '&limit=1');
        expect(res.status).toBe(200);
        expect(res.data.data).toHaveProperty('customers');
        // The role the token carries holds one policy: read, on everything.
        const rbac = getContainer().resolve(Modules.RBAC);
        const [role] = await rbac.listRbacRoles({ name: DESK_BOT_ROLE });
        expect(role).toBeDefined();
        const links = await rbac.listRbacRolePolicies({ role_id: role.id });
        const policies = await rbac.listRbacPolicies({
          id: links.map((l: { policy_id: string }) => l.policy_id),
        });
        expect(
          policies.map(
            (p: { resource: string; operation: string }) =>
              `${p.resource}:${p.operation}`,
          ),
        ).toEqual(['*:read']);
      });

      it('hides passwords and shows bank numbers whole', async () => {
        const customers = getContainer().resolve(Modules.CUSTOMER);
        const customer = await customers.createCustomers({
          email: 'partner@test.dev',
          phone: '+60123456789',
          metadata: {
            handle: 'partner-ace',
            partner_credential: { password: 'Sup3r-secret-pw', issued_at: 'x' },
            bank_accounts: [
              {
                id: 'ba_1',
                bankName: 'Maybank',
                accountNumber: '5550 0012 3456',
              },
            ],
          },
        });
        // %2B is "+": metadata on top of the screen's default fields.
        const res = await read(
          `/admin/customers/${customer.id}`,
          '&fields=%2Bmetadata',
        );
        expect(res.status).toBe(200);
        const text = JSON.stringify(res.data);
        expect(text).not.toContain('Sup3r-secret-pw');
        expect(res.data.data.customer).toMatchObject({
          email: 'partner@test.dev',
          phone: '+60123456789',
          metadata: {
            handle: 'partner-ace',
            partner_credential: '[hidden]',
            bank_accounts: [
              { bankName: 'Maybank', accountNumber: '5550 0012 3456' },
            ],
          },
        });
      });

      it('refuses blocked screens, bad paths and callers without a key', async () => {
        for (const path of [
          '/admin/invites',
          '/admin/INVITES',
          '/admin/api-keys',
          '/admin/inventory/export.xlsx',
          '/admin/pricecharting/search',
        ]) {
          const res = await read(path);
          expect(res.status).toBe(403);
          expect(JSON.stringify(res.data)).toMatch(/not open to the desk bots/);
        }
        for (const path of ['/store/customers', '/admin/../store/x', '']) {
          expect((await read(path)).status).toBe(400);
        }
        expect((await read('/admin/customers', '', null)).status).toBe(401);
      });

      // 2026-10-04: an undeclared `*:read` was soft-deleted by the next
      // boot's policy sync, and every core screen then refused the bots
      // ("Required policies: customer:read") until this was found.
      it('keeps core screens open across the boot-time policy sync, and heals a deleted policy', async () => {
        expect((await read('/admin/customers', '&limit=1')).status).toBe(200);
        const rbac = getContainer().resolve(Modules.RBAC) as unknown as {
          syncRegisteredPolicies(): Promise<void>;
          listRbacPolicies(f: object): Promise<{ id: string }[]>;
          softDeleteRbacPolicies(ids: string[]): Promise<void>;
        };
        // What every boot runs: soft-delete each policy nothing declares.
        await rbac.syncRegisteredPolicies();
        const live = await rbac.listRbacPolicies({ key: '*:read' });
        expect(live).toHaveLength(1);
        expect((await read('/admin/customers', '&limit=1')).status).toBe(200);

        // Deleted anyway (by hand, or by an older build): the next read
        // restores it instead of failing.
        await rbac.softDeleteRbacPolicies([live[0].id]);
        expect(await rbac.listRbacPolicies({ key: '*:read' })).toHaveLength(0);
        expect((await read('/admin/customers', '&limit=1')).status).toBe(200);
        expect(await rbac.listRbacPolicies({ key: '*:read' })).toHaveLength(1);
      });

      // Open since 2026-10-06 (the owner: "just give it everything").
      it('opens the staff list and the full bank number screens', async () => {
        const users = await read('/admin/users');
        expect(users.status).toBe(200);
        expect(JSON.stringify(users.data)).toContain('proxy-admin@test.dev');
        // Not blocked any more: an unknown row is the screen's own 404.
        expect(
          (await read('/admin/payments/withdrawals/wd_none/account')).status,
        ).toBe(404);
        const customers = getContainer().resolve(Modules.CUSTOMER);
        const customer = await customers.createCustomers({
          email: 'payout@test.dev',
        });
        const details = await read(
          `/admin/customers/${customer.id}/payout-details`,
        );
        expect(details.status).toBe(200);
      });

      it('relays an admin error instead of hiding it', async () => {
        const res = await read('/admin/packs/no-such-pack');
        expect(res.status).toBe(404);
      });
    });
  },
});
