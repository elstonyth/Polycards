import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { clearFxDisplayCache } from '../../src/modules/packs/pricing';
import { mintSuperAdmin, postStoreCustomer } from './utils';

jest.setTimeout(240 * 1000);

// Task 8 (POLYCARD-BACK Epic 4 §5.3) — the OD ledger writer wired into
// delivery-order create + cancel. A delivery request debits the vault at the
// FULL display price (FMV x market_multiplier x fx — the vault-basis settled
// on Task 7 review) the instant the covered pulls leave the 'vaulted' pool:
// vaultLiabilityMyr/playersOverview both key liability off status='vaulted'
// (service.ts), and transitionPullStatus already flips vaulted -> delivering
// at order CREATE (not at any later admin ship/deliver advance) — so the
// ledger row fires there too, or it would misstate liability for the whole
// requested/processed/ready_to_ship/shipped window. wallet_delta stays 0
// throughout: no cash moves for a physical shipment. Canceling reverses it
// with a second row keyed `cancel:<order_id>`; ONE hook in
// transitionDeliveryOrderStatus covers both the customer cancel route and the
// admin bulk "mark as canceled" tool. Delivery-order behavior itself (status
// pipeline, address edit lock, admin listing) is delivery-orders.spec.ts's
// job; this file only tests the new ledger rows.

