import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { mintSuperAdmin, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

// Activation guard: an ACTIVE pack must always be openable. A pack with no
// rollable prize pool (no card odds rows, or an all-zero total weight) used to
// go live on the storefront and fail EVERY spin with an opaque error — the
// root cause behind "Could not open the pack. Please try again." on freshly
// authored packs. These specs pin the lifecycle: draft-first creation,
// activation only with a valid pool, and no emptying an active pool.

const ADMIN_EMAIL = 'pack-guard-admin@polycards.test';
const PASSWORD = 'supersecret-test-pw';
const CARD_HANDLE = 'guard-test-card';
const CARD_HANDLE_2 = 'guard-test-card-2';

const PACK_BODY = {
  title: 'Guard Test Pack',
  category: 'pokemon',
  price: 10,
  image: '/cdn/test-pack.webp',
  buyback_percent: 90,
  boost: false,
  rank: 0,
};

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('pack activation guard', () => {
      let adminHeaders: Record<string, string>;
      let packs: PacksModuleService;

      beforeEach(async () => {
        const container = getContainer();
        const token = await mintSuperAdmin(
          container,
          api,
          ADMIN_EMAIL,
          PASSWORD,
        );
        adminHeaders = { Authorization: `Bearer ${token}` };
        packs = container.resolve<PacksModuleService>(PACKS_MODULE);
        await packs.createCards([
          {
            handle: CARD_HANDLE,
            name: 'Guard Test Card PSA 10',
            set: 'Test Set',
            grader: 'PSA',
            grade: '10',
            market_value: 100,
            image: '/cdn/test-card.webp',
          },
          {
            handle: CARD_HANDLE_2,
            name: 'Guard Test Card BGS 9',
            set: 'Test Set',
            grader: 'BGS',
            grade: '9',
            market_value: 40,
            image: '/cdn/test-card-2.webp',
          },
        ]);
      });

      it('enforces the draft → pool → activate lifecycle', async () => {
        // 1. Creating a pack as ACTIVE is rejected — its pool is empty by
        //    construction, so it could never be opened.
        const createActive = await unwrapResponse(
          api.post(
            '/admin/packs',
            { ...PACK_BODY, slug: 'guard-pack', status: 'active' },
            { headers: adminHeaders },
          ),
        );
        expect(createActive.status).toBe(400);
        expect(createActive.data.message).toMatch(/prize pool/i);

        // 2. Draft creation works.
        const createDraft = await unwrapResponse(
          api.post(
            '/admin/packs',
            { ...PACK_BODY, slug: 'guard-pack', status: 'draft' },
            { headers: adminHeaders },
          ),
        );
        expect(createDraft.status).toBe(201);

        // 3. Activating while the pool is still empty is rejected.
        const activateEmpty = await unwrapResponse(
          api.post(
            '/admin/packs/guard-pack',
            { ...PACK_BODY, status: 'active' },
            { headers: adminHeaders },
          ),
        );
        expect(activateEmpty.status).toBe(400);
        expect(activateEmpty.data.message).toMatch(/prize pool/i);

        // 4. Assign a card; win rates are saveable ON THE DRAFT (draft is the
        //    designated authoring state — the editor must work pre-activation);
        //    then activation succeeds.
        //
        //    The lone row is saved at 100% (POLYCARD-BACK §2.4, Common as
        //    balancer). It used to be saved at 0%: under the old rarity-split
        //    semantics an UNLOCKED row floated and absorbed the whole 10000
        //    bps, so 0% in meant 100% out. Under the balancer only unlocked
        //    COMMON rows float — a lone unlocked Rare is pinned verbatim, so
        //    0% now both 400s ("Without an unlocked Common card, win rates
        //    must total exactly 100%") and would leave the pool unwinnable.
        //    Saving it pinned at 100 restores the pre-balancer OUTCOME (one
        //    card at the full 10000 bps), which is what this activation guard
        //    has always been about — it tests the pack LIFECYCLE, not the
        //    odds math (that lives in the odds-math + odds-route specs).
        const setMembers = await unwrapResponse(
          api.post(
            '/admin/packs/guard-pack/members',
            { card_ids: [CARD_HANDLE] },
            { headers: adminHeaders },
          ),
        );
        expect(setMembers.status).toBe(200);

        const draftOddsSave = await unwrapResponse(
          api.post(
            '/admin/packs/guard-pack/odds',
            {
              entries: [
                {
                  card_id: CARD_HANDLE,
                  locked: false,
                  pct: 100,
                  rarity: 'Rare',
                },
              ],
            },
            { headers: adminHeaders },
          ),
        );
        expect(draftOddsSave.status).toBe(200);

        const activate = await unwrapResponse(
          api.post(
            '/admin/packs/guard-pack',
            { ...PACK_BODY, status: 'active' },
            { headers: adminHeaders },
          ),
        );
        expect(activate.status).toBe(200);

        // 5. Emptying the pool of an ACTIVE pack is rejected (would break
        //    every spin); demoting to draft first is the supported path.
        const clearMembers = await unwrapResponse(
          api.post(
            '/admin/packs/guard-pack/members',
            { card_ids: [] },
            { headers: adminHeaders },
          ),
        );
        expect(clearMembers.status).toBe(400);
        expect(clearMembers.data.message).toMatch(/draft/i);

        // 5b. Stripping an ACTIVE pool down to only ZERO-WEIGHT rows is
        //     rejected too — locking one card at 100% leaves the other at
        //     weight 0, and removing the winnable card would break every
        //     spin exactly like an empty pool.
        const addSecond = await unwrapResponse(
          api.post(
            '/admin/packs/guard-pack/members',
            { card_ids: [CARD_HANDLE, CARD_HANDLE_2] },
            { headers: adminHeaders },
          ),
        );
        expect(addSecond.status).toBe(200);
        const lockFirst = await unwrapResponse(
          api.post(
            '/admin/packs/guard-pack/odds',
            {
              entries: [
                { card_id: CARD_HANDLE, locked: true, pct: 100, rarity: 'Rare' },
                {
                  card_id: CARD_HANDLE_2,
                  locked: false,
                  pct: 0,
                  rarity: 'Common',
                },
              ],
            },
            { headers: adminHeaders },
          ),
        );
        expect(lockFirst.status).toBe(200);
        const stripToZeroWeight = await unwrapResponse(
          api.post(
            '/admin/packs/guard-pack/members',
            { card_ids: [CARD_HANDLE_2] },
            { headers: adminHeaders },
          ),
        );
        expect(stripToZeroWeight.status).toBe(400);
        expect(stripToZeroWeight.data.message).toMatch(/winnable|draft/i);

        // 6. Missing status on a write defaults to DRAFT (fail-safe), never
        //    active.
        const createNoStatus = await unwrapResponse(
          api.post(
            '/admin/packs',
            { ...PACK_BODY, slug: 'guard-pack-2' },
            { headers: adminHeaders },
          ),
        );
        expect(createNoStatus.status).toBe(201);
        const [pack2] = await packs.listPacks(
          { slug: 'guard-pack-2' },
          { take: 1 },
        );
        expect(pack2.status).toBe('draft');
      });
    });
  },
});
