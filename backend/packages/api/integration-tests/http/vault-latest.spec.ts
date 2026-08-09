import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { postStoreCustomer, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

const PASSWORD = 'vl-test-password-1';
const OLD = new Date('2026-08-01T00:00:00.000Z');
const NEW = new Date('2026-08-04T00:00:00.000Z');

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('GET /store/vault/latest — the unread-dot signal', () => {
      let storeHeaders: Record<string, string>;
      let packs: PacksModuleService;

      beforeEach(async () => {
        const container = getContainer();
        const apiKeyModule = container.resolve(Modules.API_KEY);
        const key = await apiKeyModule.createApiKeys({
          title: 'vault-latest-test',
          type: 'publishable',
          created_by: 'vault-latest-test',
        });
        storeHeaders = { 'x-publishable-api-key': key.token };
        packs = container.resolve<PacksModuleService>(PACKS_MODULE);
      });

      const authed = (token: string): Record<string, string> => ({
        ...storeHeaders,
        authorization: `Bearer ${token}`,
      });

      // The register JWT carries actor_id: '' until POST /store/customers links
      // it, so log in AGAIN after linking — otherwise the customer id below is
      // empty and every owner-scoping assertion passes vacuously.
      const registerCustomer = async (
        email: string,
      ): Promise<{ token: string; id: string }> => {
        const reg = await api.post('/auth/customer/emailpass/register', {
          email,
          password: PASSWORD,
        });
        await postStoreCustomer(
          api,
          getContainer(),
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
        const token = login.data.token;
        const me = await unwrapResponse(
          api.get('/store/customers/me', { headers: authed(token) }),
        );
        const id = me.data.customer.id as string;
        expect(id).toBeTruthy();
        return { token, id };
      };

      it('rejects unauthenticated access with 401', async () => {
        const res = await unwrapResponse(
          api.get('/store/vault/latest', { headers: storeHeaders }),
        );
        expect(res.status).toBe(401);
      });

      it('answers null for an empty vault', async () => {
        const { token } = await registerCustomer('vl-empty@test.dev');

        const res = await api.get('/store/vault/latest', {
          headers: authed(token),
        });

        expect(res.status).toBe(200);
        expect(res.data.latest_event_at).toBeNull();
        // Per-customer data behind a bearer token must not be storable or
        // replayable across identities (CWE-525). Asserted over real HTTP so a
        // middleware or serializer that strips the header would be caught.
        expect(res.headers['cache-control']).toBe('no-store');
      });

      // noStoreForAuthenticatedStore is a BLANKET /store/* matcher, so proving
      // it on this route alone would not distinguish "blanket" from "one route
      // happens to set it". A second, unrelated authenticated route pins the
      // claim; the anonymous case pins the gate, without which the public
      // catalog would silently become uncacheable.
      it('marks every authenticated store read no-store, and only those', async () => {
        const { token } = await registerCustomer('vl-blanket@test.dev');

        const credits = await api.get('/store/credits/balance', {
          headers: authed(token),
        });
        expect(credits.status).toBe(200);
        expect(credits.headers['cache-control']).toBe('no-store');

        const anon = await unwrapResponse(
          api.get('/store/vault/latest', { headers: storeHeaders }),
        );
        expect(anon.status).toBe(401);
        expect(anon.headers['cache-control']).toBeUndefined();
      });

      // NOTE: freshly created rows all carry ~the same updated_at, so this case
      // deliberately does NOT assert which row won — ordering is pinned by the
      // route unit spec instead. What it proves here is owner-scoping and the
      // status filter, which are the things only a real HTTP round trip can show.
      it("never exposes another customer's rows, and ignores bought_back", async () => {
        const a = await registerCustomer('vl-a@test.dev');
        const b = await registerCustomer('vl-b@test.dev');

        await packs.createPulls([
          {
            customer_id: a.id,
            pack_id: 'vl-pack',
            card_id: 'vl-card-old',
            rolled_at: OLD,
            status: 'vaulted',
          },
          {
            customer_id: a.id,
            pack_id: 'vl-pack',
            card_id: 'vl-card-new',
            rolled_at: NEW,
            status: 'vaulted',
          },
          // B's ONLY pull, already sold back. B's expected null therefore proves
          // two things at once: A's vaulted rows are invisible to B (IDOR), and
          // a sell-back does not light B's own dot (the status filter).
          {
            customer_id: b.id,
            pack_id: 'vl-pack',
            card_id: 'vl-card-sold',
            rolled_at: NEW,
            status: 'bought_back',
          },
        ]);

        const resA = await api.get('/store/vault/latest', {
          headers: authed(a.token),
        });
        expect(resA.status).toBe(200);
        expect(resA.data.latest_event_at).not.toBeNull();

        const resB = await api.get('/store/vault/latest', {
          headers: authed(b.token),
        });
        expect(resB.status).toBe(200);
        expect(resB.data.latest_event_at).toBeNull();
      });

      it('goes quiet when the only vaulted pull leaves for delivery', async () => {
        const c = await registerCustomer('vl-ship@test.dev');

        const [pull] = await packs.createPulls([
          {
            customer_id: c.id,
            pack_id: 'vl-pack',
            card_id: 'vl-card-ship',
            rolled_at: OLD,
            status: 'vaulted',
          },
        ]);
        expect(
          (await api.get('/store/vault/latest', { headers: authed(c.token) }))
            .data.latest_event_at,
        ).not.toBeNull();

        await packs.updatePulls([{ id: pull.id, status: 'delivering' }]);

        const after = await api.get('/store/vault/latest', {
          headers: authed(c.token),
        });
        expect(after.data.latest_event_at).toBeNull();
      });
    });
  },
});
