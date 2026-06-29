/**
 * achievements-route — integration:http
 *
 * Tests GET /store/achievements:
 *   1. 401 without a token.
 *   2. For a customer who opened 1 pack, the response contains:
 *      - cases_opened_1 as unlocked: true
 *      - collector_level >= 1
 *      - wire shape: collector_level, total_xp, next_level, achievements[]
 *        with progress fields.
 *
 * Mirrors achievements-unlock.spec.ts: real HTTP open, getContainer() for
 * seeding and post-open state reads.
 */

import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { VIP_LEVELS } from '../../src/scripts/vip-levels.data';
import { unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

const PASSWORD = 'ach-route-pw1';
const PACK_SLUG = 'ach-route-pack';
const CARD_HANDLE = 'ach-route-card';
const PACK_PRICE = 10;

async function waitFor<T>(
  read: () => Promise<T>,
  done: (v: T) => boolean,
  { tries = 25, delayMs = 200 }: { tries?: number; delayMs?: number } = {},
): Promise<T> {
  let last = await read();
  for (let i = 0; i < tries && !done(last); i++) {
    await new Promise((r) => setTimeout(r, delayMs));
    last = await read();
  }
  return last;
}

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    async function seedLadder(packs: PacksModuleService) {
      const existing = await packs.listVipLevels({}, { take: 1 });
      if (existing.length === 0) {
        await packs.createVipLevels(
          VIP_LEVELS.map((r) => ({
            level: r.level,
            spend_threshold: r.spend_threshold,
            voucher_amount: r.voucher_amount,
            box_tier: r.box_tier,
            frame_unlock: r.frame_unlock,
            direct_referral_pct: r.direct_referral_pct,
            prizes: r.prizes ?? null,
          })),
        );
      }
    }

    async function seedAchievementDef(packs: PacksModuleService) {
      const existing = await packs.listAchievementDefs(
        { key: 'cases_opened_1' },
        { take: 1 },
      );
      if (existing.length === 0) {
        await packs.createAchievementDefs([
          {
            key: 'cases_opened_1',
            name: 'First Pull',
            description: 'Open your first case',
            category: 'cases_opened',
            rarity: 'Common',
            xp: 50,
            metric: 'cases_opened',
            threshold: 1,
          },
        ]);
      }
    }

    async function seedPack(packs: PacksModuleService) {
      const existing = await packs.listPacks({ slug: PACK_SLUG }, { take: 1 });
      if (existing.length === 0) {
        await packs.createPacks([
          {
            slug: PACK_SLUG,
            title: 'Ach Route Pack',
            category: 'pokemon',
            price: PACK_PRICE,
            image: '/cdn/ach-route-pack.webp',
            buyback_percent: 90,
          },
        ]);
        await packs.createCards([
          {
            handle: CARD_HANDLE,
            name: 'Ach Route Card PSA 10',
            set: 'Ach Route Set',
            grader: 'PSA',
            grade: '10',
            market_value: 50,
            image: '/cdn/ach-route-card.webp',
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
      }
    }

    async function mintStoreHeaders(): Promise<Record<string, string>> {
      const { Modules } = await import('@medusajs/framework/utils');
      const apiKeyModule = getContainer().resolve(Modules.API_KEY);
      const key = await apiKeyModule.createApiKeys({
        title: 'ach-route-test',
        type: 'publishable',
        created_by: 'ach-route-test',
      });
      return { 'x-publishable-api-key': key.token };
    }

    async function registerAndLogin(
      email: string,
      storeHeaders: Record<string, string>,
    ): Promise<{ token: string; actorId: string }> {
      const reg = await api.post('/auth/customer/emailpass/register', {
        email,
        password: PASSWORD,
      });
      const created = await api.post(
        '/store/customers',
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
      return {
        token: login.data.token as string,
        actorId: created.data.customer.id as string,
      };
    }

    it(
      'GET /store/achievements returns live-fallback shape for a new customer with no state row',
      async () => {
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);

        await seedLadder(packs);
        await seedAchievementDef(packs);
        // ponytail: no pack open — absence of a state row is the point

        const storeHeaders = await mintStoreHeaders();
        const customer = await registerAndLogin(
          'ach-route-new@pokenic.test',
          storeHeaders,
        );

        const res = await unwrapResponse(
          api.get('/store/achievements', {
            headers: {
              ...storeHeaders,
              authorization: `Bearer ${customer.token}`,
            },
          }),
        );
        expect(res.status).toBe(200);

        const body = res.data as {
          collector_level: number;
          total_xp: number;
          next_level: { level: number; xp_threshold: number; remaining: number } | null;
          achievements: {
            key: string;
            unlocked: boolean;
            unlocked_at: unknown;
            progress: { current: number; target: number };
          }[];
        };

        expect(body.collector_level).toBe(1);
        expect(body.total_xp).toBe(0);

        // Level-2 rung must be present and correct.
        expect(body.next_level).not.toBeNull();
        expect(body.next_level?.level).toBe(2);
        expect(body.next_level?.xp_threshold).toBe(500);
        expect(body.next_level?.remaining).toBe(500);

        // Every achievement is locked with null unlocked_at and has a progress shape.
        expect(Array.isArray(body.achievements)).toBe(true);
        expect(body.achievements.length).toBeGreaterThan(0);
        for (const ach of body.achievements) {
          expect(ach.unlocked).toBe(false);
          expect(ach.unlocked_at).toBeNull();
          expect(typeof ach.progress.current).toBe('number');
          expect(typeof ach.progress.target).toBe('number');
        }
      },
    );

    it('GET /store/achievements returns 401 without a token', async () => {
      const storeHeaders = await mintStoreHeaders();
      const res = await unwrapResponse(
        api.get('/store/achievements', { headers: storeHeaders }),
      );
      expect(res.status).toBe(401);
    });

    it(
      'GET /store/achievements returns correct shape with cases_opened_1 unlocked after 1 pack open',
      async () => {
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);

        await seedLadder(packs);
        await seedAchievementDef(packs);
        await seedPack(packs);

        const storeHeaders = await mintStoreHeaders();
        const customer = await registerAndLogin(
          'ach-route-customer@pokenic.test',
          storeHeaders,
        );

        // Top up with enough credit to open one pack.
        await packs.mutateCreditAtomic({
          customerId: customer.actorId,
          amount: PACK_PRICE * 2,
          reason: 'topup',
          reference: 'mock_ach_route',
        });

        // Open via real HTTP — triggers vip.spend_settled → achievements-spend-settled.
        const openRes = await unwrapResponse(
          api.post(
            `/store/packs/${PACK_SLUG}/open`,
            {},
            {
              headers: {
                ...storeHeaders,
                authorization: `Bearer ${customer.token}`,
              },
            },
          ),
        );
        expect(openRes.status).toBe(200);

        // Wait for the async subscriber to grant cases_opened_1.
        await waitFor(
          () => packs.listAchievementGrants({ customer_id: customer.actorId }),
          (rows) => rows.some((g: { achievement_key: string }) => g.achievement_key === 'cases_opened_1'),
        );

        // Now hit GET /store/achievements and verify the wire shape.
        const res = await unwrapResponse(
          api.get('/store/achievements', {
            headers: {
              ...storeHeaders,
              authorization: `Bearer ${customer.token}`,
            },
          }),
        );
        expect(res.status).toBe(200);

        const body = res.data as {
          collector_level: number;
          total_xp: number;
          highest_level_ever: number;
          next_level: { level: number; xp_threshold: number; remaining: number } | null;
          achievements: {
            key: string;
            unlocked: boolean;
            progress: { current: number; target: number };
          }[];
        };

        // Top-level shape.
        expect(typeof body.collector_level).toBe('number');
        expect(body.collector_level).toBeGreaterThanOrEqual(1);
        expect(typeof body.total_xp).toBe('number');
        expect(body.total_xp).toBeGreaterThanOrEqual(50);
        expect(typeof body.highest_level_ever).toBe('number');
        // next_level is null or has the right sub-shape.
        if (body.next_level !== null) {
          expect(typeof body.next_level.level).toBe('number');
          expect(typeof body.next_level.xp_threshold).toBe('number');
          expect(typeof body.next_level.remaining).toBe('number');
        }

        // achievements array contains cases_opened_1 as unlocked with progress.
        expect(Array.isArray(body.achievements)).toBe(true);
        const ach = body.achievements.find((a) => a.key === 'cases_opened_1');
        expect(ach).toBeDefined();
        expect(ach?.unlocked).toBe(true);
        expect(ach?.progress.current).toBeGreaterThanOrEqual(1);
        expect(ach?.progress.target).toBe(1);
      },
    );
  },
});
