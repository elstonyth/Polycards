import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';

jest.setTimeout(240 * 1000);

const PACK_SLUG = 'cd-pack';
const CARD_HANDLE = 'cd-card';
// FMV 100 × manual FX 4.0 × multiplier 1.2 = 480 (same golden vector as
// vault-market-price.spec.ts, so price math parity is asserted cross-route).
const FMV = 100;
const OLD_FMV = 90; // history point → 90 × 4.0 × 1.2 = 432
const MULTIPLIER = 1.2;
const MANUAL_RATE = 4.0;

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('GET /store/cards/:handle', () => {
      let storeHeaders: Record<string, string>;

      beforeEach(async () => {
        const container = getContainer();
        const apiKeyModule = container.resolve(Modules.API_KEY);
        const key = await apiKeyModule.createApiKeys({
          title: 'card-detail-test',
          type: 'publishable',
          created_by: 'card-detail-test',
        });
        storeHeaders = { 'x-publishable-api-key': key.token };

        const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
        await packs.createFxRates([
          {
            pair: 'USD_MYR',
            rate: 9.9, // decoy — manual override must win
            source: 'test',
            fetched_at: new Date(),
            manual_override: true,
            manual_rate: MANUAL_RATE,
          },
        ]);
        await packs.createPacks([
          {
            slug: PACK_SLUG,
            title: 'CD Test Pack',
            category: 'pokemon',
            price: 10,
            image: '/cdn/test-pack.webp',
          },
        ]);
        const [card] = await packs.createCards([
          {
            handle: CARD_HANDLE,
            name: 'CD Test Card PSA 10',
            set: 'Test Set',
            grader: 'PSA',
            grade: '10',
            market_value: FMV,
            market_multiplier: MULTIPLIER,
            image: '/cdn/test-card.webp',
          },
        ]);
        await packs.createPackOdds([
          {
            pack_id: PACK_SLUG,
            card_id: CARD_HANDLE,
            weight: 100,
            locked: false,
            rarity: 'Rare' as const,
          },
        ]);
        // Two history rows inside the 30-day window (created_at defaults to now).
        await packs.createCardPriceHistories([
          { card_id: card.id, value: OLD_FMV },
          { card_id: card.id, value: FMV },
        ]);
      });

      it('returns display fields, MYR price with markup, rarity fallback and MYR history', async () => {
        const res = await api
          .get(`/store/cards/${CARD_HANDLE}`, { headers: storeHeaders })
          .catch((e: { response: unknown }) => e.response);
        expect(res.status).toBe(200);
        const { card } = res.data;
        expect(card).toMatchObject({
          handle: CARD_HANDLE,
          name: 'CD Test Card PSA 10',
          set: 'Test Set',
          grader: 'PSA',
          grade: '10',
          image: '/cdn/test-card.webp',
          rarity: 'Rare',
          marketPriceMyr: 480,
        });
        expect(card).toHaveProperty('slab_image');
        expect(card.pcSyncedAt).toBeNull();
        expect(card.priceHistory).toHaveLength(2);
        expect(
          card.priceHistory.map((p: { valueMyr: number }) => p.valueMyr),
        ).toEqual([432, 480]);
        expect(typeof card.priceHistory[0].date).toBe('string');
        // 🔒 no secret odds data anywhere in the payload
        expect(JSON.stringify(res.data)).not.toContain('weight');
      });

      // The card in the seed sits in ONE pack. A real catalogue card sits in
      // several, at DIFFERENT tiers — and the route used to answer with the
      // OLDEST pack's row, so a card that is Immortal in the live pack served
      // the Common frame because some older draft listed it as Common.
      it('answers with the best tier among the LIVE packs, not the oldest row', async () => {
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        // Draft pack first (oldest row wins under the old behaviour) …
        await packs.createPacks([
          {
            slug: 'cd-pack-draft',
            title: 'CD Draft Pack',
            category: 'pokemon',
            price: 10,
            image: '/cdn/test-pack.webp',
            status: 'draft' as const,
          },
          {
            slug: 'cd-pack-live',
            title: 'CD Live Pack',
            category: 'pokemon',
            price: 10,
            image: '/cdn/test-pack.webp',
            status: 'active' as const,
          },
        ]);
        await packs.createPackOdds([
          {
            pack_id: 'cd-pack-draft',
            card_id: CARD_HANDLE,
            weight: 100,
            locked: false,
            rarity: 'Common' as const,
          },
          {
            pack_id: 'cd-pack-live',
            card_id: CARD_HANDLE,
            weight: 100,
            locked: false,
            rarity: 'Immortal' as const,
          },
        ]);

        const res = await api
          .get(`/store/cards/${CARD_HANDLE}`, { headers: storeHeaders })
          .catch((e: { response: unknown }) => e.response);
        expect(res.status).toBe(200);
        expect(res.data.card.rarity).toBe('Immortal');
      });

      // The discriminating case. In the test above, best-among-live and
      // best-among-ALL are both Immortal, so it passes even if the live-pack
      // filter is a no-op. Here the DRAFT pack holds the higher tier, so the
      // only way to answer Rare is to actually exclude drafts — this fails
      // loudly if the status filter, the slug array filter or the `select`
      // projection ever silently degrades.
      it('a draft pack does NOT lend its higher tier to a live card', async () => {
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        const handle = 'cd-card-draft-outranks';
        await packs.createCards([
          {
            handle,
            name: 'Draft Outranks Card',
            set: 'Test Set',
            grader: 'PSA',
            grade: '10',
            market_value: FMV,
            image: '/cdn/test-card.webp',
          },
        ]);
        await packs.createPacks([
          {
            slug: 'cd-pack-draft-high',
            title: 'CD Draft High',
            category: 'pokemon',
            price: 10,
            image: '/cdn/test-pack.webp',
            status: 'draft' as const,
          },
          {
            slug: 'cd-pack-live-low',
            title: 'CD Live Low',
            category: 'pokemon',
            price: 10,
            image: '/cdn/test-pack.webp',
            status: 'active' as const,
          },
        ]);
        await packs.createPackOdds([
          {
            pack_id: 'cd-pack-draft-high',
            card_id: handle,
            weight: 100,
            locked: false,
            rarity: 'Immortal' as const,
          },
          {
            pack_id: 'cd-pack-live-low',
            card_id: handle,
            weight: 100,
            locked: false,
            rarity: 'Rare' as const,
          },
        ]);

        const res = await api
          .get(`/store/cards/${handle}`, { headers: storeHeaders })
          .catch((e: { response: unknown }) => e.response);
        expect(res.status).toBe(200);
        expect(res.data.card.rarity).toBe('Rare');
      });

      // reward_box packs are active but internal draw pools, excluded from the
      // public catalogue — so they must not lend their tier to a deep link
      // either. Same shape as the draft case, different exclusion reason.
      it('a reward_box pool does NOT lend its higher tier', async () => {
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        const handle = 'cd-card-rewardbox';
        await packs.createCards([
          {
            handle,
            name: 'Reward Box Card',
            set: 'Test Set',
            grader: 'PSA',
            grade: '10',
            market_value: FMV,
            image: '/cdn/test-card.webp',
          },
        ]);
        await packs.createPacks([
          {
            slug: 'cd-pack-rewardbox',
            title: 'CD Reward Box',
            category: 'reward_box',
            price: 10,
            image: '/cdn/test-pack.webp',
            status: 'active' as const,
          },
          {
            slug: 'cd-pack-live-uncommon',
            title: 'CD Live Uncommon',
            category: 'pokemon',
            price: 10,
            image: '/cdn/test-pack.webp',
            status: 'active' as const,
          },
        ]);
        await packs.createPackOdds([
          {
            pack_id: 'cd-pack-rewardbox',
            card_id: handle,
            weight: 100,
            locked: false,
            rarity: 'Legendary' as const,
          },
          {
            pack_id: 'cd-pack-live-uncommon',
            card_id: handle,
            weight: 100,
            locked: false,
            rarity: 'Uncommon' as const,
          },
        ]);

        const res = await api
          .get(`/store/cards/${handle}`, { headers: storeHeaders })
          .catch((e: { response: unknown }) => e.response);
        expect(res.status).toBe(200);
        expect(res.data.card.rarity).toBe('Uncommon');
      });

      it('a draft-only card keeps its tier rather than losing the frame', async () => {
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        const handle = 'cd-card-draft-only';
        await packs.createCards([
          {
            handle,
            name: 'Draft Only Card',
            set: 'Test Set',
            grader: 'PSA',
            grade: '10',
            market_value: FMV,
            image: '/cdn/test-card.webp',
          },
        ]);
        await packs.createPacks([
          {
            slug: 'cd-pack-draft-only',
            title: 'CD Draft Only',
            category: 'pokemon',
            price: 10,
            image: '/cdn/test-pack.webp',
            status: 'draft' as const,
          },
        ]);
        await packs.createPackOdds([
          {
            pack_id: 'cd-pack-draft-only',
            card_id: handle,
            weight: 100,
            locked: false,
            rarity: 'Legendary' as const,
          },
        ]);

        const res = await api
          .get(`/store/cards/${handle}`, { headers: storeHeaders })
          .catch((e: { response: unknown }) => e.response);
        expect(res.status).toBe(200);
        expect(res.data.card.rarity).toBe('Legendary');
      });

      it('404s an unknown handle', async () => {
        const res = await api
          .get('/store/cards/definitely-not-a-card', { headers: storeHeaders })
          .catch((e: { response: unknown }) => e.response);
        expect(res.status).toBe(404);
      });
    });
  },
});
