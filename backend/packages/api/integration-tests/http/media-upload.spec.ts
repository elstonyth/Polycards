import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import sharp from 'sharp';
import { mintSuperAdmin, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

// POST /admin/media — the validated image-upload route. Exercises the full
// runtime wiring the unit suite can't: multer multipart parsing → kind field →
// sharp metadata read → validateImage gate → uploadFilesWorkflow store. Images
// are generated with sharp so each fixture's dimensions are exact.

const png = (width: number, height: number): Promise<Buffer> =>
  sharp({
    create: { width, height, channels: 3, background: { r: 20, g: 20, b: 20 } },
  })
    .png()
    .toBuffer();

const upload = (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  api: any,
  buf: Buffer,
  kind: string | null,
  headers: Record<string, string>,
) => {
  const form = new FormData();
  form.append(
    'files',
    new Blob([new Uint8Array(buf)], { type: 'image/png' }),
    'art.png',
  );
  if (kind !== null) form.append('kind', kind);
  return unwrapResponse(api.post('/admin/media', form, { headers }));
};

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('admin media upload', () => {
      let auth: Record<string, string>;

      beforeEach(async () => {
        const token = await mintSuperAdmin(
          getContainer(),
          api,
          'media-admin@test.dev',
          'media-test-password-1',
        );
        auth = { authorization: `Bearer ${token}` };
      });

      it('rejects an unauthenticated upload with 401', async () => {
        const buf = await png(1200, 1680);
        const res = await upload(api, buf, 'card', {});
        expect(res.status).toBe(401);
      });

      it('rejects a missing kind with 400', async () => {
        const buf = await png(1200, 1680);
        const res = await upload(api, buf, null, auth);
        expect(res.status).toBe(400);
      });

      it('rejects a card outside the 5:7 aspect with 400', async () => {
        const buf = await png(1200, 1200); // square, not 5:7
        const res = await upload(api, buf, 'card', auth);
        expect(res.status).toBe(400);
        expect(res.data.message).toMatch(/5:7/);
      });

      it('rejects an over-cap (>20MB) upload with 400, not 500', async () => {
        // multer aborts the stream at the 20MB cap before the route runs; the
        // middleware translates its LIMIT_FILE_SIZE into a 400 (not a 500).
        const tooBig = Buffer.alloc(21 * 1024 * 1024);
        const res = await upload(api, tooBig, 'card', auth);
        expect(res.status).toBe(400);
      });

      it('rejects a card below min resolution with 400', async () => {
        const buf = await png(400, 560);
        const res = await upload(api, buf, 'card', auth);
        expect(res.status).toBe(400);
        expect(res.data.message).toMatch(/at least/);
      });

      it('stores a valid 5:7 card and returns its URL', async () => {
        const buf = await png(1200, 1680);
        const res = await upload(api, buf, 'card', auth);
        expect(res.status).toBe(200);
        expect(typeof res.data.url).toBe('string');
        expect(res.data.url.length).toBeGreaterThan(0);
      });

      it('stores a valid portrait pack and returns its URL', async () => {
        const buf = await png(919, 1666);
        const res = await upload(api, buf, 'pack', auth);
        expect(res.status).toBe(200);
        expect(typeof res.data.url).toBe('string');
      });
    });
  },
});
