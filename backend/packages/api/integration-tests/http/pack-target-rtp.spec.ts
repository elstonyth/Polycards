import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { mintSuperAdmin, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

const ADMIN_EMAIL = 'target-rtp-admin@polycards.test';
const PASSWORD = 'supersecret-test-pw';
const CARD_HANDLE = 'target-rtp-card';

const PACK_BODY = {
  title: 'Target RTP Pack',
  category: 'pokemon',
  price: 50,
  image: '/cdn/test-pack.webp',
  buyback_percent: 90,
  boost: false,
  rank: 0,
  status: 'draft',
};

// A real, matching odds entry for CARD_HANDLE — the shape the actual editor
// always sends (mirrors pack-activation-guard.spec.ts's draftOddsSave). The
// target_rtp_bps tests need a genuinely saveable pool so the odds workflow
// itself succeeds (200), isolating "does target_rtp_bps round-trip" from
// savePackOddsStep's own pool guards, which are out of this task's scope.
const REAL_ENTRIES = [
  { card_id: CARD_HANDLE, locked: false, pct: 100, rarity: 'Rare' },
];

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('pack target_rtp_bps', () => {
      let adminHeaders: Record<string, string>;

      beforeEach(async () => {
        const container = getContainer();
        const token = await mintSuperAdmin(container, api, ADMIN_EMAIL, PASSWORD);
        adminHeaders = { Authorization: `Bearer ${token}` };
        const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
        await packs.createCards([
          {
            handle: CARD_HANDLE,
            name: 'Target RTP Card PSA 10',
            set: 'Test Set',
            grader: 'PSA',
            grade: '10',
            market_value: 100,
            image: '/cdn/test-card.webp',
          },
        ]);
        const created = await unwrapResponse(
          api.post('/admin/packs', { ...PACK_BODY, slug: 'rtp-pack' }, { headers: adminHeaders }),
        );
        expect(created.status).toBe(201);
        const setMembers = await unwrapResponse(
          api.post(
            '/admin/packs/rtp-pack/members',
            { card_ids: [CARD_HANDLE] },
            { headers: adminHeaders },
          ),
        );
        expect(setMembers.status).toBe(200);
      });

      it('defaults to 7000 bps and round-trips a new value', async () => {
        const first = await unwrapResponse(
          api.get('/admin/packs/rtp-pack/odds', { headers: adminHeaders }),
        );
        expect(first.status).toBe(200);
        expect(first.data.pack.target_rtp_bps).toBe(7000);

        const saved = await unwrapResponse(
          api.post(
            '/admin/packs/rtp-pack/odds',
            { entries: REAL_ENTRIES, target_rtp_bps: 8500 },
            { headers: adminHeaders },
          ),
        );
        expect(saved.status).toBe(200);

        const second = await unwrapResponse(
          api.get('/admin/packs/rtp-pack/odds', { headers: adminHeaders }),
        );
        expect(second.data.pack.target_rtp_bps).toBe(8500);
      });

      it('leaves the stored value alone when the key is absent', async () => {
        const withTarget = await unwrapResponse(
          api.post(
            '/admin/packs/rtp-pack/odds',
            { entries: REAL_ENTRIES, target_rtp_bps: 8500 },
            { headers: adminHeaders },
          ),
        );
        expect(withTarget.status).toBe(200);

        const withoutTarget = await unwrapResponse(
          api.post(
            '/admin/packs/rtp-pack/odds',
            { entries: REAL_ENTRIES },
            { headers: adminHeaders },
          ),
        );
        expect(withoutTarget.status).toBe(200);

        const res = await unwrapResponse(
          api.get('/admin/packs/rtp-pack/odds', { headers: adminHeaders }),
        );
        expect(res.data.pack.target_rtp_bps).toBe(8500);
      });

      // Coercion runs BEFORE the odds workflow, so a bad target must 400 at
      // validation without ever reaching savePackOddsStep — these keep
      // `entries: []` on purpose (an empty/mismatched pool would otherwise
      // make the workflow itself throw a 404, which must NOT be mistaken for
      // this 400). Asserting the message names target_rtp_bps means a 404
      // can't silently pass as a 400.
      it('rejects an out-of-range or non-integer target', async () => {
        for (const bad of [0, -1, 1_000_001, 70.5, 'seventy']) {
          const res = await unwrapResponse(
            api.post(
              '/admin/packs/rtp-pack/odds',
              { entries: [], target_rtp_bps: bad },
              { headers: adminHeaders },
            ),
          );
          expect(res.status).toBe(400);
          expect(res.data.message).toMatch(/target_rtp_bps/);
        }
      });
    });
  },
});