const PASSWORD = 'ledger-delivery-test-password-1'; // gitleaks:allow
const PACK_SLUG = 'ledger-od-pack';
const CARD_HANDLE = 'ledger-od-card';
const FMV = 25;
// FX and the markup are BOTH pinned on the fixture (rather than riding
// DEFAULT_USD_MYR / DEFAULT_MARKET_MULTIPLIER): the money assertions below are
// exact numbers, and a default-derived expectation silently changes meaning the
// day a bootstrap seeds an fx_rate row or the default markup moves.
//   display value per pull = FMV x MANUAL_RATE x MULTIPLIER = 25 x 4 x 1.2 = 120
const MULTIPLIER = 1.2;
const MANUAL_RATE = 4.0;
const VALUE_PER_PULL = 120;
const PACK_PRICE = 5;
const TOPUP = 5 * PACK_PRICE;

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('ledger: OD writer — delivery create + cancel', () => {
      let storeHeaders: Record<string, string>;

      // The runner resets the database between `it` blocks, so the publishable
      // key, the gacha fixtures, and any customers are recreated per test.
      beforeEach(async () => {
        // The delivery paths resolve FX through the LENIENT resolveFxRate
        // (pricing.ts), which caches for 30s process-wide — clear it so an
        // earlier ledger spec's manual rate can't outlive its own file under
        // --runInBand and shadow the MANUAL_RATE seeded at the end of this
        // hook (same fix as Task 7's SP spec).
        clearFxDisplayCache();

        const container = getContainer();
        const apiKeyModule = container.resolve(Modules.API_KEY);
        const key = await apiKeyModule.createApiKeys({
          title: 'ledger-delivery-test',
          type: 'publishable',
          created_by: 'ledger-delivery-test',
        });
        storeHeaders = { 'x-publishable-api-key': key.token };

        // Gacha fixtures: an active pack with a SINGLE-card pool, so the
        // weighted roll is deterministic (the only card always wins).
        const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
        await packs.createPacks([
          {
            slug: PACK_SLUG,
            title: 'Ledger OD Test Pack',
            category: 'pokemon',
            price: PACK_PRICE,
            image: '/cdn/test-pack.webp',
            buyback_percent: 90,
          },
        ]);
        await packs.createCards([
          {
            handle: CARD_HANDLE,
            name: 'Ledger OD Test Card',
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
        // Pin USD->MYR so every vault_delta below is a deterministic number.
        await packs.createFxRates([
          {
            pair: 'USD_MYR',
            rate: MANUAL_RATE,
            source: 'test',
            manual_override: true,
            manual_rate: MANUAL_RATE,
          },
        ]);
      });

      const authed = (token: string): Record<string, string> => ({
        ...storeHeaders,
        authorization: `Bearer ${token}`,
      });

      const registerCustomer = async (
        email: string,
      ): Promise<{ token: string; id: string }> => {
        const reg = await api.post('/auth/customer/emailpass/register', {
          email,
          password: PASSWORD,
        });
        const created = await postStoreCustomer(
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
        return { token: login.data.token, id: created.data.customer.id };
      };

      const ledgerEntryRowsFor = async (customerId: string, type?: string) => {
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        const filter: Record<string, unknown> = { customer_id: customerId };
        if (type) filter.type = type;
        return packs.listLedgerEntries(filter, {
          order: { occurred_at: 'DESC' },
        });
      };

      // Create a vaulted pull for `token` via the real open flow; returns pull id.
      const openOne = async (
        token: string,
        topupKey = 'ledger-od-topup',
      ): Promise<string> => {
        await api.post(
          '/store/credits/topup',
          { amount: TOPUP },
          { headers: { ...authed(token), 'idempotency-key': topupKey } },
        );
        const open = await api.post(
          `/store/packs/${PACK_SLUG}/open`,
          {},
          { headers: authed(token) },
        );
        return open.data.pull.id as string;
      };

      // Add a Medusa customer address; returns its id.
      const addAddress = async (token: string): Promise<string> => {
        const res = await api.post(
          '/store/customers/me/addresses',
          {
            first_name: 'Ada',
            last_name: 'Lovelace',
            address_1: '1 Analytical Way',
            city: 'London',
            postal_code: 'EC1',
            country_code: 'gb',
          },
          { headers: authed(token) },
        );
        const list = res.data.customer.addresses;
        return list[list.length - 1].id as string;
      };

      it('a delivery request writes ONE OD row: wallet 0, vault negative', async () => {
        const { token, id } = await registerCustomer('ledger-test-10@test.dev');
        const pullId = await openOne(token);
        const addressId = await addAddress(token);
        const res = await api.post(
          '/store/delivery-orders',
          { pull_ids: [pullId], address_id: addressId },
          { headers: authed(token) },
        );
        expect(res.status).toBe(201); // matches delivery-orders.spec.ts's OWN create-order assertion

        const rows = await ledgerEntryRowsFor(id, 'OD');
        expect(rows).toHaveLength(1);
        expect(Number(rows[0].wallet_delta)).toBe(0);
        expect(Number(rows[0].vault_delta)).toBeLessThan(0);
      });

      it('a multi-pull order sums EVERY pull, not distinct handles', async () => {
        // Two pulls of the SAME card. vaultValueForPulls reduces over `pulls`,
        // NOT over the deduped `handles` set it builds for the listCards
        // lookup — a dedupe bug there would silently halve the debit and leave
        // the vault overstated forever. Expected: 2 x VALUE_PER_PULL = 240, on
        // ONE row (an order is one debit however many cards it covers).
        const { token, id } = await registerCustomer('ledger-test-13@test.dev');
        const firstPull = await openOne(token, 'ledger-od-topup-multi-1');
        const secondPull = await openOne(token, 'ledger-od-topup-multi-2');
        const addressId = await addAddress(token);
        const res = await api.post(
          '/store/delivery-orders',
          { pull_ids: [firstPull, secondPull], address_id: addressId },
          { headers: authed(token) },
        );
        expect(res.status).toBe(201);

        const rows = await ledgerEntryRowsFor(id, 'OD');
        expect(rows).toHaveLength(1);
        expect(Number(rows[0].vault_delta)).toBe(-2 * VALUE_PER_PULL);
        expect(rows[0].payload).toMatchObject({
          type: 'OD',
          handles: [{ card_handle: CARD_HANDLE, qty: 2 }],
        });
      });

      it('canceling the order writes a SECOND OD row (ref_id cancel:<order_id>) that restores the vault', async () => {
        const { token, id } = await registerCustomer('ledger-test-11@test.dev');
        const pullId = await openOne(token);
        const addressId = await addAddress(token);
        const created = await api.post(
          '/store/delivery-orders',
          { pull_ids: [pullId], address_id: addressId },
          { headers: authed(token) },
        );
        const orderId = created.data.order_id as string;

        await api.post(
          `/store/delivery-orders/${orderId}/cancel`,
          {},
          { headers: authed(token) },
        );

        const rows = await ledgerEntryRowsFor(id, 'OD');
        expect(rows).toHaveLength(2);
        const create = rows.find((r) => Number(r.vault_delta) < 0);
        const cancel = rows.find((r) => Number(r.vault_delta) > 0);
        expect(create).toBeDefined();
        expect(cancel).toBeDefined();
        expect(Number(cancel!.vault_delta)).toBe(-Number(create!.vault_delta)); // exact reversal
        expect(cancel!.ref_id).toBe(`cancel:${orderId}`);
      });

      it('a price move BETWEEN create and cancel still nets the order to exactly 0', async () => {
        // THE reversal invariant. A delivery order sits in 'requested' for
        // days while PriceCharting syncs FMV on a schedule and admins edit
        // market_multiplier — so create-time and cancel-time valuations of the
        // same cards routinely disagree. A cancel that RE-VALUES the pulls at
        // cancel time (rather than negating the stored debit) is therefore a
        // reversal that does not reverse: the round trip is a no-op on actual
        // holdings but writes a permanent, silent non-zero net to cumulative
        // vault_delta with nothing underlying it. Pinned as a sum over BOTH
        // rows so it fails on any drift, in either direction.
        const { token, id } = await registerCustomer('ledger-test-14@test.dev');
        const pullId = await openOne(token);
        const addressId = await addAddress(token);
        const created = await api.post(
          '/store/delivery-orders',
          { pull_ids: [pullId], address_id: addressId },
          { headers: authed(token) },
        );
        const orderId = created.data.order_id as string;

        // Move BOTH price inputs — an FMV sync and a markup edit are the two
        // real-world movers, and each alone would drift the net.
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        const [card] = await packs.listCards(
          { handle: CARD_HANDLE },
          { take: 1 },
        );
        await packs.updateCards([
          {
            id: card.id,
            market_value: FMV * 3,
            market_multiplier: MULTIPLIER * 2,
          },
        ]);

        await api.post(
          `/store/delivery-orders/${orderId}/cancel`,
          {},
          { headers: authed(token) },
        );

        const rows = await ledgerEntryRowsFor(id, 'OD');
        expect(rows).toHaveLength(2);
        const create = rows.find((r) => r.ref_id === orderId);
        const cancel = rows.find((r) => r.ref_id === `cancel:${orderId}`);
        // The debit is still the CREATE-time value, untouched by the move.
        expect(Number(create!.vault_delta)).toBe(-VALUE_PER_PULL);
        expect(Number(cancel!.vault_delta)).toBe(VALUE_PER_PULL);
        const net = rows.reduce((sum, r) => sum + Number(r.vault_delta), 0);
        expect(net).toBe(0);
      });

      it('an admin bulk mark-as-canceled ALSO writes the reversing OD row (one hook, both paths)', async () => {
        // Real route (verified on origin/master): POST /admin/delivery-orders/bulk
        // { ids, status } -> updateDeliveryOrderWorkflow -> the SAME
        // transitionDeliveryOrderStatus this task extends.
        const { token, id: customerId } = await registerCustomer(
          'ledger-test-12@test.dev',
        );
        const pullId = await openOne(token);
        const addressId = await addAddress(token);
        const created = await api.post(
          '/store/delivery-orders',
          { pull_ids: [pullId], address_id: addressId },
          { headers: authed(token) },
        );
        const orderId = created.data.order_id as string;

        const adminToken = await mintSuperAdmin(
          getContainer(),
          api,
          'ledger-od-admin@test.dev',
          'admin-pass-od-1',
        );
        await api.post(
          '/admin/delivery-orders/bulk',
          { ids: [orderId], status: 'canceled' },
          { headers: { authorization: `Bearer ${adminToken}` } },
        );

        const rows = await ledgerEntryRowsFor(customerId, 'OD');
        expect(rows.some((r) => Number(r.vault_delta) > 0)).toBe(true);
      });
    });
  },
});
