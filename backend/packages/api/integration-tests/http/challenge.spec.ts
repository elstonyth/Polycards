import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { mintSuperAdmin, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

const PASSWORD = 'challenge-test-pw-1';
const ADMIN_EMAIL = 'challenge-admin@test.dev';

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('/admin/challenge', () => {
      let adminToken: string;
      let cardId: string;
      const packs = () =>
        getContainer().resolve<PacksModuleService>(PACKS_MODULE);
      const adminHeaders = (): Record<string, string> => ({
        authorization: `Bearer ${adminToken}`,
      });

      beforeEach(async () => {
        const container = getContainer();
        adminToken = await mintSuperAdmin(container, api, ADMIN_EMAIL, PASSWORD);
        // Seed one card so the existence check has something to accept.
        const [card] = await packs().createCards([
          {
            handle: `challenge-card-${Date.now()}`,
            name: 'Test Card',
            set: 'Base',
            grader: 'PSA',
            grade: '10',
            market_value: 1,
            image: '/c.png',
          },
        ]);
        cardId = card.id;
      });

      it('401s without an admin token', async () => {
        expect(
          (await unwrapResponse(api.get('/admin/challenge/settings'))).status,
        ).toBe(401);
        expect(
          (
            await unwrapResponse(
              api.post('/admin/challenge/stages', { stages: [], reason: 'x' }),
            )
          ).status,
        ).toBe(401);
      });

      it('GET settings returns §4.1 defaults before first save', async () => {
        const res = await unwrapResponse(
          api.get('/admin/challenge/settings', { headers: adminHeaders() }),
        );
        expect(res.status).toBe(200);
        expect(res.data).toEqual({
          cadence: 'fixed_weekly',
          timezone: 'Asia/Kuala_Lumpur',
          reset_day: 1,
          reset_hour: 0,
          payout_credits: 0,
          payout_card_ids: [],
        });
      });

      it('POST stages: empty list is valid (challenge disabled)', async () => {
        const res = await unwrapResponse(
          api.post(
            '/admin/challenge/stages',
            { stages: [], reason: 'disable' },
            { headers: adminHeaders() },
          ),
        );
        expect(res.status).toBe(200);
        expect(res.data.stages).toEqual([]);
        expect(await packs().listChallengeStages({}, { take: 10 })).toHaveLength(0);
      });

      it('POST stages: happy path persists + writes one audit row', async () => {
        const res = await unwrapResponse(
          api.post(
            '/admin/challenge/stages',
            {
              stages: [
                { stage_number: 1, threshold_myr: 100, reward_credits: 10, reward_card_ids: [cardId] },
                { stage_number: 2, threshold_myr: 200, reward_credits: 20, reward_card_ids: [] },
              ],
              reason: 'configure stages',
            },
            { headers: adminHeaders() },
          ),
        );
        expect(res.status).toBe(200);
        expect(res.data.stages).toHaveLength(2);
        expect(await packs().listChallengeStages({}, { take: 10 })).toHaveLength(2);

        const audits = await packs().listAdminActionAudits(
          { entity_type: 'challenge_stages', action: 'replace' },
          { take: 10 },
        );
        expect(audits).toHaveLength(1);
        expect(audits[0].reason).toBe('configure stages');
      });

      it('POST stages: unknown featured card id → 400, nothing written', async () => {
        const res = await unwrapResponse(
          api.post(
            '/admin/challenge/stages',
            {
              stages: [
                { stage_number: 1, threshold_myr: 100, reward_credits: 10, reward_card_ids: ['card_does_not_exist'] },
              ],
              reason: 'bad card',
            },
            { headers: adminHeaders() },
          ),
        );
        expect(res.status).toBe(400);
        expect(String(res.data.message)).toMatch(/Unknown featured card id/);
        expect(await packs().listChallengeStages({}, { take: 10 })).toHaveLength(0);
      });

      it('POST stages: shrink → regrow succeeds (hard delete, no unique collision on stage_number)', async () => {
        const full = [
          { stage_number: 1, threshold_myr: 100, reward_credits: 10, reward_card_ids: [] },
          { stage_number: 2, threshold_myr: 200, reward_credits: 20, reward_card_ids: [] },
          { stage_number: 3, threshold_myr: 300, reward_credits: 30, reward_card_ids: [] },
        ];
        const first = await unwrapResponse(
          api.post(
            '/admin/challenge/stages',
            { stages: full, reason: 'first save (3 stages)' },
            { headers: adminHeaders() },
          ),
        );
        expect(first.status).toBe(200);

        const two = full.slice(0, 2);
        const shrink = await unwrapResponse(
          api.post(
            '/admin/challenge/stages',
            { stages: two, reason: 'shrink to 2' },
            { headers: adminHeaders() },
          ),
        );
        expect(shrink.status).toBe(200);
        expect(await packs().listChallengeStages({}, { take: 10 })).toHaveLength(2);

        // Recreate stage 3 — a soft-deleted stage_number=3 would collide here.
        const regrow = await unwrapResponse(
          api.post(
            '/admin/challenge/stages',
            { stages: full, reason: 'regrow to 3' },
            { headers: adminHeaders() },
          ),
        );
        expect(regrow.status).toBe(200);
        expect(regrow.data.stages).toHaveLength(3);
        expect(await packs().listChallengeStages({}, { take: 10 })).toHaveLength(3);
      });

      it('POST settings: valid patch persists + audit; GET reflects it', async () => {
        const res = await unwrapResponse(
          api.post(
            '/admin/challenge/settings',
            {
              patch: { reset_day: 3, reset_hour: 6, payout_credits: 500, payout_card_ids: [cardId] },
              reason: 'set payout',
            },
            { headers: adminHeaders() },
          ),
        );
        expect(res.status).toBe(200);
        expect(res.data).toMatchObject({
          reset_day: 3,
          reset_hour: 6,
          payout_credits: 500,
          payout_card_ids: [cardId],
        });

        const get = await unwrapResponse(
          api.get('/admin/challenge/settings', { headers: adminHeaders() }),
        );
        expect(get.data.reset_day).toBe(3);
        expect(get.data.payout_credits).toBe(500);

        const audits = await packs().listAdminActionAudits(
          { entity_type: 'challenge_settings', action: 'edit' },
          { take: 10 },
        );
        expect(audits).toHaveLength(1);
      });

      it('POST settings: invalid timezone → 400', async () => {
        const res = await unwrapResponse(
          api.post(
            '/admin/challenge/settings',
            { patch: { timezone: 'Mars/Olympus' }, reason: 'bad tz' },
            { headers: adminHeaders() },
          ),
        );
        expect(res.status).toBe(400);
        expect(String(res.data.message)).toMatch(/valid IANA time zone/);
      });
    });
  },
});
