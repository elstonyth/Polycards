import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { FREE_PULL_LOCKED_MESSAGE } from '../../src/modules/packs/free-pack';
import { postStoreCustomer, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

const PASSWORD = 'vb-test-password-1';

// Fixture constants — FMV $50 (raw USD) × FX 4.0 × markup 1.2 = RM 240, the
// Value the customer sees. Buyback is a cut of that MYR Value (NOT raw USD): the
// pack's INSTANT rate (96%) credits RM 230.40 inside the post-pull window; once
// the pull is older than the window (default 90s — see buyback-rate.ts) the sell
// pays the FLAT rate (90%), crediting RM 216.00. FX is pinned in beforeEach so
// these stay deterministic (no live feed / DEFAULT_USD_MYR coupling).
const PACK_SLUG = 'vb-pack';
const FREE_PACK_SLUG = 'vb-free-welcome';
const CARD_HANDLE = 'vb-card';
const FMV = 50;
const MULTIPLIER = 1.2;
const MANUAL_RATE = 4.0;
const INSTANT_PERCENT = 96;
const INSTANT_AMOUNT = 230.4; // 96% × (50 × 4.0 × 1.2)
const FLAT_PERCENT = 90;
const FLAT_AMOUNT = 216; // 90% × (50 × 4.0 × 1.2)
const STOCKED = 5;
const PACK_PRICE = 10;
// Opens charge the ledger since Task A2 — fund enough for the 3 opens below.
const TOPUP = 3 * PACK_PRICE;

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('vault → buyback loop', () => {
      let storeHeaders: Record<string, string>;
      let inventoryItemId: string;
      let stockLocationId: string;

      // The runner resets the database between `it` blocks, so the publishable
      // key, the gacha fixtures, and any customers are recreated per test.
      beforeEach(async () => {
        const container = getContainer();

        const apiKeyModule = container.resolve(Modules.API_KEY);
        const key = await apiKeyModule.createApiKeys({
          title: 'vault-buyback-test',
          type: 'publishable',
          created_by: 'vault-buyback-test',
        });
        storeHeaders = { 'x-publishable-api-key': key.token };

        // Gacha fixtures: an active pack with a SINGLE-card pool, so the
        // weighted roll is deterministic (the only card always wins).
        const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
        await packs.createPacks([
          {
            slug: PACK_SLUG,
            title: 'VB Test Pack',
            category: 'pokemon',
            price: 10,
            image: '/cdn/test-pack.webp',
            buyback_percent: INSTANT_PERCENT,
          },
        ]);
        await packs.createCards([
          {
            handle: CARD_HANDLE,
            name: 'VB Test Card PSA 10',
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
        // Pin USD→MYR so buyback amounts are deterministic — the sell path now
        // credits a cut of the FX-converted Value, not raw USD.
        await packs.createFxRates([
          {
            pair: 'USD_MYR',
            rate: MANUAL_RATE,
            source: 'test',
            manual_override: true,
            manual_rate: MANUAL_RATE,
          },
        ]);

        // Tracked physical inventory for the card's product (handle is the
        // shared business key): product variant → (link) → inventory item →
        // location level. Built from plain modules + the link module — the
        // exact traversal card-stock.ts queries.
        const productModule = container.resolve(Modules.PRODUCT);
        const [product] = await productModule.createProducts([
          {
            title: 'VB Test Card PSA 10',
            handle: CARD_HANDLE,
            status: 'published',
            options: [{ title: 'Format', values: ['Slab'] }],
            variants: [
              {
                title: 'Slab',
                sku: `CARD-${CARD_HANDLE.toUpperCase()}`,
                manage_inventory: true,
                options: { Format: 'Slab' },
              },
            ],
          },
        ]);
        const variantId = product.variants[0].id;

        const stockLocationModule = container.resolve(Modules.STOCK_LOCATION);
        const location = await stockLocationModule.createStockLocations({
          name: 'VB Test Warehouse',
        });
        stockLocationId = location.id;

        const inventoryModule = container.resolve(Modules.INVENTORY);
        const item = await inventoryModule.createInventoryItems({
          sku: `CARD-${CARD_HANDLE.toUpperCase()}`,
        });
        inventoryItemId = item.id;
        await inventoryModule.createInventoryLevels([
          {
            inventory_item_id: inventoryItemId,
            location_id: stockLocationId,
            stocked_quantity: STOCKED,
          },
        ]);

        const link = container.resolve(ContainerRegistrationKeys.LINK);
        await link.create({
          [Modules.PRODUCT]: { variant_id: variantId },
          [Modules.INVENTORY]: { inventory_item_id: inventoryItemId },
        });
      });

      const stockedQuantity = async (): Promise<number> => {
        const inventoryModule = getContainer().resolve(Modules.INVENTORY);
        const [level] = await inventoryModule.listInventoryLevels({
          inventory_item_id: inventoryItemId,
        });
        return Number(level.stocked_quantity);
      };

      const request = (
        method: 'get' | 'post',
        path: string,
        headers: Record<string, string>,
      ) =>
        unwrapResponse(
          method === 'get'
            ? api.get(path, { headers })
            : api.post(path, {}, { headers }),
        );

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
        return login.data.token;
      };

      // The register token carries an empty actor_id until the customer row is
      // linked, so derive the id from the authenticated /store/customers/me
      // read rather than from the JWT.
      const customerIdOf = async (token: string): Promise<string> => {
        const me = await request('get', '/store/customers/me', authed(token));
        expect(me.status).toBe(200);
        const id: string = me.data.customer.id;
        expect(id).toBeTruthy();
        return id;
      };

      it('rejects unauthenticated vault access with 401', async () => {
        expect(
          (await request('get', '/store/vault', storeHeaders)).status,
        ).toBe(401);
        expect(
          (await request('get', '/store/credits', storeHeaders)).status,
        ).toBe(401);
        expect(
          (await request('post', '/store/vault/pull-x/buyback', storeHeaders))
            .status,
        ).toBe(401);
      });

      it('open → vault offer → buyback credits Value×% once, restores stock, 404s foreign customers', async () => {
        const tokenA = await registerCustomer('vb-customer-a@test.dev');
        const tokenB = await registerCustomer('vb-customer-b@test.dev');

        // 0. Fund the opens (Task A2: each open debits the pack price; an
        //    unfunded open is the pack-open-charge suite's subject, not ours).
        const fund = await api.post(
          '/store/credits/topup',
          { amount: TOPUP },
          {
            headers: { ...authed(tokenA), 'idempotency-key': 'vb-fund-topup' },
          },
        );
        expect(fund.status).toBe(200);

        // 1. Open the pack — the single-card pool guarantees the winner, and
        //    the response's rarity is the PER-PACK tier from the odds row.
        const open = await request(
          'post',
          `/store/packs/${PACK_SLUG}/open`,
          authed(tokenA),
        );
        expect(open.status).toBe(200);
        expect(open.data.card).toMatchObject({
          handle: CARD_HANDLE,
          rarity: 'Rare',
          market_value: FMV,
        });
        const pullId: string = open.data.pull.id;
        expect(typeof pullId).toBe('string');
        // The open debited exactly the pack price (A2).
        expect(open.data.balance).toBe(TOPUP - PACK_PRICE);

        // 2. The pull earmarked one physical unit.
        expect(await stockedQuantity()).toBe(STOCKED - 1);

        // 3. The vault lists the pull with the live offer — a FRESH pull is
        //    still inside the instant window, so the quote is the instant rate.
        const vault = await request('get', '/store/vault', authed(tokenA));
        expect(vault.status).toBe(200);
        expect(vault.data.items).toHaveLength(1);
        expect(vault.data.items[0]).toMatchObject({
          pull_id: pullId,
          pack_id: PACK_SLUG,
          card: { handle: CARD_HANDLE, rarity: 'Rare', market_value: FMV },
          buyback: {
            percent: INSTANT_PERCENT,
            amount: INSTANT_AMOUNT,
            rate_type: 'instant',
          },
        });

        // 4. Another customer cannot touch the pull — same 404 as an unknown
        //    id, so vault ids don't leak across accounts.
        const foreign = await request(
          'post',
          `/store/vault/${pullId}/buyback`,
          authed(tokenB),
        );
        expect(foreign.status).toBe(404);

        // 5. The owner's buyback (within the window) credits exactly
        //    Value(MYR) × instant % and reports the resulting balance.
        const buyback = await request(
          'post',
          `/store/vault/${pullId}/buyback`,
          authed(tokenA),
        );
        expect(buyback.status).toBe(200);
        expect(buyback.data).toMatchObject({
          pull_id: pullId,
          amount: INSTANT_AMOUNT,
          percent: INSTANT_PERCENT,
          rate_type: 'instant',
          balance: TOPUP - PACK_PRICE + INSTANT_AMOUNT,
        });

        // 6. The physical unit returned to stock.
        expect(await stockedQuantity()).toBe(STOCKED);

        // 7. The credit ledger shows the balance and the full row trail:
        //    topup (+30), pack_open (-10), buyback (+230.40) — newest first.
        const credits = await request('get', '/store/credits', authed(tokenA));
        expect(credits.status).toBe(200);
        expect(credits.data.balance).toBe(TOPUP - PACK_PRICE + INSTANT_AMOUNT);
        expect(credits.data.transactions).toHaveLength(3);
        expect(credits.data.transactions[0]).toMatchObject({
          amount: INSTANT_AMOUNT,
          reason: 'buyback',
          pull_id: pullId,
        });
        expect(credits.data.transactions[1]).toMatchObject({
          amount: -PACK_PRICE,
          reason: 'pack_open',
        });

        // 8. The card left the vault…
        const emptied = await request('get', '/store/vault', authed(tokenA));
        expect(emptied.data.items).toHaveLength(0);

        // 9. …and a second sell of the same pull is rejected (the unique
        //    credit row per pull is DB-enforced).
        const repeat = await request(
          'post',
          `/store/vault/${pullId}/buyback`,
          authed(tokenA),
        );
        expect(repeat.status).toBe(400);
        expect(repeat.data.message).toMatch(/already sold back/i);

        // 10. FLAT RATE: a pull OLDER than the instant window sells at the
        //     site-wide flat % regardless of the pack's rate. Open again, then
        //     backdate rolled_at past the window (default 90s) via the module
        //     service.
        const open2 = await request(
          'post',
          `/store/packs/${PACK_SLUG}/open`,
          authed(tokenA),
        );
        expect(open2.status).toBe(200);
        const pull2Id: string = open2.data.pull.id;
        expect(await stockedQuantity()).toBe(STOCKED - 1);

        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        await packs.updatePulls([
          { id: pull2Id, rolled_at: new Date(Date.now() - 11 * 60 * 1000) },
        ]);

        // The vault now quotes the flat rate for it…
        const vault2 = await request('get', '/store/vault', authed(tokenA));
        expect(vault2.data.items).toHaveLength(1);
        expect(vault2.data.items[0].buyback).toMatchObject({
          percent: FLAT_PERCENT,
          amount: FLAT_AMOUNT,
          rate_type: 'vault',
        });

        // …and the buyback credits exactly that, on top of the prior balance.
        const buyback2 = await request(
          'post',
          `/store/vault/${pull2Id}/buyback`,
          authed(tokenA),
        );
        expect(buyback2.status).toBe(200);
        expect(buyback2.data).toMatchObject({
          pull_id: pull2Id,
          amount: FLAT_AMOUNT,
          percent: FLAT_PERCENT,
          rate_type: 'vault',
          balance: TOPUP - 2 * PACK_PRICE + INSTANT_AMOUNT + FLAT_AMOUNT,
        });
        expect(await stockedQuantity()).toBe(STOCKED);

        // 11. PHANTOM-RESTORE GUARD: a pull made at ZERO stock earmarks nothing,
        //     so its buyback must NOT mint a unit back (stock stays 0 — the
        //     credit itself still works).
        const inventoryModule = getContainer().resolve(Modules.INVENTORY);
        await inventoryModule.adjustInventory(
          inventoryItemId,
          stockLocationId,
          -STOCKED,
        );
        expect(await stockedQuantity()).toBe(0);

        const open3 = await request(
          'post',
          `/store/packs/${PACK_SLUG}/open`,
          authed(tokenA),
        );
        expect(open3.status).toBe(200);
        // Negative-stock counter: opening at 0 stock oversells the unit into the
        // negative (-1) rather than clamping at 0. The phantom-restore invariant is
        // the post-buyback assertion below — stock must return to EXACTLY 0 (the
        // earmark is restored symmetrically, no unit minted above baseline).
        expect(await stockedQuantity()).toBe(-1);

        const buyback3 = await request(
          'post',
          `/store/vault/${open3.data.pull.id}/buyback`,
          authed(tokenA),
        );
        expect(buyback3.status).toBe(200);
        expect(buyback3.data.amount).toBe(INSTANT_AMOUNT); // credit unaffected
        expect(await stockedQuantity()).toBe(0); // and NO phantom unit restored
      });

      // F1: a buyback writes its credit OUTSIDE mutateCreditAtomic, so it must
      // explicitly lift an AUTO freeze once the sale repays the debt — proven
      // here through the REAL /buyback endpoint (the module test exercises the
      // helper directly; this covers the step wiring + best-effort contract).
      it('buyback lifts an AUTO freeze once the sale repays the balance to >= 0', async () => {
        const token = await registerCustomer('vb-frozen@test.dev');
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);

        // A vaulted pull to sell. After this the balance is TOPUP - PACK_PRICE.
        await api.post(
          '/store/credits/topup',
          { amount: TOPUP },
          {
            headers: { ...authed(token), 'idempotency-key': 'vb-frozen-topup' },
          },
        );
        const open = await request(
          'post',
          `/store/packs/${PACK_SLUG}/open`,
          authed(token),
        );
        const pullId: string = open.data.pull.id;
        const [pull] = await packs.listPulls({ id: pullId }, { take: 1 });
        const customerId = pull.customer_id;

        // Recreate the clawback aftermath: drive the balance NEGATIVE (written
        // directly, bypassing the overdraft floor) and AUTO-freeze the account —
        // chosen so the instant buyback (+230.40) lands the balance back at >= 0.
        const debit = -(TOPUP - PACK_PRICE + 8); // balance -> -8
        await packs.createCreditTransactions([
          {
            customer_id: customerId,
            amount: debit,
            reason: 'adjustment' as const,
          },
        ]);
        // UPDATE, not create: this customer registered for real, so the
        // customer.created free-pack subscriber has already upserted their
        // customer_account_state row (customer_id is unique — inserting a
        // second one raises "already exists"). postStoreCustomer drains that
        // subscriber, so the row is guaranteed to be here.
        await packs.updateCustomerAccountStates({
          selector: { customer_id: customerId },
          data: {
            frozen: true,
            cause: 'auto' as const,
            frozen_reason: 'clawback:open_x',
            frozen_at: new Date(),
          },
        });

        // The owner sells the card — a frozen account can still buy back, and the
        // +230.40 credit lands the balance at +222.40 (>= 0), clearing the freeze.
        const buyback = await request(
          'post',
          `/store/vault/${pullId}/buyback`,
          authed(token),
        );
        expect(buyback.status).toBe(200);
        expect(buyback.data.balance).toBe(
          TOPUP - PACK_PRICE + debit + INSTANT_AMOUNT,
        );

        const [after] = await packs.listCustomerAccountStates(
          { customer_id: customerId },
          { take: 1 },
        );
        expect(after.frozen).toBe(false);
        expect(after.unfreeze_cause).toBe('repaid');
      });

      // A weekly-challenge prize is minted source='reward' against a synthetic
      // `challenge-<week>` pack. Before this, the vault route sent it down the
      // reward branch (no card, no buyback) and the storefront schema dropped
      // it outright — a WON card rendered as nothing at all, and selling it was
      // refused by the reward-box guard. Operator decision: a won card behaves
      // like a pulled one.
      it('a weekly-challenge prize shows in the vault as a card and sells back', async () => {
        const token = await registerCustomer('vb-prize@test.dev');
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        const customerId = await customerIdOf(token);

        // Mint the prize exactly as challenge settlement does.
        const [prize] = await packs.createPulls([
          {
            customer_id: customerId,
            pack_id: 'challenge-2026-07-19',
            card_id: CARD_HANDLE,
            order_id: null,
            rolled_at: new Date(),
            status: 'vaulted' as const,
            source: 'reward' as const,
          },
        ]);

        const vault = await request('get', '/store/vault', authed(token));
        expect(vault.status).toBe(200);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const row = vault.data.items.find((i: any) => i.pull_id === prize.id);
        expect(row).toBeDefined();
        // It renders as a CARD (name + buyback), not a bare reward row …
        expect(row.card.name).toBe('VB Test Card PSA 10');
        expect(row.buyback.amount).toBeGreaterThan(0);
        // … it is flagged so the storefront can wear the challenge frame …
        expect(row.challenge_prize).toBe(true);
        expect(row.pack_title).toBe('Weekly Challenge');
        // … its tier comes from the live pack, not the synthetic one …
        expect(row.card.rarity).toBe('Rare');
        // … and it sells like any pulled card.
        const sell = await request(
          'post',
          `/store/vault/${prize.id}/buyback`,
          authed(token),
        );
        expect(sell.status).toBe(200);
        expect(sell.data.amount).toBe(row.buyback.amount);
      });

      // Free welcome pull (spec 2026-08-14): locked from sell/deliver until the
      // customer's first PAID open. The module suite proves the guard; this is
      // the HTTP-tier pin the Task 6 review asked for — the refusal's STATUS and
      // COPY as the storefront receives them, plus the unlock through a real
      // paid open (not a hand-written source='pack' row).
      it('refuses a free welcome pull with 400 until a paid open, then sells it', async () => {
        const token = await registerCustomer('vb-freepack@test.dev');
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        await packs.createPacks([
          {
            slug: FREE_PACK_SLUG,
            title: 'VB Free Welcome Pack',
            category: 'free_welcome',
            price: 0,
            image: '/cdn/free-pack.webp',
          },
        ]);
        const [free] = await packs.createPulls([
          {
            customer_id: await customerIdOf(token),
            pack_id: FREE_PACK_SLUG,
            card_id: CARD_HANDLE,
            order_id: null,
            rolled_at: new Date(),
            status: 'vaulted' as const,
            source: 'free' as const,
          },
        ]);

        const locked = await request(
          'post',
          `/store/vault/${free.id}/buyback`,
          authed(token),
        );
        expect(locked.status).toBe(400);
        expect(locked.data.message).toBe(FREE_PULL_LOCKED_MESSAGE);

        // The first PAID open — through the real route — lifts the lock.
        await api.post(
          '/store/credits/topup',
          { amount: TOPUP },
          { headers: { ...authed(token), 'idempotency-key': 'vb-free-topup' } },
        );
        const paid = await request(
          'post',
          `/store/packs/${PACK_SLUG}/open`,
          authed(token),
        );
        expect(paid.status).toBe(200);

        const sell = await request(
          'post',
          `/store/vault/${free.id}/buyback`,
          authed(token),
        );
        expect(sell.status).toBe(200);
        expect(sell.data.amount).toBeGreaterThan(0);
      });

      // The reward-box guard must still refuse an actual reward-box prize —
      // widening it for challenge prizes must not open the sentinel path.
      it('still refuses to sell a reward-box prize', async () => {
        const token = await registerCustomer('vb-rewardbox@test.dev');
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        const [prize] = await packs.createPulls([
          {
            customer_id: await customerIdOf(token),
            pack_id: 'reward-box-gold',
            card_id: CARD_HANDLE,
            order_id: null,
            rolled_at: new Date(),
            status: 'vaulted' as const,
            source: 'reward' as const,
          },
        ]);
        const sell = await request(
          'post',
          `/store/vault/${prize.id}/buyback`,
          authed(token),
        );
        expect(sell.status).toBe(400);
      });
    });
  },
});
