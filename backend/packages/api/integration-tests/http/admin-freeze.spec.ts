import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { mintSuperAdmin, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

const PASSWORD = 'admin-freeze-test-password-1';
const ADMIN_EMAIL = 'admin-freeze@test.dev';

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('manual freeze / unfreeze', () => {
      let adminToken: string;

      beforeEach(async () => {
        const container = getContainer();
        adminToken = await mintSuperAdmin(container, api, ADMIN_EMAIL, PASSWORD);
      });

      const adminHeaders = (): Record<string, string> => ({
        authorization: `Bearer ${adminToken}`,
      });

      // ------------------------------------------------------------------ service layer

      it('setManualFreeze: creates state frozen=true, cause=manual, frozen_by=adminId; writes audit row', async () => {
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        const cid = 'cust_mf_1';

        await packs.setManualFreeze({ customerId: cid, adminId: 'admin_a', reason: 'fraud review' });

        const [s] = await packs.listCustomerAccountStates({ customer_id: cid }, { take: 1 });
        expect(s.frozen).toBe(true);
        expect(s.cause).toBe('manual');
        expect(s.frozen_by).toBe('admin_a');

        const [aud] = await packs.listAdminActionAudits({ entity_id: cid, action: 'freeze' }, { take: 1 });
        expect(aud.admin_id).toBe('admin_a');
        expect(aud.reason).toBe('fraud review');
      });

      it('setManualFreeze escalates: AUTO-frozen → cause becomes manual (sticky override)', async () => {
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        const cid = 'cust_mf_2';

        // Seed an existing AUTO freeze.
        await packs.createCustomerAccountStates([
          { customer_id: cid, frozen: true, cause: 'auto', frozen_reason: 'clawback:open_x' },
        ]);

        await packs.setManualFreeze({ customerId: cid, adminId: 'admin_b', reason: 'escalate to manual' });

        const [s] = await packs.listCustomerAccountStates({ customer_id: cid }, { take: 1 });
        expect(s.frozen).toBe(true);
        expect(s.cause).toBe('manual');
        expect(s.frozen_by).toBe('admin_b');
      });

      it('clearManualFreeze: sets frozen=false, unfreeze_cause=admin; writes audit row', async () => {
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        const cid = 'cust_mf_3';

        await packs.setManualFreeze({ customerId: cid, adminId: 'admin_a', reason: 'test freeze' });
        await packs.clearManualFreeze({ customerId: cid, adminId: 'admin_a', reason: 'cleared' });

        const [s2] = await packs.listCustomerAccountStates({ customer_id: cid }, { take: 1 });
        expect(s2.frozen).toBe(false);
        expect(s2.unfreeze_cause).toBe('admin');

        const [aud] = await packs.listAdminActionAudits({ entity_id: cid, action: 'unfreeze' }, { take: 1 });
        expect(aud.admin_id).toBe('admin_a');
        expect(aud.reason).toBe('cleared');
      });

      it('full round-trip: freeze, check audit, unfreeze, check audit (brief canonical test)', async () => {
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        const cid = 'cust_mf_rt';

        await packs.setManualFreeze({ customerId: cid, adminId: 'admin_a', reason: 'fraud review' });
        const [s] = await packs.listCustomerAccountStates({ customer_id: cid }, { take: 1 });
        expect(s.frozen).toBe(true);
        expect(s.cause).toBe('manual');
        expect(s.frozen_by).toBe('admin_a');
        const [aud] = await packs.listAdminActionAudits({ entity_id: cid, action: 'freeze' }, { take: 1 });
        expect(aud.admin_id).toBe('admin_a');
        expect(aud.reason).toBe('fraud review');

        await packs.clearManualFreeze({ customerId: cid, adminId: 'admin_a', reason: 'cleared' });
        const [s2] = await packs.listCustomerAccountStates({ customer_id: cid }, { take: 1 });
        expect(s2.frozen).toBe(false);
        expect(s2.unfreeze_cause).toBe('admin');
      });

      // ------------------------------------------------------------------ route layer

      it('POST /admin/customers/:id/freeze → 401 without auth', async () => {
        const res = await unwrapResponse(
          api.post('/admin/customers/cust_route_1/freeze', { reason: 'test' }),
        );
        expect(res.status).toBe(401);
      });

      it('POST /admin/customers/:id/unfreeze → 401 without auth', async () => {
        const res = await unwrapResponse(
          api.post('/admin/customers/cust_route_1/unfreeze', { reason: 'test' }),
        );
        expect(res.status).toBe(401);
      });

      // Proves the cross-origin write guard is WIRED, not just correct. The unit
      // spec (src/api/utils/__tests__/admin-origin-guard.unit.spec.ts) covers the
      // function; what silently breaks is the middlewares.ts entry, and only a
      // booted app can catch that.
      //
      // Second layer behind medusa-config.ts's `cookieOptions: { sameSite: 'lax' }`
      // — the real fix for the admin-CSRF finding, which no test can observe (the
      // attribute is set by the framework's express-loader at boot, and these
      // suites authenticate with a bearer token).
      it('POST /admin/customers/:id/freeze → refused when Origin is foreign, even WITH valid admin auth', async () => {
        // ADMIN_CORS is unset in the test env and the guard fails OPEN on an empty
        // allowlist by design (see its docblock), so set one. It is read PER
        // REQUEST, so this takes effect on an already-booted app.
        const prior = process.env.ADMIN_CORS;
        process.env.ADMIN_CORS = 'https://admin.polycards.gg';
        try {
          const forged = await unwrapResponse(
            api.post(
              '/admin/customers/cust_route_csrf/freeze',
              { reason: 'forged' },
              { headers: { ...adminHeaders(), origin: 'https://attacker.example' } },
            ),
          );
          expect(forged.status).toBe(400);

          // Nothing was written — the refusal lands before the handler.
          const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
          expect(
            await packs.listCustomerAccountStates({ customer_id: 'cust_route_csrf' }, { take: 1 }),
          ).toHaveLength(0);

          // The other direction: the real dashboard origin still works, so this is
          // a gate and not a blanket refusal.
          const legit = await unwrapResponse(
            api.post(
              '/admin/customers/cust_route_csrf/freeze',
              { reason: 'legit' },
              { headers: { ...adminHeaders(), origin: 'https://admin.polycards.gg' } },
            ),
          );
          expect(legit.status).toBe(200);
        } finally {
          if (prior === undefined) delete process.env.ADMIN_CORS;
          else process.env.ADMIN_CORS = prior;
        }
      });

      it('POST /admin/customers/:id/freeze → 400 when reason is missing', async () => {
        const res = await unwrapResponse(
          api.post('/admin/customers/cust_route_2/freeze', {}, { headers: adminHeaders() }),
        );
        expect(res.status).toBe(400);
      });

      it('POST /admin/customers/:id/freeze → 400 when reason is blank', async () => {
        const res = await unwrapResponse(
          api.post('/admin/customers/cust_route_3/freeze', { reason: '   ' }, { headers: adminHeaders() }),
        );
        expect(res.status).toBe(400);
      });

      it('POST /admin/customers/:id/freeze → 400 when reason exceeds 500 chars', async () => {
        const res = await unwrapResponse(
          api.post(
            '/admin/customers/cust_route_4/freeze',
            { reason: 'x'.repeat(501) },
            { headers: adminHeaders() },
          ),
        );
        expect(res.status).toBe(400);
      });

      it('POST /admin/customers/:id/freeze → 200 and frozen=true with valid auth+reason; admin_id from session NOT body', async () => {
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        const cid = 'cust_route_5';

        const res = await unwrapResponse(
          api.post(
            `/admin/customers/${cid}/freeze`,
            { reason: 'route test', admin_id: 'FORGED_ID' },
            { headers: adminHeaders() },
          ),
        );
        expect(res.status).toBe(200);
        expect(res.data.frozen).toBe(true);

        // The audit must use the session actor, not the forged admin_id in the body.
        const [aud] = await packs.listAdminActionAudits({ entity_id: cid, action: 'freeze' }, { take: 1 });
        expect(aud.admin_id).not.toBe('FORGED_ID');
        expect(aud.admin_id).toBeTruthy(); // server-derived actor
      });

      it('POST /admin/customers/:id/unfreeze → 200 and frozen=false with valid auth+reason', async () => {
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        const cid = 'cust_route_6';

        // Freeze first via service.
        await packs.setManualFreeze({ customerId: cid, adminId: 'admin_setup', reason: 'setup' });

        const res = await unwrapResponse(
          api.post(
            `/admin/customers/${cid}/unfreeze`,
            { reason: 'route unfreeze test' },
            { headers: adminHeaders() },
          ),
        );
        expect(res.status).toBe(200);
        expect(res.data.frozen).toBe(false);
      });
    });
  },
});
