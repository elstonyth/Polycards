import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import type { ICustomerModuleService } from '@medusajs/framework/types';
import { mintSuperAdmin, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

// POST /admin/players + GET /admin/players/export — the partner account
// generator. What only a booted app can prove: the generated credentials pass
// core's own login route, the session resolves to the created customer
// (identity linked, not orphaned), each account holds exactly the chosen
// group (the customer.created subscriber must NOT have raced a DEFAULT
// membership in beside it), display names obey the username invariant, and
// the export serves a real workbook of what was minted.

const PASSWORD = 'players-create-admin-password-1'; // gitleaks:allow
const ADMIN_EMAIL = 'players-create-admin@test.dev';
const GROUP_NAME = 'Players Create Partners';
const EMAIL_RE =
  /^partner-[abcdefghijkmnpqrstuvwxyz23456789]{6}@polycards\.gg$/;
const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const jwtActor = (token: string): string =>
  JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).actor_id;

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('partner account generator', () => {
      let adminToken: string;
      let groupId: string;

      const adminHeaders = (): Record<string, string> => ({
        authorization: `Bearer ${adminToken}`,
      });
      const customers = (): ICustomerModuleService =>
        getContainer().resolve<ICustomerModuleService>(Modules.CUSTOMER);
      const generate = (body: Record<string, unknown>) =>
        unwrapResponse(
          api.post('/admin/players', body, { headers: adminHeaders() }),
        );
      // arraybuffer is load-bearing (inventory-export.spec): without it axios
      // decodes the zip as text and the PK check passes on garbage.
      const exportXlsx = (qs = '') =>
        unwrapResponse(
          api.get(`/admin/players/export${qs}`, {
            headers: adminHeaders(),
            responseType: 'arraybuffer',
          }),
        );

      beforeEach(async () => {
        adminToken = await mintSuperAdmin(
          getContainer(),
          api,
          ADMIN_EMAIL,
          PASSWORD,
        );
        const group = await customers().createCustomerGroups({
          name: GROUP_NAME,
          metadata: { partner_rate_bp: 400 },
        });
        groupId = group.id;
      });

      it('mints a batch that can log in, each in exactly the chosen group', async () => {
        const res = await generate({ count: 2, group_id: groupId });
        expect(res.status).toBe(201);
        const { players } = res.data;
        expect(players).toHaveLength(2);
        expect(new Set(players.map((p: any) => p.email)).size).toBe(2);
        for (const p of players) {
          expect(p.email).toMatch(EMAIL_RE);
          expect(p.password).toHaveLength(16);
          expect(p.name).toMatch(/^Collector\d{4}$/);
          expect(p.group).toBe(GROUP_NAME);
        }

        // The credentials pass core's login route — the whole point — and the
        // token names THIS customer, so the identity is linked, not orphaned.
        const [first] = players;
        const login = await unwrapResponse(
          api.post('/auth/customer/emailpass', {
            email: first.email,
            password: first.password,
          }),
        );
        expect(login.status).toBe(200);
        expect(jwtActor(login.data.token)).toBe(first.id);

        // One membership, the chosen one: no DEFAULT beside it.
        const groups = await customers().listCustomerGroups({
          customers: first.id,
        });
        expect(groups.map((g) => g.id)).toEqual([groupId]);

        // The Players list shows the row with the group and partner badge.
        const list = await unwrapResponse(
          api.get(`/admin/players?q=${encodeURIComponent(first.email)}`, {
            headers: adminHeaders(),
          }),
        );
        expect(list.data.players).toHaveLength(1);
        expect(list.data.players[0]).toMatchObject({
          id: first.id,
          name: first.name,
          groups: [GROUP_NAME],
          partner: 'group',
        });
      });

      it('gives a typed name to the first account, numbered variants to the rest, and refuses a taken one', async () => {
        const res = await generate({ count: 2, display_name: 'AdaPartner' });
        expect(res.status).toBe(201);
        const names = res.data.players.map((p: any) => p.name);
        expect(names[0]).toBe('AdaPartner');
        expect(names[1]).toMatch(/^AdaPartner\d{4}$/);
        // DEFAULT when no group is given.
        expect(res.data.players[0].group).toBe('DEFAULT');

        // Case-insensitive, the username invariant.
        const dup = await generate({ display_name: 'adapartner' });
        expect(dup.status).toBe(422);
        const bad = await generate({ display_name: 'has space' });
        expect(bad.status).toBe(400);
      });

      it('400s a bad count and 404s an unknown group, minting nothing', async () => {
        const before = (await customers().listCustomers({ has_account: true }))
          .length;
        expect((await generate({ count: 0 })).status).toBe(400);
        expect((await generate({ count: 51 })).status).toBe(400);
        expect((await generate({ group_id: 'cgrp_missing' })).status).toBe(404);
        const after = (await customers().listCustomers({ has_account: true }))
          .length;
        expect(after).toBe(before);
      });

      it('exports the generated accounts as a real .xlsx, all or one batch', async () => {
        const a = await generate({ count: 2, group_id: groupId });
        const b = await generate({ count: 1 });
        const ids = a.data.players.map((p: any) => p.id);

        const all = await exportXlsx();
        expect(all.status).toBe(200);
        expect(all.headers['content-type']).toBe(XLSX_MIME);
        expect(all.headers['content-disposition']).toMatch(
          /^attachment; filename="partner-accounts-\d{4}-\d{2}-\d{2}\.xlsx"$/,
        );
        const body = Buffer.from(all.data);
        expect(body.subarray(0, 2).toString('latin1')).toBe('PK');
        // 3 rows of credentials is well past an empty workbook.
        expect(body.length).toBeGreaterThan(2000);

        const batch = await exportXlsx(`?ids=${ids.join(',')}`);
        expect(batch.status).toBe(200);
        expect(Buffer.from(batch.data).length).toBeLessThan(body.length);

        expect((await exportXlsx('?ids=')).status).toBe(400);
        void b;
      });
    });
  },
});
