import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import type { ICustomerModuleService } from '@medusajs/framework/types';
import { mintSuperAdmin, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

// POST /admin/players — the dashboard's "Create player". What only a booted app
// can prove: the minted credentials pass core's own login route, the session
// resolves to the created customer (identity linked, not orphaned), and the
// player holds exactly the chosen group — the customer.created subscriber
// must NOT have raced a DEFAULT membership in beside it.

const PASSWORD = 'players-create-admin-password-1'; // gitleaks:allow
const ADMIN_EMAIL = 'players-create-admin@test.dev';
// Mixed case on purpose: the route lowercases before every write.
const PLAYER_EMAIL = 'Partner-Abc123@test.dev';
const PLAYER_PASSWORD = 'players-create-player-password-1'; // gitleaks:allow
const GROUP_NAME = 'Players Create Partners';

const jwtActor = (token: string): string =>
  JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).actor_id;

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('POST /admin/players', () => {
      let adminToken: string;
      let groupId: string;

      const adminHeaders = (): Record<string, string> => ({
        authorization: `Bearer ${adminToken}`,
      });
      const customers = (): ICustomerModuleService =>
        getContainer().resolve<ICustomerModuleService>(Modules.CUSTOMER);
      const create = (body: Record<string, unknown>) =>
        unwrapResponse(
          api.post('/admin/players', body, { headers: adminHeaders() }),
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

      it('mints a player who can log in, in exactly the chosen group', async () => {
        const res = await create({
          email: PLAYER_EMAIL,
          password: PLAYER_PASSWORD,
          group_id: groupId,
        });
        expect(res.status).toBe(201);
        const { player } = res.data;
        expect(player.email).toBe(PLAYER_EMAIL.toLowerCase());
        expect(player.group).toEqual({ id: groupId, name: GROUP_NAME });

        // The credentials pass core's login route — the whole point — and the
        // token names THIS customer, so the identity is linked, not orphaned.
        const login = await unwrapResponse(
          api.post('/auth/customer/emailpass', {
            email: player.email,
            password: PLAYER_PASSWORD,
          }),
        );
        expect(login.status).toBe(200);
        expect(jwtActor(login.data.token)).toBe(player.id);

        // One membership, the chosen one: no DEFAULT beside it.
        const groups = await customers().listCustomerGroups({
          customers: player.id,
        });
        expect(groups.map((g) => g.id)).toEqual([groupId]);

        // And the Players list shows the row with the group named.
        const list = await unwrapResponse(
          api.get('/admin/players?q=partner-abc123', {
            headers: adminHeaders(),
          }),
        );
        expect(list.status).toBe(200);
        expect(list.data.players).toHaveLength(1);
        expect(list.data.players[0]).toMatchObject({
          id: player.id,
          email: player.email,
          groups: [GROUP_NAME],
          partner: 'group',
        });
      });

      it('lands in DEFAULT without group_id and refuses a reused email', async () => {
        const first = await create({
          email: 'second-player@test.dev',
          password: PLAYER_PASSWORD,
        });
        expect(first.status).toBe(201);
        expect(first.data.player.group.name).toBe('DEFAULT');

        // Case-insensitive: the same mailbox, differently typed.
        const dup = await create({
          email: 'SECOND-player@test.dev',
          password: PLAYER_PASSWORD,
        });
        expect(dup.status).toBe(422);
        expect(
          await customers().listCustomers({ email: 'second-player@test.dev' }),
        ).toHaveLength(1);
      });

      it('400s a bad body and 404s an unknown group, writing nothing', async () => {
        expect(
          (await create({ email: 'nope', password: PLAYER_PASSWORD })).status,
        ).toBe(400);
        expect(
          (await create({ email: 'short@test.dev', password: 'short' })).status,
        ).toBe(400);
        expect(
          (
            await create({
              email: 'nogroup@test.dev',
              password: PLAYER_PASSWORD,
              group_id: 'cgrp_missing',
            })
          ).status,
        ).toBe(404);
        expect(
          await customers().listCustomers({ email: 'nogroup@test.dev' }),
        ).toHaveLength(0);
        // No identity either: a later create with this email must succeed.
        const later = await create({
          email: 'nogroup@test.dev',
          password: PLAYER_PASSWORD,
        });
        expect(later.status).toBe(201);
      });
    });
  },
});
