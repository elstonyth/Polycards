import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils';
import type { IEventBusModuleService } from '@medusajs/framework/types';
import { computeSetWeights } from '@acme/odds-math';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { clearPackDetailCache } from '../../src/api/store/packs/[slug]/route';
import { clearPackListCache } from '../../src/api/store/packs/route';
import { clearAdminPackListCache } from '../../src/api/admin/packs/route';
import { clearLosslessDisplayMemo } from '../../src/api/store/packs/lossless-display';
import { mintSuperAdmin, postStoreCustomer, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

// The guard reads the report key per request, so setting it here is enough.
const FINANCE_KEY = 'f'.repeat(48);
process.env.REPORT_KEY_FINANCE = FINANCE_KEY;

// Lucky Pack ticket spins (spec 2026-10-30), through the real routes. The money
// rule: a customer is never charged without their tickets, and never gets tickets
// without being charged. A ticket pack writes no pull, vault row or stock move,
// and a card pack's open-batch stays exactly as it was.

const PASSWORD = 'ticket-spin-password-1';
const ADMIN_EMAIL = 'ticket-spin-admin@test.dev';
const PACK = 'lucky-test';
const PRICE = 10;
const IMAGE = '/images/lucky-draw/ticket.webp';

type Row = {
  tickets: number;
  rarity: string;
  locked: boolean;
  pct: number;
  pct_2: number | null;
  pct_3: number | null;
};

// One locked row at 100% makes every spin deterministic.
const only = (tickets: number, rarity = 'Rare'): Row[] => [
  { tickets, rarity, locked: true, pct: 100, pct_2: null, pct_3: null },
];

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    let storeHeaders: Record<string, string>;
    let customerToken: string;
    let customerId: string;
    let adminToken: string;

    const packs = () =>
      getContainer().resolve<PacksModuleService>(PACKS_MODULE);
    const authed = () => ({
      ...storeHeaders,
      authorization: `Bearer ${customerToken}`,
    });
    const admin = () => ({ authorization: `Bearer ${adminToken}` });

    const deposit = (amount: number) =>
      packs().mutateCreditAtomic({
        customerId,
        amount,
        reason: 'topup',
        reference: `ticket-spin-${amount}`,
      });
    const grantBonus = (amount: number) =>
      unwrapResponse(
        api.post(
          `/admin/customers/${customerId}/credits`,
          { amount, note: 'test bonus', idempotency_key: 'b1', kind: 'bonus' },
          { headers: admin() },
        ),
      );
    const createPack = (body: Record<string, unknown> = {}) =>
      unwrapResponse(
        api.post(
          '/admin/packs',
          {
            slug: PACK,
            title: 'Lucky Test Pack',
            category: 'poly',
            prize_type: 'tickets',
            price: PRICE,
            image: '/cdn/lucky.webp',
            buyback_percent: 90,
            boost: false,
            rank: 0,
            status: 'draft',
            ...body,
          },
          { headers: admin() },
        ),
      );
    const updatePack = (body: Record<string, unknown>) =>
      unwrapResponse(
        api.post(
          `/admin/packs/${PACK}`,
          {
            title: 'Lucky Test Pack',
            category: 'poly',
            price: PRICE,
            image: '/cdn/lucky.webp',
            buyback_percent: 90,
            boost: false,
            rank: 0,
            ...body,
          },
          { headers: admin() },
        ),
      );
    const saveRows = (rows: unknown, slug = PACK) =>
      unwrapResponse(
        api.post(
          `/admin/packs/${slug}/ticket-prizes`,
          { rows },
          { headers: admin() },
        ),
      );
    const readRows = (slug = PACK) =>
      unwrapResponse(
        api.get(`/admin/packs/${slug}/ticket-prizes`, { headers: admin() }),
      );
    const livePack = async (rows: Row[] = only(100)) => {
      expect((await createPack()).status).toBe(201);
      expect((await saveRows(rows)).status).toBe(200);
      expect((await updatePack({ status: 'active' })).status).toBe(200);
    };
    const openBatch = (count: number, extra: Record<string, unknown> = {}) =>
      unwrapResponse(
        api.post(
          `/store/packs/${PACK}/open-batch`,
          { count, ...extra },
          { headers: authed() },
        ),
      );

    const spins = () =>
      packs().listTicketSpins({ customer_id: customerId }, { take: 100 });
    const ticketRows = () =>
      packs().listLuckyDrawTickets({ customer_id: customerId }, { take: 100 });
    const debits = () =>
      packs().listCreditTransactions(
        { customer_id: customerId, reason: 'pack_open' },
        { take: 100 },
      );
    const spEntries = () =>
      packs().listLedgerEntries(
        { type: 'SP', customer_id: customerId },
        { take: 100 },
      );
    const expectNothingWritten = async (balance: number) => {
      expect(await spins()).toHaveLength(0);
      expect(await ticketRows()).toHaveLength(0);
      expect(await debits()).toHaveLength(0);
      expect(await spEntries()).toHaveLength(0);
      expect(await packs().creditBalance(customerId)).toBe(balance);
    };

    beforeEach(async () => {
      clearPackDetailCache();
      clearPackListCache();
      clearAdminPackListCache();
      const container = getContainer();
      const key = await container.resolve(Modules.API_KEY).createApiKeys({
        title: 'ticket-spin-test',
        type: 'publishable',
        created_by: 'ticket-spin-test',
      });
      storeHeaders = { 'x-publishable-api-key': key.token };
      adminToken = await mintSuperAdmin(
        container,
        api,
        ADMIN_EMAIL,
        PASSWORD,
      );

      const email = 'ticket-spin-customer@test.dev';
      const reg = await api.post('/auth/customer/emailpass/register', {
        email,
        password: PASSWORD,
      });
      const created = await postStoreCustomer(
        api,
        container,
        { email },
        {
          headers: {
            ...storeHeaders,
            authorization: `Bearer ${reg.data.token}`,
          },
        },
      );
      customerId = created.data.customer.id;
      const login = await api.post('/auth/customer/emailpass', {
        email,
        password: PASSWORD,
      });
      customerToken = login.data.token;
    });

    describe('the spin', () => {
      it('charges once and credits every spin together, for a batch of 3', async () => {
        await livePack();
        await deposit(100);

        const res = await openBatch(3);
        expect(res.status).toBe(200);
        expect(res.data).toEqual({
          prize_type: 'tickets',
          rolls: Array.from({ length: 3 }, () => ({
            pull: null,
            card: null,
            buyback: null,
            ticket_spin: {
              id: expect.stringMatching(/^tksp_/),
              tickets: 100,
              rarity: 'Rare',
              rolled_at: expect.any(String),
            },
          })),
          price: PRICE,
          total_charged: 30,
          balance: 70,
          ticket_balance: 300,
          gifts_used: 0,
        });

        const [debit, ...moreDebits] = await debits();
        expect(moreDebits).toHaveLength(0);
        expect(Number(debit.amount)).toBe(-30);
        const openId = debit.source_transaction_id;
        expect(openId).toEqual(expect.any(String));

        const spinRows = await spins();
        expect(spinRows).toHaveLength(3);
        for (const s of spinRows) {
          expect(s).toMatchObject({
            customer_id: customerId,
            pack_id: PACK,
            tickets: 100,
            source: 'pack',
            bonus_bp: 0,
            open_id: openId,
          });
        }

        // One credit per spin, the spin's id as its ref.
        const credits = await ticketRows();
        expect(credits).toHaveLength(3);
        expect(credits.map((c) => c.ref).sort()).toEqual(
          spinRows.map((s) => s.id).sort(),
        );
        for (const c of credits) {
          expect(c).toMatchObject({ delta: 100, reason: 'pack_spin' });
        }
        expect(await packs().luckyDrawBalance(customerId)).toBe(300);
        expect(await packs().creditBalance(customerId)).toBe(70);

        const [sp, ...moreSp] = await spEntries();
        expect(moreSp).toHaveLength(0);
        expect(sp.ref_id).toBe(openId);
        expect(Number(sp.wallet_delta)).toBe(-30);
        expect(Number(sp.vault_delta)).toBe(0);
        expect(sp.payload).toEqual({
          type: 'SP',
          channel: 'batch',
          pack_id: PACK,
          prize_skus: [],
        });
      });

      it('pays with bonus credit first and stamps each row with its share', async () => {
        await livePack();
        await deposit(100);
        expect((await grantBonus(15)).status).toBe(200);

        const res = await openBatch(3);
        expect(res.status).toBe(200);
        expect(res.data.balance).toBe(85);

        const [debit] = await debits();
        expect(debit.bonus_cents).toBe(-1500);
        // RM 15 of bonus over three RM 10 rows: all, half, none.
        const ids = res.data.rolls.map(
          (r: { ticket_spin: { id: string } }) => r.ticket_spin.id,
        );
        const byId = new Map((await spins()).map((s) => [s.id, s]));
        expect(ids.map((id: string) => byId.get(id)?.bonus_bp)).toEqual([
          10_000, 5_000, 0,
        ]);
        expect(ids.map((id: string) => byId.get(id)?.source)).toEqual([
          'bonus',
          'bonus',
          'pack',
        ]);
        const [sp] = await spEntries();
        expect(sp.payload).toMatchObject({ bonus: 15 });
      });

      it('rolls on the rate set of the customer group', async () => {
        await livePack([
          {
            tickets: 10,
            rarity: 'Common',
            locked: true,
            pct: 100,
            pct_2: 0,
            pct_3: null,
          },
          {
            tickets: 500,
            rarity: 'Rare',
            locked: true,
            pct: 0,
            pct_2: 100,
            pct_3: null,
          },
        ]);
        await deposit(100);

        const before = await openBatch(1);
        expect(before.data.rolls[0].ticket_spin.tickets).toBe(10);

        const customers = getContainer().resolve(Modules.CUSTOMER);
        const group = await customers.createCustomerGroups({
          name: 'set-two',
          metadata: { odds_set: 2 },
        });
        await customers.addCustomerToGroup({
          customer_id: customerId,
          customer_group_id: group.id,
        });
        const after = await openBatch(1);
        expect(after.data.rolls[0].ticket_spin.tickets).toBe(500);
      });

      it('writes nothing when the money does not cover the batch', async () => {
        await livePack();
        await deposit(25);

        const res = await openBatch(3);
        expect(res.status).toBe(400);
        expect(res.data.message).toMatch(/not enough credits/i);
        await expectNothingWritten(25);
      });

      it('writes nothing for a frozen account', async () => {
        await livePack();
        await deposit(100);
        await packs().setManualFreeze({
          customerId,
          adminId: 'admin_x',
          reason: 'test freeze',
        });

        const res = await openBatch(1);
        expect(res.status).toBe(400);
        expect(res.data.message).toMatch(/frozen/i);
        await expectNothingWritten(100);
      });

      it('refuses a draft and a sold-out pack before any charge', async () => {
        expect((await createPack()).status).toBe(201);
        expect((await saveRows(only(100))).status).toBe(200);
        await deposit(100);

        const draft = await openBatch(1);
        expect(draft.status).toBe(404);
        await expectNothingWritten(100);

        expect(
          (await updatePack({ status: 'active', in_stock: false })).status,
        ).toBe(200);
        const soldOut = await openBatch(1);
        expect(soldOut.status).toBe(400);
        expect(soldOut.data.message).toMatch(/sold out/i);
        await expectNothingWritten(100);
      });

      it('refuses a gifted spin', async () => {
        await livePack();
        await deposit(100);
        const gifted = await openBatch(1, { gifts: 1 });
        expect(gifted.status).toBe(400);
        await expectNothingWritten(100);
      });

      it('settleTicketSpins re-checks everything itself, before the debit', async () => {
        await livePack();
        await deposit(100);
        const settle = (input: {
          packSlug?: string;
          unitPrice?: number;
          rolls?: { tickets: number }[];
        }) =>
          packs().settleTicketSpins({
            customerId,
            packSlug: PACK,
            unitPrice: PRICE,
            rolls: [{ tickets: 100 }],
            openId: 'open_direct',
            ...input,
          });

        await expect(settle({ rolls: [] })).rejects.toThrow(/1 to 3/);
        await expect(
          settle({ rolls: Array(4).fill({ tickets: 100 }) }),
        ).rejects.toThrow(/1 to 3/);
        await expect(settle({ rolls: [{ tickets: 0 }] })).rejects.toThrow(
          /1 to 3/,
        );
        // A stale price, and a free spin: no price, no tickets.
        await expect(settle({ unitPrice: 9 })).rejects.toThrow(/price/);
        await expect(settle({ unitPrice: 0 })).rejects.toThrow(/price/);
        await expect(settle({ packSlug: 'no-such-pack' })).rejects.toThrow(
          /not available/,
        );

        expect((await updatePack({ status: 'draft' })).status).toBe(200);
        await expect(settle({})).rejects.toThrow(/not available/);
        await expectNothingWritten(100);
      });

      it.each([
        'createTicketSpins',
        'createLuckyDrawTickets',
        'recordLedgerEntry',
      ] as const)('a failure in %s rolls the debit back too', async (method) => {
        await livePack();
        await deposit(100);
        const spy = jest
          .spyOn(packs(), method as 'recordLedgerEntry')
          .mockRejectedValueOnce(new Error('after the debit'));
        try {
          const res = await openBatch(3);
          expect(res.status).toBe(500);
          expect(spy).toHaveBeenCalled();
        } finally {
          spy.mockRestore();
        }
        await expectNothingWritten(100);
      });

      it('lets only one of two racing spins take the last of the money', async () => {
        await livePack();
        await deposit(30);

        const [a, b] = await Promise.all([openBatch(3), openBatch(3)]);
        expect([a.status, b.status].sort()).toEqual([200, 400]);
        expect(await spins()).toHaveLength(3);
        expect(await packs().luckyDrawBalance(customerId)).toBe(300);
        expect(await packs().creditBalance(customerId)).toBe(0);
        expect(await debits()).toHaveLength(1);
      });

      it('never creates a pull, a vault row or a stock move', async () => {
        await livePack();
        await deposit(100);
        expect((await openBatch(3)).status).toBe(200);

        expect(await packs().listPulls({}, { take: 10 })).toHaveLength(0);
        expect(await packs().listStockMovements({}, { take: 10 })).toHaveLength(
          0,
        );
        const vault = await unwrapResponse(
          api.get('/store/vault', { headers: authed() }),
        );
        expect(vault.status).toBe(200);
        expect(vault.data.items).toEqual([]);
      });

      it('names the ticket pack in the transaction history', async () => {
        await livePack();
        await deposit(100);
        expect((await openBatch(2)).status).toBe(200);

        const res = await unwrapResponse(
          api.get('/store/credits', { headers: authed() }),
        );
        expect(res.status).toBe(200);
        const row = res.data.transactions.find(
          (t: { reason: string }) => t.reason === 'pack_open',
        );
        expect(row).toMatchObject({
          amount: -20,
          pack_title: 'Lucky Test Pack',
          card_names: [],
        });
      });

      it('settles VIP after commit, and a VIP failure never voids the spin', async () => {
        await livePack();
        await deposit(100);
        const grant = jest
          .spyOn(packs(), 'grantLevelUpRewards')
          .mockRejectedValueOnce(new Error('vip down'));
        const eventBus = getContainer().resolve<IEventBusModuleService>(
          Modules.EVENT_BUS,
        );
        const emit = jest.spyOn(eventBus, 'emit');
        try {
          const res = await openBatch(1);
          expect(res.status).toBe(200);
          const [debit] = await debits();
          const openId = debit.source_transaction_id;
          expect(grant).toHaveBeenCalledWith(customerId, openId);
          const emitted = emit.mock.calls.flatMap(([events]) =>
            Array.isArray(events) ? events : [events],
          );
          expect(emitted).toContainEqual(
            expect.objectContaining({
              name: 'vip.spend_settled',
              data: { customer_id: customerId, open_id: openId },
            }),
          );
        } finally {
          grant.mockRestore();
          emit.mockRestore();
        }
        expect(await packs().luckyDrawBalance(customerId)).toBe(100);
        expect(await packs().creditBalance(customerId)).toBe(90);
      });

      it('still answers 200 when the event bus fails after the commit', async () => {
        await livePack();
        await deposit(100);
        const eventBus = getContainer().resolve<IEventBusModuleService>(
          Modules.EVENT_BUS,
        );
        const emit = jest
          .spyOn(eventBus, 'emit')
          .mockRejectedValueOnce(new Error('bus down'));
        try {
          const res = await openBatch(1);
          expect(res.status).toBe(200);
          expect(res.data.ticket_balance).toBe(100);
          expect(emit).toHaveBeenCalled();
        } finally {
          emit.mockRestore();
        }
        expect(await packs().creditBalance(customerId)).toBe(90);
      });

      it('refuses the single open route with 400', async () => {
        await livePack();
        await deposit(100);
        const res = await unwrapResponse(
          api.post(`/store/packs/${PACK}/open`, {}, { headers: authed() }),
        );
        expect(res.status).toBe(400);
        await expectNothingWritten(100);
      });
    });

    describe('a card pack', () => {
      it('keeps its open-batch response exactly as it was', async () => {
        await packs().createPacks([
          {
            slug: 'card-pack',
            title: 'Card Pack',
            category: 'pokemon',
            price: PRICE,
            image: '/cdn/card-pack.webp',
            buyback_percent: 90,
          },
        ]);
        await packs().createCards([
          {
            handle: 'card-a',
            name: 'Card A PSA 10',
            set: 'Test Set',
            grader: 'PSA',
            grade: '10',
            market_value: 50,
            image: '/cdn/card-a.webp',
          },
        ]);
        await packs().createPackOdds([
          {
            pack_id: 'card-pack',
            card_id: 'card-a',
            weight: 100,
            locked: false,
            rarity: 'Rare' as const,
          },
        ]);
        await deposit(100);

        const res = await unwrapResponse(
          api.post(
            '/store/packs/card-pack/open-batch',
            { count: 2 },
            { headers: authed() },
          ),
        );
        expect(res.status).toBe(200);
        expect(Object.keys(res.data).sort()).toEqual([
          'balance',
          'gifts_used',
          'price',
          'rolls',
          'total_charged',
        ]);
        for (const roll of res.data.rolls) {
          expect(Object.keys(roll).sort()).toEqual(['buyback', 'card', 'pull']);
          expect(roll.pull.card_id).toBe('card-a');
          expect(roll.card.handle).toBe('card-a');
        }
        expect(res.data).toMatchObject({
          price: PRICE,
          total_charged: 20,
          balance: 80,
          gifts_used: 0,
        });
        expect(await spins()).toHaveLength(0);
        expect(await ticketRows()).toHaveLength(0);
        expect(await packs().listPulls({}, { take: 10 })).toHaveLength(2);

        const detail = await unwrapResponse(
          api.get('/store/packs/card-pack', { headers: storeHeaders }),
        );
        expect(detail.data.prize_type).toBe('cards');
        expect(detail.data.pack.prize_type).toBe('cards');
        expect(detail.data.odds[0].handle).toBe('card-a');
      });
    });

    describe('admin', () => {
      it('balances a save the way a card pack does, and audits it', async () => {
        expect((await createPack()).status).toBe(201);
        const rows: Row[] = [
          {
            tickets: 1000,
            rarity: 'Immortal',
            locked: true,
            pct: 1,
            pct_2: null,
            pct_3: null,
          },
          {
            tickets: 100,
            rarity: 'Rare',
            locked: false,
            pct: 9,
            pct_2: 19,
            pct_3: null,
          },
          {
            tickets: 10,
            rarity: 'Common',
            locked: false,
            pct: 0,
            pct_2: null,
            pct_3: null,
          },
        ];
        expect((await saveRows(rows)).status).toBe(200);

        // The same maths on the same numbers.
        const expected = computeSetWeights(
          rows.map(({ tickets, ...r }) => ({
            ...r,
            card_id: `tickets-${tickets}`,
          })),
        );
        expect(expected.error).toBeNull();
        const read = await readRows();
        expect(read.status).toBe(200);
        expect(read.data.rows).toEqual(
          [...rows]
            .sort((a, b) => a.tickets - b.tickets)
            .map((r) => {
              const w = expected.rows.find(
                (e) => e.card_id === `tickets-${r.tickets}`,
              )!;
              return {
                tickets: r.tickets,
                rarity: r.rarity,
                weight: w.weight,
                weight_2: w.weight_2,
                weight_3: w.weight_3,
                locked: r.locked,
              };
            }),
        );
        // Common is the balancer: 100 − 1 − 9.
        const common = read.data.rows.find(
          (r: { tickets: number }) => r.tickets === 10,
        );
        expect(common.weight).toBe(900_000);
        const sum = read.data.rows.reduce(
          (s: number, r: { weight: number }) => s + r.weight,
          0,
        );
        expect(sum).toBe(1_000_000);

        const audits = () =>
          packs().listAdminActionAudits(
            { entity_id: PACK, action: 'edit_odds' },
            { take: 10 },
          );
        const [audit, ...more] = await audits();
        expect(more).toHaveLength(0);
        expect(audit.before).toEqual({ ticket_prizes: [] });
        expect(
          (audit.after as { ticket_prizes: unknown[] }).ticket_prizes,
        ).toHaveLength(3);
        // A save that changed nothing writes no row.
        expect((await saveRows(rows)).status).toBe(200);
        expect(await audits()).toHaveLength(1);
      });

      it('refuses a bad table', async () => {
        expect((await createPack()).status).toBe(201);
        expect((await saveRows(undefined)).status).toBe(400);
        expect((await saveRows([])).status).toBe(400);
        expect(
          (await saveRows([...only(100), ...only(100)])).status,
        ).toBe(400);
        // An event sums entries into an int4 total: a huge amount won a few thousand
        // times would overflow it and block the draw for good.
        expect((await saveRows(only(10_001))).status).toBe(400);
        expect(
          (
            await saveRows([
              {
                tickets: 100,
                rarity: 'Rare',
                locked: true,
                pct: 60,
                pct_2: null,
                pct_3: null,
              },
              {
                tickets: 200,
                rarity: 'Rare',
                locked: true,
                pct: 60,
                pct_2: null,
                pct_3: null,
              },
            ])
          ).status,
        ).toBe(400);
        expect((await saveRows(only(100), 'no-such-pack')).status).toBe(404);
        expect((await readRows('no-such-pack')).status).toBe(404);
        expect((await readRows()).data.rows).toEqual([]);
        expect((await saveRows(only(10_000))).status).toBeLessThan(400);
      });

      it('applies a changed table to later spins only, and can re-add an amount', async () => {
        await livePack(only(100));
        await deposit(100);
        const first = await openBatch(1);
        expect(first.data.rolls[0].ticket_spin.tickets).toBe(100);

        // 100 goes, 500 comes, on a pack that stays live.
        expect((await saveRows(only(500))).status).toBe(200);
        const second = await openBatch(1);
        expect(second.data.rolls[0].ticket_spin.tickets).toBe(500);
        expect(second.data.ticket_balance).toBe(600);

        const byId = new Map((await spins()).map((s) => [s.id, s.tickets]));
        expect(byId.get(first.data.rolls[0].ticket_spin.id)).toBe(100);
        expect(byId.get(second.data.rolls[0].ticket_spin.id)).toBe(500);
        expect(
          (await readRows()).data.rows.map(
            (r: { tickets: number }) => r.tickets,
          ),
        ).toEqual([500]);

        // A removed amount's row is soft-deleted, so the amount can come back as
        // a new row, while an amount that stays keeps its row.
        const [fiveHundred] = await packs().listTicketPrizes({ pack_id: PACK });
        expect((await saveRows(only(100))).status).toBe(200);
        const [hundred] = await packs().listTicketPrizes({ pack_id: PACK });
        expect(
          (
            await saveRows([
              { ...only(100)[0], pct: 50 },
              { ...only(500, 'Common')[0], locked: false, pct: 0 },
            ])
          ).status,
        ).toBe(200);
        const amounts = await packs().listTicketPrizes({ pack_id: PACK });
        expect(amounts.map((r) => r.tickets).sort((a, b) => a - b)).toEqual([
          100, 500,
        ]);
        expect(amounts.find((r) => r.tickets === 100)?.id).toBe(hundred.id);
        expect(amounts.find((r) => r.tickets === 500)?.id).not.toBe(
          fiveHundred.id,
        );
      });

      it('fixes prize_type at creation and guards activation', async () => {
        const bad = await createPack({ prize_type: 'coins' });
        expect(bad.status).toBe(400);
        expect((await createPack()).status).toBe(201);

        // Admin reads see the type: it is what opens the ticket editor.
        const one = await unwrapResponse(
          api.get(`/admin/packs/${PACK}`, { headers: admin() }),
        );
        expect(one.data.pack.prize_type).toBe('tickets');
        const list = await unwrapResponse(
          api.get('/admin/packs', { headers: admin() }),
        );
        expect(
          list.data.packs.find((p: { slug: string }) => p.slug === PACK)
            .prize_type,
        ).toBe('tickets');

        // No amounts yet: it cannot go live.
        const early = await updatePack({ status: 'active' });
        expect(early.status).toBe(400);
        expect(early.data.message).toMatch(/ticket amounts/i);

        expect((await saveRows(only(100))).status).toBe(200);
        // Omitting it keeps it, sending another type is refused.
        expect((await updatePack({ status: 'draft' })).status).toBe(200);
        const changed = await updatePack({ prize_type: 'cards' });
        expect(changed.status).toBe(400);
        expect(changed.data.message).toMatch(/prize type/i);
        expect((await updatePack({ status: 'active' })).status).toBe(200);
        const [pack] = await packs().listPacks({ slug: PACK });
        expect(pack.prize_type).toBe('tickets');
        expect(pack.status).toBe('active');
      });

      it('refuses a ticket pack on the card routes, and a card pack on the ticket route', async () => {
        await livePack();
        const odds = await unwrapResponse(
          api.post(
            `/admin/packs/${PACK}/odds`,
            { entries: [] },
            { headers: admin() },
          ),
        );
        expect(odds.status).toBe(400);
        const members = await unwrapResponse(
          api.post(
            `/admin/packs/${PACK}/members`,
            { card_ids: [] },
            { headers: admin() },
          ),
        );
        expect(members.status).toBe(400);

        expect(
          (await createPack({ slug: 'plain-cards', prize_type: 'cards' }))
            .status,
        ).toBe(201);
        expect((await saveRows(only(100), 'plain-cards')).status).toBe(400);
        expect((await readRows('plain-cards')).status).toBe(400);
      });

      it('deletes the table with the pack', async () => {
        await livePack();
        const res = await unwrapResponse(
          api.delete(`/admin/packs/${PACK}`, { headers: admin() }),
        );
        expect(res.status).toBe(200);
        expect(await packs().listTicketPrizes({ pack_id: PACK })).toEqual([]);
        // Coming back under the same slug starts empty.
        expect((await createPack()).status).toBe(201);
        expect((await readRows()).data.rows).toEqual([]);
      });
    });

    describe('the store responses', () => {
      it('carry the prize type and the amounts, never a rate', async () => {
        const published = {
          overall: 100,
          tiers: { Common: 90, Rare: 10 },
          decimals: 2,
        };
        expect(
          (await createPack({ published_odds: published })).status,
        ).toBe(201);
        expect(
          (
            await saveRows([
              {
                tickets: 100,
                rarity: 'Rare',
                locked: true,
                pct: 2,
                pct_2: null,
                pct_3: 5,
              },
              {
                tickets: 10,
                rarity: 'Common',
                locked: false,
                pct: 0,
                pct_2: null,
                pct_3: null,
              },
            ])
          ).status,
        ).toBe(200);
        expect((await updatePack({ status: 'active' })).status).toBe(200);

        const detail = await unwrapResponse(
          api.get(`/store/packs/${PACK}`, { headers: storeHeaders }),
        );
        expect(detail.status).toBe(200);
        expect(JSON.stringify(detail.data)).not.toMatch(/weight/);
        expect(detail.data.prize_type).toBe('tickets');
        expect(detail.data.pack).toMatchObject({
          slug: PACK,
          prize_type: 'tickets',
          price: PRICE,
        });
        expect(detail.data.odds).toEqual([
          {
            handle: 'tickets-10',
            tickets: 10,
            name: '10 Tickets',
            rarity: 'Common',
            market_value: 0,
            image: IMAGE,
          },
          {
            handle: 'tickets-100',
            tickets: 100,
            name: '100 Tickets',
            rarity: 'Rare',
            market_value: 0,
            image: IMAGE,
          },
        ]);
        expect(detail.data.published_odds).toEqual(published);
        // One row per tier, so set 3's split would be each amount's real rate.
        expect(detail.data.demo_odds).toBeNull();

        const list = await unwrapResponse(
          api.get('/store/packs', { headers: storeHeaders }),
        );
        expect(JSON.stringify(list.data)).not.toMatch(/weight/);
        expect(
          list.data.packs.find((p: { slug: string }) => p.slug === PACK)
            .prize_type,
        ).toBe('tickets');

        // A save reaches the cached detail at once.
        expect((await saveRows(only(777))).status).toBe(200);
        const fresh = await unwrapResponse(
          api.get(`/store/packs/${PACK}`, { headers: storeHeaders }),
        );
        expect(
          fresh.data.odds.map((o: { tickets: number }) => o.tickets),
        ).toEqual([777]);
      });
    });

    // A card pack beside the ticket pack: the same surfaces still take it.
    const CUSTOMER_EMAIL = 'ticket-spin-customer@test.dev';
    const CARD_PACK = 'card-pack';
    const seedCardPack = async () => {
      await packs().createPacks([
        {
          slug: CARD_PACK,
          title: 'Card Pack',
          category: 'pokemon',
          price: PRICE,
          image: '/cdn/card-pack.webp',
          buyback_percent: 90,
        },
      ]);
      await packs().createCards([
        {
          handle: 'card-a',
          name: 'Card A PSA 10',
          set: 'Test Set',
          grader: 'PSA',
          grade: '10',
          market_value: 50,
          image: '/cdn/card-a.webp',
        },
      ]);
      await packs().createPackOdds([
        {
          pack_id: CARD_PACK,
          card_id: 'card-a',
          weight: 100,
          locked: false,
          rarity: 'Rare' as const,
        },
      ]);
    };
    const openCardPack = (count: number) =>
      unwrapResponse(
        api.post(
          `/store/packs/${CARD_PACK}/open-batch`,
          { count },
          { headers: authed() },
        ),
      );
    const saveTask = (body: Record<string, unknown>) =>
      unwrapResponse(
        api.post(
          '/admin/tasks',
          { reason: 'ticket spin test', ...body },
          { headers: admin() },
        ),
      );
    const report = (path: string) =>
      unwrapResponse(
        api.get(`/reports/finance/${path}`, {
          headers: { 'x-report-key': FINANCE_KEY },
        }),
      );

    describe('what counts a spin', () => {
      it('unlocks a free pull on a cash spin, never on a bonus one, as a pull does', async () => {
        await livePack();
        await deposit(100);
        expect((await grantBonus(10)).status).toBe(200);
        const freePull = [{ id: 'pull_free', source: 'free' }];

        // Bonus goes first, so this spin is all bonus.
        expect((await openBatch(1)).status).toBe(200);
        expect((await spins()).map((s) => s.source)).toEqual(['bonus']);
        expect(await packs().hasPaidOpen(customerId)).toBe(false);
        expect(await packs().lockedPullIds(customerId, freePull)).toEqual(
          new Set(['pull_free']),
        );

        expect((await openBatch(1)).status).toBe(200);
        expect(await packs().hasPaidOpen(customerId)).toBe(true);
        expect(await packs().lockedPullIds(customerId, freePull)).toEqual(
          new Set(),
        );
      });

      it('moves rip tasks once per cash spin, day and week apart', async () => {
        await livePack();
        await seedCardPack();
        await deposit(100);
        expect((await grantBonus(10)).status).toBe(200);
        const task = async (kind: string, requirement: object) => {
          const res = await saveTask({
            kind,
            title: `Rip ${kind} ${JSON.stringify(requirement)}`,
            requirement,
            reward: { type: 'credit', amount_myr: 1 },
          });
          expect(res.status).toBe(200);
          return res.data.id as string;
        };
        const anyWeek = await task('weekly', { type: 'rip_count', count: 9 });
        const luckyWeek = await task('weekly', {
          type: 'rip_count',
          count: 9,
          pack_id: PACK,
        });
        const anyDay = await task('daily', { type: 'rip_count', count: 9 });
        const progress = async () => {
          const hub = await unwrapResponse(
            api.get('/store/tasks', { headers: authed() }),
          );
          const byId = new Map<string, number>(
            hub.data.tasks.map(
              (t: { id: string; progress: { current: number } }) => [
                t.id,
                t.progress.current,
              ],
            ),
          );
          return [anyWeek, luckyWeek, anyDay].map((id) => byId.get(id));
        };

        // A bonus spin moves nothing, as a bonus pull doesn't.
        expect((await openBatch(1)).status).toBe(200);
        expect(await progress()).toEqual([0, 0, 0]);

        expect((await openBatch(3)).status).toBe(200);
        expect(await progress()).toEqual([3, 3, 3]);

        // A card pull counts beside the spins, on its own pack.
        expect((await openCardPack(1)).status).toBe(200);
        expect(await progress()).toEqual([4, 3, 4]);

        // A spin from before today's MYT midnight leaves the day. It stays in
        // the week, unless today is the Monday the week began.
        const MYT = 8 * 3600 * 1000;
        const DAY = 24 * 3600 * 1000;
        const now = Date.now();
        const dayStart = Math.floor((now + MYT) / DAY) * DAY - MYT;
        const cash = (await spins()).find((s) => s.source === 'pack');
        const updated = await getContainer()
          .resolve(ContainerRegistrationKeys.PG_CONNECTION)
          .raw('UPDATE ticket_spin SET created_at = ? WHERE id = ?', [
            new Date(dayStart - 60_000).toISOString(),
            cash!.id,
          ]);
        expect(updated.rowCount).toBe(1);
        const isMonday = new Date(now + MYT).getUTCDay() === 1;
        expect(await progress()).toEqual(isMonday ? [3, 2, 3] : [4, 3, 3]);
      });

      it('attributes spins to their pack in pack-sales, adding up to economy revenue', async () => {
        await livePack();
        await seedCardPack();
        await deposit(100);
        expect((await grantBonus(15)).status).toBe(200);

        // RM 30 of spins, RM 15 of it bonus: 3 opened, RM 15 of revenue.
        expect((await openBatch(3)).status).toBe(200);
        expect((await openCardPack(1)).status).toBe(200);

        const res = await report('pack-sales');
        expect(res.status).toBe(200);
        expect(res.data.packs).toEqual([
          {
            pack: PACK,
            title: 'Lucky Test Pack',
            packs_opened: 3,
            revenue: 15,
          },
          {
            pack: CARD_PACK,
            title: 'Card Pack',
            packs_opened: 1,
            revenue: 10,
          },
        ]);
        expect(res.data.unattributed_revenue).toBe(0);
        expect(res.data.total_revenue).toBe(25);
        expect((await report('economy')).data.totals.revenue).toBe(25);

        // The window applies to the spin count too.
        const later = await report(
          `pack-sales?from=${new Date(Date.now() + 3600_000).toISOString()}`,
        );
        expect(later.status).toBe(200);
        expect(later.data.packs).toEqual([]);
      });
    });

    describe('kept out of the card surfaces', () => {
      it('automation neither lists nor accepts a ticket pack', async () => {
        await livePack();
        await seedCardPack();
        const headers = admin();
        await api.post(
          '/admin/automation/accounts',
          { emails: [CUSTOMER_EMAIL] },
          { headers },
        );
        const live = await api.get('/admin/automation/live', { headers });
        expect(live.data.packs.map((p: { slug: string }) => p.slug)).toEqual([
          CARD_PACK,
        ]);

        const change = (action: string, config: Record<string, unknown>) =>
          unwrapResponse(
            api.post(
              '/admin/automation/live',
              {
                action,
                config: {
                  customerIds: [customerId],
                  intervalSeconds: 2,
                  maxCyclesPerAccount: 3,
                  ...config,
                },
              },
              { headers },
            ),
          );
        for (const action of ['save', 'run']) {
          const refused = await change(action, { packSlug: PACK });
          expect(refused.status).toBe(400);
          expect(refused.data.message).toMatch(/ticket pack/i);
        }
        const mix = await change('save', {
          packSlug: '',
          packMix: [
            { packSlug: CARD_PACK, weightBp: 5000 },
            { packSlug: PACK, weightBp: 5000 },
          ],
        });
        expect(mix.status).toBe(400);
        expect(mix.data.message).toMatch(/ticket pack/i);

        expect((await change('save', { packSlug: CARD_PACK })).status).toBe(
          200,
        );
      });

      it('a gift refuses a ticket pack by name and writes nothing', async () => {
        await livePack();
        await seedCardPack();
        const gift = (packId: string, key: string) =>
          unwrapResponse(
            api.post(
              `/admin/customers/${customerId}/pack-gifts`,
              {
                pack_id: packId,
                quantity: 1,
                note: 'test gift',
                idempotency_key: key,
              },
              { headers: admin() },
            ),
          );

        const refused = await gift(PACK, 'gift-ticket');
        expect(refused.status).toBe(400);
        expect(refused.data.message).toMatch(/ticket pack/i);
        expect(
          await packs().listPackGifts({ customer_id: customerId }, { take: 5 }),
        ).toHaveLength(0);

        expect((await gift(CARD_PACK, 'gift-card')).status).toBe(201);
      });

      it('a task reward refuses a ticket pack, while a rip goal may name one', async () => {
        await livePack();
        await seedCardPack();
        const free = (packId: string) =>
          saveTask({
            kind: 'weekly',
            title: `Free rip of ${packId}`,
            requirement: { type: 'checkin_days', days: 1 },
            reward: { type: 'pack', pack_id: packId },
          });

        const refused = await free(PACK);
        expect(refused.status).toBe(400);
        expect(refused.data.message).toMatch(/ticket pack/i);
        expect(await packs().listTaskDefinitions({}, { take: 5 })).toHaveLength(
          0,
        );

        expect((await free(CARD_PACK)).status).toBe(200);
        expect(
          (
            await saveTask({
              kind: 'weekly',
              title: 'Spin the Lucky Pack',
              requirement: { type: 'rip_count', count: 3, pack_id: PACK },
              reward: { type: 'credit', amount_myr: 1 },
            })
          ).status,
        ).toBe(200);
      });

      it('Lossless refuses a named ticket pack, and an all-packs window leaves it alone', async () => {
        await livePack();
        await seedCardPack();
        const schedule = (slugs: string[] | null) =>
          unwrapResponse(
            api.post(
              '/admin/lossless-schedules',
              {
                starts_at: new Date(Date.now() - 60_000).toISOString(),
                ends_at: new Date(Date.now() + 3600_000).toISOString(),
                pack_slugs: slugs,
                reason: 'ticket spin test',
              },
              { headers: admin() },
            ),
          );

        const refused = await schedule([CARD_PACK, PACK]);
        expect(refused.status).toBe(400);
        expect(refused.data.message).toMatch(/ticket pack/i);
        expect(
          await packs().listLosslessSchedules({}, { take: 5 }),
        ).toHaveLength(0);

        expect((await schedule(null)).status).toBe(200);
        clearLosslessDisplayMemo();
        const percent = async (slug: string) => {
          const list = await unwrapResponse(
            api.get('/store/packs', { headers: storeHeaders }),
          );
          const detail = await unwrapResponse(
            api.get(`/store/packs/${slug}`, { headers: storeHeaders }),
          );
          return [
            Number(
              list.data.packs.find((p: { slug: string }) => p.slug === slug)
                .buyback_percent,
            ),
            Number(detail.data.pack.buyback_percent),
          ];
        };
        expect(await percent(PACK)).toEqual([90, 90]);
        expect(await percent(CARD_PACK)).toEqual([100, 100]);
      });

      it('shows no RTP or EV for a ticket pack, and does not throw', async () => {
        expect(
          (
            await createPack({
              published_odds: {
                overall: 100,
                tiers: { Common: 90, Rare: 10 },
                decimals: 2,
              },
            })
          ).status,
        ).toBe(201);
        expect((await saveRows(only(100))).status).toBe(200);
        expect((await updatePack({ status: 'active' })).status).toBe(200);
        await seedCardPack();

        const slugs = (rows: { slug: string }[]) => rows.map((p) => p.slug);
        const economy = await unwrapResponse(
          api.get('/admin/economy', { headers: admin() }),
        );
        expect(economy.status).toBe(200);
        expect(slugs(economy.data.packs)).toEqual([CARD_PACK]);
        expect(economy.data.packs[0].rtp_pct).toEqual(expect.any(Number));
        const profit = await unwrapResponse(
          api.get('/admin/profit-report', { headers: admin() }),
        );
        expect(profit.status).toBe(200);
        expect(slugs(profit.data.packs)).toEqual([CARD_PACK]);

        // The admin Packs list keeps the row: the editor picks itself from it.
        const list = await unwrapResponse(
          api.get('/admin/packs', { headers: admin() }),
        );
        expect(list.status).toBe(200);
        expect(
          list.data.packs.find((p: { slug: string }) => p.slug === PACK),
        ).toMatchObject({
          prize_type: 'tickets',
          group: null,
          ev: { s1: null, s2: null, s3: null },
          rtp: { s1: null, s2: null, s3: null },
          pub_ev: null,
          pub_rtp: null,
        });
      });
    });
  },
});
