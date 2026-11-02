import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { mintSuperAdmin, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

const ADMIN_EMAIL = 'pack-type-admin@test.dev';
const PASSWORD = 'pack-type-test-pw-1'; // gitleaks:allow
const SLUG = 'pack-type-pack';

// A draft needs no prize pool, so the tags can be exercised on their own.
const PACK_BODY = {
  title: 'Pack Type Pack',
  category: 'pokemon',
  price: 50,
  image: '/cdn/test-pack.webp',
  buyback_percent: 90,
  boost: false,
  rank: 0,
  status: 'draft',
};

// pack_type + language through the real migration, routes and DB checks: a
// writer that omits them keeps them, a type change clears a stale language,
// and the original-only language rule holds even past the API validator.
medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('/admin/packs pack_type + language', () => {
      let adminToken: string;
      const headers = () => ({ authorization: `Bearer ${adminToken}` });
      const update = (extra: Record<string, unknown>) =>
        unwrapResponse(
          api.post(
            `/admin/packs/${SLUG}`,
            { ...PACK_BODY, ...extra },
            { headers: headers() },
          ),
        );
      const tags = async () => {
        const res = await unwrapResponse(
          api.get('/admin/packs', { headers: headers() }),
        );
        expect(res.status).toBe(200);
        const p = res.data.packs.find((x: { slug: string }) => x.slug === SLUG);
        return { pack_type: p.pack_type, language: p.language };
      };

      beforeEach(async () => {
        adminToken = await mintSuperAdmin(
          getContainer(),
          api,
          ADMIN_EMAIL,
          PASSWORD,
        );
        const created = await unwrapResponse(
          api.post(
            '/admin/packs',
            { ...PACK_BODY, slug: SLUG, pack_type: 'original', language: 'jp' },
            { headers: headers() },
          ),
        );
        expect(created.status).toBe(201);
      });

      it('creates with the tags and serves them on the list and the edit form', async () => {
        expect(await tags()).toEqual({ pack_type: 'original', language: 'jp' });
        const one = await unwrapResponse(
          api.get(`/admin/packs/${SLUG}`, { headers: headers() }),
        );
        expect(one.data.pack).toMatchObject({
          pack_type: 'original',
          language: 'jp',
        });
      });

      it('keeps both when a writer omits them, clears the language on a type change', async () => {
        expect((await update({ title: 'Renamed' })).status).toBe(200);
        expect(await tags()).toEqual({ pack_type: 'original', language: 'jp' });

        expect((await update({ pack_type: 'classic' })).status).toBe(200);
        expect(await tags()).toEqual({ pack_type: 'classic', language: null });

        expect((await update({ pack_type: null })).status).toBe(200);
        expect(await tags()).toEqual({ pack_type: null, language: null });
      });

      it('refuses a language on a non-original pack', async () => {
        const res = await update({ pack_type: 'special', language: 'en' });
        expect(res.status).toBe(400);
        expect(await tags()).toEqual({ pack_type: 'original', language: 'jp' });
      });

      it('the DB holds the original-only language rule past the API', async () => {
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        const [pack] = await packs.listPacks({ slug: SLUG }, { take: 1 });
        await expect(
          packs.updatePacks([{ id: pack.id, pack_type: 'classic' }]),
        ).rejects.toThrow(/pack_language_original_check/);
        // An untyped pack too: a NULL comparison must not slip through.
        await expect(
          packs.updatePacks([{ id: pack.id, pack_type: null }]),
        ).rejects.toThrow(/pack_language_original_check/);
      });
    });
  },
});
