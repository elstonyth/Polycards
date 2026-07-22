import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { seedOf } from '../../src/utils/profile-handle';
import { clearChallengeCache } from '../../src/api/store/challenge/route';
import { mintSuperAdmin, myrDisplay as MYR, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

const PASSWORD = 'challenge-test-pw-1';
const ADMIN_EMAIL = 'challenge-admin@test.dev';

// Store-side fixtures (GET /store/challenge). No FxRate row is seeded and cards
// keep the model-default multiplier, so MYR values follow the myrDisplay helper.
const SC_PACK = 'sc-pack';
const SC_X = 'sc-x'; // mv 50 USD
const SC_Y = 'sc-y'; // mv 30 USD
const DAY_MS = 24 * 60 * 60 * 1000;

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
        adminToken = await mintSuperAdmin(
          container,
          api,
          ADMIN_EMAIL,
          PASSWORD,
        );
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
        expect(
          await packs().listChallengeStages({}, { take: 10 }),
        ).toHaveLength(0);
      });

      it('POST stages: happy path persists + writes one audit row', async () => {
        const res = await unwrapResponse(
          api.post(
            '/admin/challenge/stages',
            {
              stages: [
                {
                  stage_number: 1,
                  threshold_myr: 100,
                  rank_rewards: [
                    { rank: 1, card_id: cardId, credits: 0 },
                    { rank: 4, card_id: null, credits: 10 },
                  ],
                },
                {
                  stage_number: 2,
                  threshold_myr: 200,
                  rank_rewards: [{ rank: 4, card_id: null, credits: 20 }],
                },
              ],
              reason: 'configure stages',
            },
            { headers: adminHeaders() },
          ),
        );
        expect(res.status).toBe(200);
        expect(res.data.stages).toHaveLength(2);
        expect(
          await packs().listChallengeStages({}, { take: 10 }),
        ).toHaveLength(2);

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
                {
                  stage_number: 1,
                  threshold_myr: 100,
                  rank_rewards: [
                    { rank: 1, card_id: 'card_does_not_exist', credits: 0 },
                  ],
                },
              ],
              reason: 'bad card',
            },
            { headers: adminHeaders() },
          ),
        );
        expect(res.status).toBe(400);
        expect(String(res.data.message)).toMatch(/Unknown featured card id/);
        expect(
          await packs().listChallengeStages({}, { take: 10 }),
        ).toHaveLength(0);
      });

      it('POST stages: shrink → regrow succeeds (hard delete, no unique collision on stage_number)', async () => {
        const full = [
          {
            stage_number: 1,
            threshold_myr: 100,
            rank_rewards: [{ rank: 4, card_id: null, credits: 10 }],
          },
          {
            stage_number: 2,
            threshold_myr: 200,
            rank_rewards: [{ rank: 4, card_id: null, credits: 20 }],
          },
          {
            stage_number: 3,
            threshold_myr: 300,
            rank_rewards: [{ rank: 4, card_id: null, credits: 30 }],
          },
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
        expect(
          await packs().listChallengeStages({}, { take: 10 }),
        ).toHaveLength(2);

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
        expect(
          await packs().listChallengeStages({}, { take: 10 }),
        ).toHaveLength(3);
      });

      it('POST settings: valid patch persists + audit; GET reflects it', async () => {
        const res = await unwrapResponse(
          api.post(
            '/admin/challenge/settings',
            {
              patch: {
                reset_day: 3,
                reset_hour: 6,
              },
              reason: 'move reset',
            },
            { headers: adminHeaders() },
          ),
        );
        expect(res.status).toBe(200);
        expect(res.data).toMatchObject({
          reset_day: 3,
          reset_hour: 6,
        });

        const get = await unwrapResponse(
          api.get('/admin/challenge/settings', { headers: adminHeaders() }),
        );
        expect(get.data.reset_day).toBe(3);
        expect(get.data.reset_hour).toBe(6);

        const audits = await packs().listAdminActionAudits(
          { entity_type: 'challenge_settings', action: 'edit' },
          { take: 10 },
        );
        expect(audits).toHaveLength(1);
      });

      it('POST settings: retired payout-only patch → 400 (no valid fields)', async () => {
        // payout fields are retired (stages are the prize pool) — a patch that
        // carries only payout fields has nothing valid to update.
        const res = await unwrapResponse(
          api.post(
            '/admin/challenge/settings',
            {
              patch: { payout_credits: 500, payout_card_ids: [cardId] },
              reason: 'set payout',
            },
            { headers: adminHeaders() },
          ),
        );
        expect(res.status).toBe(400);
        expect(String(res.data.message)).toMatch(/No valid settings/);
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

    // GET /store/challenge — the public read. Pins the community-pool +
    // Weekly-Pull-Value contract (challengeWeekPool / challengeWeekTop):
    //  - pool = Σ(card FMV × multiplier × FX) across THIS challenge week's PACK
    //    pulls; reward draws and pulls before the week anchor are excluded.
    //    With no settings row the anchor defaults to Monday 00:00 MYT, so an
    //    8-day-old pull is excluded on every run day.
    //  - top[] is the same pulled-value ranking, PII-safe.
    //  - stages map 1:1 and referenced card ids resolve to {name, image}.
    describe('/store/challenge', () => {
      let storeHeaders: Record<string, string>;
      let cxId: string;
      let cyId: string;
      const packs = () =>
        getContainer().resolve<PacksModuleService>(PACKS_MODULE);

      beforeEach(async () => {
        // Per-process cache outlives each test's fixtures — clear it so a prior
        // test's challenge is never served against this test's data.
        clearChallengeCache();

        const apiKeyModule = getContainer().resolve(Modules.API_KEY);
        const key = await apiKeyModule.createApiKeys({
          title: 'store-challenge-test',
          type: 'publishable',
          created_by: 'store-challenge-test',
        });
        storeHeaders = { 'x-publishable-api-key': key.token };

        await packs().createPacks([
          {
            slug: SC_PACK,
            title: 'SC Pack',
            category: 'pokemon',
            price: 20,
            image: '/x.webp',
          },
        ]);
        await packs().createCards([
          {
            handle: SC_X,
            name: 'X',
            set: 'S',
            grader: 'PSA',
            grade: '10',
            market_value: 50,
            image: '/x.webp',
          },
          {
            handle: SC_Y,
            name: 'Y',
            set: 'S',
            grader: 'PSA',
            grade: '10',
            market_value: 30,
            image: '/x.webp',
          },
        ]);
        const cards = await packs().listCards(
          { handle: [SC_X, SC_Y] },
          { select: ['id', 'handle'], take: 2 },
        );
        cxId = cards.find((c) => c.handle === SC_X)!.id;
        cyId = cards.find((c) => c.handle === SC_Y)!.id;

        const now = new Date();
        const old = new Date(Date.now() - 8 * DAY_MS); // before any week anchor
        const pull = (
          customer_id: string,
          card_id: string,
          rolled_at: Date,
          n: number,
          source: 'pack' | 'reward' = 'pack',
        ) =>
          Array.from({ length: n }, () => ({
            customer_id,
            pack_id: SC_PACK,
            card_id,
            rolled_at,
            source,
          }));
        await packs().createPulls([
          ...pull('cus_sc_1', SC_X, now, 3), // 150 USD (recent)
          ...pull('cus_sc_2', SC_Y, now, 1), // 30 USD (recent)
          ...pull('cus_sc_1', SC_X, now, 1, 'reward'), // EXCLUDED (reward)
          ...pull('cus_sc_3', SC_X, old, 5), // EXCLUDED (pre-anchor)
        ]);

        await packs().saveChallengeStages({
          stages: [
            {
              stage_number: 1,
              threshold_myr: 100,
              rank_rewards: [
                { rank: 1, card_id: cxId, credits: 0 },
                { rank: 4, card_id: null, credits: 1000 },
              ],
            },
            {
              stage_number: 2,
              threshold_myr: 500,
              rank_rewards: [
                { rank: 1, card_id: cxId, credits: 0 },
                { rank: 2, card_id: cyId, credits: 0 },
                { rank: 4, card_id: null, credits: 5000 },
              ],
            },
          ],
          adminId: 'store-challenge-test',
          reason: 'test seed',
        });
      });

      const getStore = () =>
        unwrapResponse(
          api.get('/store/challenge', { headers: storeHeaders }),
        ).then((r) => r.data);

      it("pools ONLY this week's pack pulls (reward + pre-anchor excluded)", async () => {
        const body = await getStore();
        expect(body.active).toBe(true);
        // 3×50 + 1×30 = 180 USD → MYR. Reward draw and 8-day-old pulls add 0.
        expect(body.progress.pooledMyr).toBe(MYR(180));
      });

      it('ranks top pullers by pulled value, PII-safe', async () => {
        const body = await getStore();
        expect(body.top.map((t: { seed: number }) => t.seed)).toEqual([
          seedOf('cus_sc_1'),
          seedOf('cus_sc_2'),
        ]);
        expect(body.top[0]).toMatchObject({
          rank: 1,
          volumeMyr: MYR(150),
          pulls: 3, // the reward draw is not counted
          name: expect.stringMatching(/^Collector /), // no real customer → anon
        });
        expect(body.top[1]).toMatchObject({ rank: 2, volumeMyr: MYR(30) });
        expect(JSON.stringify(body.top)).not.toContain('cus_sc_1'); // no raw id
      });

      it('maps stages and resolves referenced card art', async () => {
        const body = await getStore();
        expect(body.stages).toHaveLength(2);
        expect(body.stages[0]).toMatchObject({
          stageNumber: 1,
          thresholdMyr: 100,
          rankRewards: [
            { rank: 1, cardId: cxId, credits: 0 },
            { rank: 4, cardId: null, credits: 1000 },
          ],
          // legacy projection (plan 057 phase 2 removes it)
          rewardCredits: 1000,
          rewardCardIds: [cxId],
        });
        expect(body.stages[1].rewardCardIds).toEqual([cxId, cyId]);
        // slab_image is emitted per card (null when the card has no graded
        // slab, as here) so the storefront can pick the prism-framed path.
        expect(body.cards[cxId]).toEqual({
          name: 'X',
          image: '/x.webp',
          slab_image: null,
        });
        expect(body.cards[cyId]).toEqual({
          name: 'Y',
          image: '/x.webp',
          slab_image: null,
        });
      });

      it('reports inactive with no stages', async () => {
        await packs().saveChallengeStages({
          stages: [],
          adminId: 'store-challenge-test',
          reason: 'clear',
        });
        clearChallengeCache();
        const body = await getStore();
        expect(body.active).toBe(false);
        expect(body.stages).toHaveLength(0);
      });
    });
  },
});
