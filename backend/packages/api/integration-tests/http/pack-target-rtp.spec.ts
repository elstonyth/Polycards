import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { mintSuperAdmin, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

const ADMIN_EMAIL = 'target-rtp-admin@polycards.test';
const PASSWORD = 'supersecret-test-pw';

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

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('pack target_rtp_bps', () => {
      let adminHeaders: Record<string, string>;

      beforeEach(async () => {
        const token = await mintSuperAdmin(getContainer(), api, ADMIN_EMAIL, PASSWORD);
        adminHeaders = { Authorization: `Bearer ${token}` };
        const created = await unwrapResponse(
          api.post('/admin/packs', { ...PACK_BODY, slug: 'rtp-pack' }, { headers: adminHeaders }),
        );
        expect(created.status).toBe(201);
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
            { entries: [], target_rtp_bps: 8500 },
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
        await unwrapResponse(
          api.post(
            '/admin/packs/rtp-pack/odds',
            { entries: [], target_rtp_bps: 8500 },
            { headers: adminHeaders },
          ),
        );
        await unwrapResponse(
          api.post('/admin/packs/rtp-pack/odds', { entries: [] }, { headers: adminHeaders }),
        );
        const res = await unwrapResponse(
          api.get('/admin/packs/rtp-pack/odds', { headers: adminHeaders }),
        );
        expect(res.data.pack.target_rtp_bps).toBe(8500);
      });

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
        }
      });
    });
  },
});
