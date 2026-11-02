import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { mintSuperAdmin, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

// The raw SQL behind support's same-browser and same-network flags (ADR 0016), on
// real Postgres: the upsert, the cap, the matches and the purge.

const BROWSER_A = '3f2b8c1e-7a4d-4e9a-9c11-5d6e7f8a9b0c';
const BROWSER_B = '7c1d2e3f-1a2b-4c3d-8e4f-5a6b7c8d9e0f';

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('visitor signals', () => {
      const packs = () =>
        getContainer().resolve<PacksModuleService>(PACKS_MODULE);
      const rows = (customerId: string) =>
        packs().listVisitorSignals({ customer_id: customerId });
      const newCustomer = async (email: string): Promise<string> => {
        const [customer] = await getContainer()
          .resolve(Modules.CUSTOMER)
          .createCustomers([{ email, has_account: true }]);
        return customer.id;
      };

      it('a repeat visit is one row with its hits and last seen moved', async () => {
        const c = 'cus_vs_repeat';
        const seen = { customerId: c, ip: '203.0.113.7' };
        await packs().recordVisitorSignal({ ...seen, deviceId: BROWSER_A });
        const [first] = await rows(c);
        await new Promise((r) => setTimeout(r, 20));
        await packs().recordVisitorSignal({ ...seen, deviceId: BROWSER_A });
        await packs().recordVisitorSignal({ ...seen, deviceId: null });
        await packs().recordVisitorSignal({ ...seen, deviceId: null });

        const after = await rows(c);
        expect(after).toHaveLength(2);
        const withBrowser = after.find((r) => r.device_id === BROWSER_A);
        expect(withBrowser?.hits).toBe(2);
        expect(new Date(withBrowser!.last_seen_at).getTime()).toBeGreaterThan(
          new Date(first.last_seen_at).getTime(),
        );
        expect(after.find((r) => r.device_id === '')?.hits).toBe(2);
      });

      it('stops adding rows at the cap, without failing', async () => {
        const c = 'cus_vs_cap';
        for (let i = 0; i < 205; i++) {
          await packs().recordVisitorSignal({
            customerId: c,
            ip: `10.0.${Math.floor(i / 250)}.${i % 250}`,
            deviceId: null,
          });
        }
        expect(await rows(c)).toHaveLength(200);
      });

      it('matches on browser and network, not on itself or on unsigned', async () => {
        const ids = {
          a: 'cus_vs_a',
          b: 'cus_vs_b',
          c: 'cus_vs_c',
          d: 'cus_vs_d',
        };
        const record = (
          customerId: string,
          ip: string,
          deviceId: string | null,
        ) => packs().recordVisitorSignal({ customerId, ip, deviceId });
        await record(ids.a, '198.51.100.1', BROWSER_A);
        await record(ids.b, '198.51.100.1', BROWSER_A);
        await record(ids.c, '198.51.100.1', BROWSER_B);
        await record(ids.a, 'unsigned', null);
        await record(ids.d, 'unsigned', null);

        const a = await packs().visitorSignalMatches(ids.a);
        expect(a.recorded).toBe(true);
        expect(a.unsigned).toBe(true);
        expect(a.device.map((d) => d.customer_id)).toEqual([ids.b]);
        expect(a.device_total).toBe(1);
        expect(a.ip).toEqual([
          expect.objectContaining({ ip: '198.51.100.1', accounts: 2 }),
        ]);
        expect(a.ip[0].customer_ids.sort()).toEqual([ids.b, ids.c].sort());
        expect(a.ip_total).toBe(1);

        const d = await packs().visitorSignalMatches(ids.d);
        expect(d.unsigned).toBe(true);
        expect(d.ip).toEqual([]);

        const none = await packs().visitorSignalMatches('cus_vs_nobody');
        expect(none).toMatchObject({ recorded: false, unsigned: false });
      });

      it('a crowded network counts everyone and names ten', async () => {
        const ip = '198.51.100.2';
        await packs().recordVisitorSignal({
          customerId: 'cus_vs_crowd',
          ip,
          deviceId: null,
        });
        for (let i = 0; i < 25; i++) {
          await packs().recordVisitorSignal({
            customerId: `cus_vs_crowd_${i}`,
            ip,
            deviceId: null,
          });
        }
        const out = await packs().visitorSignalMatches('cus_vs_crowd');
        expect(out.ip[0].accounts).toBe(25);
        expect(out.ip[0].customer_ids).toHaveLength(10);
      });

      it('purges past 180 days and rows of a deleted customer, and keeps the rest', async () => {
        const live = await newCustomer('vs-live@test.dev');
        const gone = await newCustomer('vs-gone@test.dev');
        await packs().recordVisitorSignal({
          customerId: live,
          ip: '198.51.100.3',
          deviceId: null,
        });
        await packs().recordVisitorSignal({
          customerId: gone,
          ip: '198.51.100.3',
          deviceId: null,
        });
        await getContainer()
          .resolve(Modules.CUSTOMER)
          .softDeleteCustomers([gone]);
        await packs().createVisitorSignals([
          {
            customer_id: 'cus_vs_old',
            ip: '198.51.100.4',
            first_seen_at: new Date(Date.now() - 181 * 86400_000),
            last_seen_at: new Date(Date.now() - 181 * 86400_000),
          },
          {
            customer_id: 'cus_vs_keep',
            ip: '198.51.100.5',
            first_seen_at: new Date(Date.now() - 179 * 86400_000),
            last_seen_at: new Date(Date.now() - 179 * 86400_000),
          },
        ]);

        await packs().purgeVisitorSignals();

        expect(await rows('cus_vs_old')).toEqual([]);
        expect(await rows('cus_vs_keep')).toHaveLength(1);
        expect(await rows(gone)).toEqual([]);
        expect(await rows(live)).toHaveLength(1);
      });

      it('the admin route answers, and a matching view leaves a trail without the address', async () => {
        const adminToken = await mintSuperAdmin(
          getContainer(),
          api,
          'vs-admin@test.dev',
          'vs-test-password-1',
        );
        const a = await newCustomer('vs-a@test.dev');
        const b = await newCustomer('vs-b@test.dev');
        for (const customerId of [a, b]) {
          await packs().recordVisitorSignal({
            customerId,
            ip: '198.51.100.6',
            deviceId: BROWSER_B,
          });
        }
        const res = await unwrapResponse(
          api.get(`/admin/customers/${a}/visitor-signals`, {
            headers: { authorization: `Bearer ${adminToken}` },
          }),
        );
        expect(res.status).toBe(200);
        expect(
          res.data.device.map((d: { customer_id: string }) => d.customer_id),
        ).toEqual([b]);
        expect(res.data.ip[0].ip).toBe('198.51.100.6');
        const audits = await packs().listAdminActionAudits({
          entity_id: a,
          action: 'reveal',
        });
        expect(audits).toHaveLength(1);
        expect(JSON.stringify(audits)).not.toContain('198.51.100.6');
      });
    });
  },
});
