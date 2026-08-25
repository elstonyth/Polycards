import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { VIP_LEVELS } from '../../src/scripts/vip-levels.data';
import { postStoreCustomer, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

const PASSWORD = 'daily-box-test-password-1';
const BOX_TIERS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'Z'];

// Task 6 — GET /store/daily + POST /store/daily/draw (the reward_box-model
// daily box). Contracts under test:
//   - GET is NOT gated (redemption_enabled just mirrors the env flag);
//   - POST /store/daily/draw 403s fail-closed while REWARDS_REDEMPTION_ENABLED
//     is unset, BEFORE any reward_draw row is written;
//   - a drawn credit prize pays the ledger and writes a reward_draw with a
//     non-null odds_snapshot — but odds/weight/locked/pct NEVER appear in any
//     store-facing response body;
//   - the UTC draw_day cap flips the second same-day draw to 'capped';
//   - voucher prizes create vip_reward_grant rows with origin:'box' +
//     source_open_id, and TWO same-day voucher wins both persist (box grants
//     escape the ladder's (level, kind) uniqueness);
//   - a product prize with a dead/zero-stock handle degrades to
//     {status:'drawn', prize:{kind:'nothing'}} and still writes a reward_draw;
//   - GET /store/daily showcases only UNLOCKED prizes.
medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('/store/daily (daily box)', () => {
      let storeHeaders: Record<string, string>;
      const prevRedemptionEnabled = process.env.REWARDS_REDEMPTION_ENABLED;

      const packs = () =>
        getContainer().resolve<PacksModuleService>(PACKS_MODULE);

      beforeAll(() => {
        process.env.REWARDS_REDEMPTION_ENABLED = 'true';
      });

      afterAll(() => {
        if (prevRedemptionEnabled === undefined) {
          delete process.env.REWARDS_REDEMPTION_ENABLED;
        } else {
          process.env.REWARDS_REDEMPTION_ENABLED = prevRedemptionEnabled;
        }
      });

      beforeEach(async () => {
        process.env.REWARDS_REDEMPTION_ENABLED = 'true';

        const container = getContainer();
        const apiKeyModule = container.resolve(Modules.API_KEY);
        const key = await apiKeyModule.createApiKeys({
          title: 'daily-box-test',
          type: 'publishable',
          created_by: 'daily-box-test',
        });
        storeHeaders = { 'x-publishable-api-key': key.token };

        // The between-test TRUNCATE wipes migration-seeded rows, so re-ensure
        // the VIP ladder (tier resolution reads vip_level.box_tier) and the 11
        // reward_box tier rows (seeded disabled, mirroring the migration).
        const svc = packs();
        if ((await svc.listVipLevels({}, { take: 1 })).length === 0) {
          await svc.createVipLevels(
            VIP_LEVELS.map((r) => ({
              level: r.level,
              spend_threshold: r.spend_threshold,
              voucher_amount: r.voucher_amount,
              box_tier: r.box_tier,
              frame_unlock: r.frame_unlock,
              prizes: r.prizes ?? null,
            })),
          );
        }
        const boxes = await svc.listRewardBoxes({}, { take: 100 });
        const have = new Set(boxes.map((b) => b.tier));
        const missing = BOX_TIERS.filter((t) => !have.has(t));
        if (missing.length > 0) {
          await svc.createRewardBoxes(
            missing.map((tier) => ({
              tier,
              name: '',
              enabled: false,
              draws_per_day: 1,
            })),
          );
        }
      });

      const authed = (token: string): Record<string, string> => ({
        ...storeHeaders,
        authorization: `Bearer ${token}`,
      });

      const registerCustomer = async (email: string): Promise<string> => {
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
        return login.data.token as string;
      };

      const customerIdOf = async (token: string): Promise<string> => {
        const me = await unwrapResponse(
          api.get('/store/customers/me', { headers: authed(token) }),
        );
        return me.data.customer.id as string;
      };

      const getState = (headers: Record<string, string>) =>
        unwrapResponse(api.get('/store/daily', { headers }));
      const draw = (headers: Record<string, string>) =>
        unwrapResponse(api.post('/store/daily/draw', {}, { headers }));

      /** Enable tier 'a' and replace its prize table with pre-normalized bps
       *  weights (Σ = 10000 — the draw rolls randomInt(10000) over them). */
      const seedBoxA = async (
        prizes: {
          kind: 'credit' | 'product' | 'voucher' | 'nothing';
          weight: number;
          locked?: boolean;
          payload?: Record<string, unknown>;
        }[],
        drawsPerDay = 1,
      ): Promise<void> => {
        const svc = packs();
        const [box] = await svc.listRewardBoxes({ tier: 'a' }, { take: 1 });
        await svc.updateRewardBoxes({
          selector: { id: box.id },
          data: { name: 'Box A', enabled: true, draws_per_day: drawsPerDay },
        });
        await svc.createRewardBoxPrizes(
          prizes.map((p) => ({
            box_id: box.id,
            kind: p.kind,
            weight: p.weight,
            locked: p.locked ?? false,
            payload: p.payload ?? {},
          })),
        );
      };

      const NO_ODDS_KEYS = /"(weight|odds|locked|pct|odds_snapshot)"/;

      it('rejects unauthenticated state and draw with 401', async () => {
        expect((await getState(storeHeaders)).status).toBe(401);
        expect((await draw(storeHeaders)).status).toBe(401);
      });

      it('fail-closed gate: draw 403s with the gate off and writes NO reward_draw; GET stays 200 with redemption_enabled=false', async () => {
        delete process.env.REWARDS_REDEMPTION_ENABLED;

        const token = await registerCustomer('daily-box-gate@test.dev');
        await seedBoxA([
          { kind: 'credit', weight: 10000, payload: { amount_myr: 5 } },
        ]);

        const res = await draw(authed(token));
        expect(res.status).toBe(403);
        expect(res.data.message).toBe('Reward redemption is not enabled.');
        expect(await packs().listRewardDraws({}, { take: 10 })).toHaveLength(0);

        // GET is NOT gated — it reports the flag so the UI can pre-disable.
        const state = await getState(authed(token));
        expect(state.status).toBe(200);
        expect(state.data.redemption_enabled).toBe(false);

        process.env.REWARDS_REDEMPTION_ENABLED = 'true';
      });

      it('credit draw: pays the ledger, writes reward_draw with odds_snapshot, leaks no odds, and caps the second same-day draw', async () => {
        const token = await registerCustomer('daily-box-credit@test.dev');
        const customerId = await customerIdOf(token);
        await seedBoxA(
          [{ kind: 'credit', weight: 10000, payload: { amount_myr: 5 } }],
          1,
        );

        const first = await draw(authed(token));
        expect(first.status).toBe(200);
        expect(first.data).toMatchObject({
          status: 'drawn',
          prize: { kind: 'credit', amount_myr: 5 },
          draw_ordinal: 1,
        });
        // Odds secrecy: the whole response body carries no odds-ish keys.
        expect(JSON.stringify(first.data)).not.toMatch(NO_ODDS_KEYS);

        // Real DB effects, via the service: one reward_credit ledger row...
        const ledger = await packs().listCreditTransactions(
          { customer_id: customerId },
          { take: 10 },
        );
        expect(ledger).toHaveLength(1);
        expect(ledger[0]).toMatchObject({ reason: 'reward_credit' });
        expect(Number(ledger[0].amount)).toBe(5);
        expect(await packs().creditBalance(customerId)).toBe(5);

        // ...and one reward_draw row with the odds recorded server-side only.
        const draws = await packs().listRewardDraws(
          { customer_id: customerId },
          { take: 10 },
        );
        expect(draws).toHaveLength(1);
        expect(draws[0].prize_kind).toBe('credit');
        expect(draws[0].odds_snapshot).toBeTruthy();
        expect(
          (draws[0].odds_snapshot as { computed: unknown[] }).computed,
        ).toHaveLength(1);

        // UTC draw_day cap: same-day second draw is 'capped', no new rows.
        const second = await draw(authed(token));
        expect(second.status).toBe(200);
        expect(second.data.status).toBe('capped');
        expect(
          await packs().listRewardDraws(
            { customer_id: customerId },
            { take: 10 },
          ),
        ).toHaveLength(1);

        // GET reflects the consumed draw.
        const state = await getState(authed(token));
        expect(state.data.box).toMatchObject({
          tier: 'a',
          draws_per_day: 1,
          draws_today: 1,
        });
      });

      it('no enabled box for the tier → status unavailable, nothing written', async () => {
        const token = await registerCustomer('daily-box-unavail@test.dev');
        // Tier 'a' box exists but stays disabled with no prizes (seed default).
        const res = await draw(authed(token));
        expect(res.status).toBe(200);
        expect(res.data.status).toBe('unavailable');
        expect(await packs().listRewardDraws({}, { take: 10 })).toHaveLength(0);
      });

      it("voucher prize: each draw creates a vip_reward_grant with origin 'box' + source_open_id — two same-day wins both persist", async () => {
        const token = await registerCustomer('daily-box-voucher@test.dev');
        const customerId = await customerIdOf(token);
        await seedBoxA(
          [{ kind: 'voucher', weight: 10000, payload: { amount_myr: 10 } }],
          2,
        );

        const first = await draw(authed(token));
        expect(first.status).toBe(200);
        expect(first.data).toMatchObject({
          status: 'drawn',
          prize: { kind: 'voucher', amount_myr: 10 },
        });
        const second = await draw(authed(token));
        expect(second.status).toBe(200);
        expect(second.data).toMatchObject({
          status: 'drawn',
          prize: { kind: 'voucher', amount_myr: 10 },
        });

        // Both grants exist — origin:'box' escapes the ladder's (level, kind)
        // partial-unique index, so the same L1 voucher can be won twice.
        const grants = await packs().listVipRewardGrants(
          { customer_id: customerId, origin: 'box' },
          { take: 10 },
        );
        expect(grants).toHaveLength(2);
        for (const g of grants) {
          expect(g.kind).toBe('voucher');
          expect(g.status).toBe('granted');
          expect(g.source_open_id).toBeTruthy();
        }
        expect(grants[0].source_open_id).not.toBe(grants[1].source_open_id);
      });

      it("stock gate: a product prize with a dead handle degrades to prize 'nothing' but still writes the reward_draw", async () => {
        const token = await registerCustomer('daily-box-stock@test.dev');
        const customerId = await customerIdOf(token);
        await seedBoxA([
          {
            kind: 'product',
            weight: 10000,
            payload: { product_handle: 'no-such-product-handle', qty: 1 },
          },
        ]);

        const res = await draw(authed(token));
        expect(res.status).toBe(200);
        expect(res.data).toMatchObject({
          status: 'drawn',
          prize: { kind: 'nothing' },
        });

        // The draw row is still written (audit trail), degraded to 'nothing',
        // while odds_snapshot keeps recording the AUTHORED product row.
        const draws = await packs().listRewardDraws(
          { customer_id: customerId },
          { take: 10 },
        );
        expect(draws).toHaveLength(1);
        expect(draws[0].prize_kind).toBe('nothing');
        expect(draws[0].prize_snapshot).toMatchObject({
          degraded_from: 'product',
        });
        const computed = (
          draws[0].odds_snapshot as { computed: { kind: string }[] }
        ).computed;
        expect(computed).toHaveLength(1);
        expect(computed[0].kind).toBe('product');
        // No vaulted Pull was minted for the dead product.
        expect(
          await packs().listPulls({ customer_id: customerId }, { take: 10 }),
        ).toHaveLength(0);
      });

      it('GET /store/daily: box state + voucher lists, with LOCKED prizes absent from the showcase', async () => {
        const token = await registerCustomer('daily-box-state@test.dev');
        await seedBoxA(
          [
            { kind: 'credit', weight: 9000, payload: { amount_myr: 5 } },
            {
              kind: 'voucher',
              weight: 1000,
              locked: true,
              payload: { amount_myr: 100 },
            },
          ],
          3,
        );

        const res = await getState(authed(token));
        expect(res.status).toBe(200);
        expect(res.data.redemption_enabled).toBe(true);
        expect(res.data.box).toMatchObject({
          tier: 'a',
          name: 'Box A',
          draws_per_day: 3,
          draws_today: 0,
        });
        expect(typeof res.data.box.next_reset).toBe('string');

        // Showcase = UNLOCKED rows only: the locked voucher must be invisible.
        expect(res.data.box.prizes).toHaveLength(1);
        expect(res.data.box.prizes[0]).toEqual({
          kind: 'credit',
          amount_myr: 5,
        });

        expect(res.data.vouchers).toEqual({ claimable: [], claimed: [] });
        expect(res.data.ship_prizes).toEqual([]);

        // Odds secrecy applies to the state read too.
        expect(JSON.stringify(res.data)).not.toMatch(NO_ODDS_KEYS);
      });
    });
  },
});
