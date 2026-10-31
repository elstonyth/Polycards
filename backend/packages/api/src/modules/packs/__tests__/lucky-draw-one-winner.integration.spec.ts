/**
 * Lucky Draw, one winner per event (spec 2026-10-30) — integration:modules
 *
 * Tickets go on the event; at its end one customer, weighted by tickets, takes
 * every prize in one transaction. Events are built through the real admin
 * writes, so these also pin the publish rules. Old per_prize rows are seeded
 * directly: nothing can create them any more.
 *
 * The CHECKs and partial indexes do not exist in this tier (the schema comes
 * from the models). ticket-spin-one-winner-schema.spec.ts proves those.
 */
process.env.LUCKY_DRAW_SEED_SECRET ??= 'test-lucky-draw-seed-secret';

import path from 'path';
import { moduleIntegrationTestRunner } from '@medusajs/test-utils';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../index';
import PacksModuleService from '../service';
import {
  LUCKY_DRAW_PULL_PACK_ID,
  commitDrawSeed,
  deriveDrawSeed,
  drawSeedHash,
  drawWinner,
  type DrawEntrant,
} from '../lucky-draw';
import { BONUS_BP_FULL } from '../bonus-credit';
import { clearFxDisplayCache } from '../pricing';
import LuckyDrawEvent from '../models/lucky-draw-event';
import LuckyDrawPrize from '../models/lucky-draw-prize';
import LuckyDrawEntry from '../models/lucky-draw-entry';
import LuckyDrawTicket from '../models/lucky-draw-ticket';
import LuckyDrawResult from '../models/lucky-draw-result';
import LuckyDrawEventResult from '../models/lucky-draw-event-result';
import CreditTransaction from '../models/credit-transaction';
import CustomerAccountState from '../models/customer-account-state';
import AdminActionAudit from '../models/admin-action-audit';
import Card from '../models/card';
import FxRate from '../models/fx-rate';
import Pull from '../models/pull';
import LedgerEntry from '../models/ledger-entry';
import LedgerSequence from '../models/ledger-sequence';

jest.setTimeout(300 * 1000);

const HOUR = 60 * 60 * 1000;
const ADMIN = 'user_admin_ow';
const REASON = 'testing';

moduleIntegrationTestRunner<PacksModuleService>({
  moduleName: PACKS_MODULE,
  resolve: path.resolve(__dirname, '../../..', 'modules/packs'),
  moduleModels: [
    LuckyDrawEvent,
    LuckyDrawPrize,
    LuckyDrawEntry,
    LuckyDrawTicket,
    LuckyDrawResult,
    LuckyDrawEventResult,
    CreditTransaction,
    CustomerAccountState,
    AdminActionAudit,
    Card,
    FxRate,
    Pull,
    LedgerEntry,
    LedgerSequence,
  ],
  testSuite: ({ service, MikroOrmWrapper }) => {
    const fund = async (customerId: string, tickets: number, topUp = true) => {
      if (topUp) {
        await service.createCreditTransactions([
          { customer_id: customerId, amount: 50, reason: 'topup' },
        ]);
      }
      if (tickets > 0) {
        await service.createLuckyDrawTickets([
          {
            customer_id: customerId,
            delta: tickets,
            reason: 'task_claim',
            ref: `c-${customerId}`,
          },
        ]);
      }
    };

    const makeCard = (handle: string) =>
      service.createCards([
        {
          handle,
          name: `Card ${handle}`,
          set: 'Test Set',
          grader: 'PSA',
          grade: '10',
          market_value: 50,
          market_multiplier: 1.2,
          image: `/cdn/${handle}.webp`,
        },
      ]);

    const saveEvent = (over: Record<string, unknown> = {}) =>
      service.saveLuckyDrawEvent({
        name: 'November Draw',
        startsAt: new Date(Date.now() - HOUR),
        endsAt: new Date(Date.now() + 48 * HOUR),
        adminId: ADMIN,
        reason: REASON,
        ...over,
      });

    const saveCredit = (
      eventId: string,
      creditMyr = 25,
      over: Record<string, unknown> = {},
    ) =>
      service.saveLuckyDrawPrize({
        eventId,
        kind: 'credit',
        creditMyr,
        title: `RM ${creditMyr} credit`,
        sort: 0,
        adminId: ADMIN,
        reason: REASON,
        ...over,
      });

    const saveCard = (
      eventId: string,
      cardHandle: string,
      over: Record<string, unknown> = {},
    ) =>
      service.saveLuckyDrawPrize({
        eventId,
        kind: 'card',
        cardHandle,
        title: `Card ${cardHandle}`,
        sort: 1,
        adminId: ADMIN,
        reason: REASON,
        ...over,
      });

    const publish = (id: string, now?: Date) =>
      service.publishLuckyDrawEvent({
        id,
        adminId: ADMIN,
        reason: REASON,
        now,
      });

    const withdraw = (id: string) =>
      service.withdrawLuckyDrawEvent({ id, adminId: ADMIN, reason: REASON });

    // A published event that started an hour ago and ends in 48 hours, with one
    // RM 25 credit prize unless the caller adds its own pool.
    const liveEvent = async (
      over: Record<string, unknown> = {},
      pool?: (eventId: string) => Promise<unknown>,
    ) => {
      const { id } = await saveEvent(over);
      await (pool ? pool(id) : saveCredit(id));
      await publish(id);
      return (await service.listLuckyDrawEvents({ id }))[0];
    };

    const enter = (customerId: string, eventId: string, tickets: unknown) =>
      service.enterLuckyDrawEvent({ customerId, eventId, tickets });

    const enterOk = async (
      customerId: string,
      eventId: string,
      tickets: number,
    ) => {
      expect(await enter(customerId, eventId, tickets)).toMatchObject({
        entered: true,
      });
    };

    const afterEnd = (event: { ends_at: Date | string }) =>
      new Date(new Date(event.ends_at).getTime() + 1000);

    const eventResultOf = async (eventId: string) => {
      const rows = await service.listLuckyDrawEventResults({
        event_id: eventId,
      });
      expect(rows.length).toBeLessThanOrEqual(1);
      return rows[0];
    };

    const prizesOf = (eventId: string) =>
      service.listLuckyDrawPrizes({ event_id: eventId });

    const rewardCredits = (customerId: string) =>
      service.listCreditTransactions({
        customer_id: customerId,
        reason: 'reward_credit',
      });

    // Everything a draw can have paid, across the whole test database.
    const nothingPaid = async () => {
      expect(
        await service.listCreditTransactions({ reason: 'reward_credit' }),
      ).toHaveLength(0);
      expect(
        await service.listPulls({ pack_id: LUCKY_DRAW_PULL_PACK_ID }),
      ).toHaveLength(0);
      expect(await service.listLedgerEntries({ type: 'WP' })).toHaveLength(0);
      expect(await service.listLuckyDrawResults({})).toHaveLength(0);
      expect(await service.listLuckyDrawEventResults({})).toHaveLength(0);
    };

    const settledWithin = async (p: Promise<unknown>, ms: number) => {
      let timer: NodeJS.Timeout | undefined;
      const pending = Symbol('pending');
      const result = await Promise.race([
        p.then(() => 'settled' as const).catch(() => 'settled' as const),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(pending), ms);
        }),
      ]);
      clearTimeout(timer);
      return result !== pending;
    };

    const holdLock = async (
      fn: 'pg_advisory_xact_lock' | 'pg_advisory_xact_lock_shared',
      key: string,
    ) => {
      const tx = MikroOrmWrapper.forkManager();
      await tx.begin();
      await tx.execute(`SELECT ${fn}(hashtextextended(?, 0))`, [key]);
      return { tx, release: () => tx.commit() };
    };

    // An old-rule event: published before this change, so seeded directly.
    const oldEvent = async (over: Record<string, unknown> = {}) => {
      const [event] = await service.createLuckyDrawEvents([
        {
          name: 'Old Draw',
          starts_at: new Date(Date.now() - HOUR),
          ends_at: new Date(Date.now() + 24 * HOUR),
          status: 'published' as const,
          created_by: ADMIN,
          ...over,
        },
      ]);
      expect(event.draw_mode).toBe('per_prize');
      return event;
    };

    const oldPrize = async (
      eventId: string,
      over: Record<string, unknown> = {},
    ) => {
      const [prize] = await service.createLuckyDrawPrizes([
        {
          event_id: eventId,
          kind: 'credit' as const,
          card_handle: null,
          credit_myr: 25,
          title: 'Old prize',
          draw_at: new Date(Date.now() + HOUR),
          ...commitDrawSeed(process.env.LUCKY_DRAW_SEED_SECRET!),
          ...over,
        },
      ]);
      return prize;
    };

    describe('entering', () => {
      it('spends tickets on the event, not a prize', async () => {
        const event = await liveEvent();
        await fund('cus_e', 100);

        const first = await enter('cus_e', event.id, 30);
        expect(first).toMatchObject({
          entered: true,
          balance: 70,
          myTickets: 30,
        });
        // myTickets is the viewer's total in the event.
        expect(await enter('cus_e', event.id, 15)).toMatchObject({
          entered: true,
          balance: 55,
          myTickets: 45,
        });

        const entries = await service.listLuckyDrawEntries({
          event_id: event.id,
        });
        expect(entries).toHaveLength(2);
        expect(entries.every((e) => e.prize_id === null)).toBe(true);
        const spends = await service.listLuckyDrawTickets({ reason: 'entry' });
        expect(spends.map((s) => s.ref).sort()).toEqual(
          entries.map((e) => e.id).sort(),
        );
      });

      it('refuses before the start and at or after the end', async () => {
        const startsAt = new Date(Date.now() + HOUR);
        const endsAt = new Date(Date.now() + 5 * HOUR);
        const event = await liveEvent({ startsAt, endsAt });
        await fund('cus_w', 100);
        const at = (now: Date) =>
          service.enterLuckyDrawEvent({
            customerId: 'cus_w',
            eventId: event.id,
            tickets: 10,
            now,
          });

        expect(await at(new Date(startsAt.getTime() - 1))).toEqual({
          entered: false,
          reason: 'not_open',
        });
        expect(await at(endsAt)).toEqual({ entered: false, reason: 'closed' });
        expect(await at(new Date(endsAt.getTime() + 1))).toEqual({
          entered: false,
          reason: 'closed',
        });
        expect(await service.luckyDrawBalance('cus_w')).toBe(100);

        expect(await at(startsAt)).toMatchObject({ entered: true });
        expect(await at(new Date(endsAt.getTime() - 1))).toMatchObject({
          entered: true,
        });
      });

      it('refuses no top-up, too few tickets, a draft, a missing event and an old-rule event', async () => {
        const event = await liveEvent();
        await fund('cus_nt', 100, false);
        expect(await enter('cus_nt', event.id, 1)).toEqual({
          entered: false,
          reason: 'no_topup',
        });
        await fund('cus_few', 5);
        expect(await enter('cus_few', event.id, 6)).toEqual({
          entered: false,
          reason: 'not_enough_tickets',
        });

        const { id: draft } = await saveEvent();
        expect(await enter('cus_few', draft, 1)).toEqual({
          entered: false,
          reason: 'not_found',
        });
        expect(await enter('cus_few', 'ldev_missing', 1)).toEqual({
          entered: false,
          reason: 'not_found',
        });
        const old = await oldEvent();
        expect(await enter('cus_few', old.id, 1)).toEqual({
          entered: false,
          reason: 'not_found',
        });
        expect(await service.luckyDrawBalance('cus_few')).toBe(5);
      });

      it('throws for a bad amount and a frozen account', async () => {
        const event = await liveEvent();
        await fund('cus_bad', 10);
        for (const tickets of [0, -1, 1.5, '3']) {
          await expect(
            enter('cus_bad', event.id, tickets),
          ).rejects.toMatchObject({ type: MedusaError.Types.INVALID_DATA });
        }
        await service.createCustomerAccountStates([
          { customer_id: 'cus_bad', frozen: true, cause: 'manual' },
        ]);
        await expect(enter('cus_bad', event.id, 1)).rejects.toMatchObject({
          type: MedusaError.Types.NOT_ALLOWED,
        });
        expect(await service.luckyDrawBalance('cus_bad')).toBe(10);
      });

      it('concurrent enters never take the balance below zero', async () => {
        const event = await liveEvent();
        await fund('cus_race', 100);

        const results = await Promise.all(
          Array.from({ length: 6 }, () => enter('cus_race', event.id, 40)),
        );

        expect(results.filter((r) => r.entered)).toHaveLength(2);
        expect(results.filter((r) => !r.entered)).toEqual(
          Array.from({ length: 4 }, () => ({
            entered: false,
            reason: 'not_enough_tickets',
          })),
        );
        expect(await service.luckyDrawBalance('cus_race')).toBe(20);
      });

      it('takes the shared event lock, then the ticket lock', async () => {
        const event = await liveEvent();
        await fund('cus_lk', 100);
        // A draw in flight holds the event lock exclusive: the entry waits.
        const draw = await holdLock(
          'pg_advisory_xact_lock',
          `luckydraw:${event.id}`,
        );
        const blocked = enter('cus_lk', event.id, 10);
        expect(await settledWithin(blocked, 500)).toBe(false);
        await draw.release();
        expect(await blocked).toMatchObject({ entered: true });

        // Another entry only holds it shared: no wait on the event lock.
        const other = await holdLock(
          'pg_advisory_xact_lock_shared',
          `luckydraw:${event.id}`,
        );
        try {
          expect(await enter('cus_lk', event.id, 10)).toMatchObject({
            entered: true,
          });
        } finally {
          await other.release();
        }

        // The same customer's other spend holds the ticket lock: the entry waits.
        const spend = await holdLock('pg_advisory_xact_lock', 'tickets:cus_lk');
        const queued = enter('cus_lk', event.id, 10);
        expect(await settledWithin(queued, 500)).toBe(false);
        await spend.release();
        expect(await queued).toMatchObject({ entered: true });
      });
    });

    describe('the draw', () => {
      it('commits to a seed at publish and draws a checkable weighted winner', async () => {
        const event = await liveEvent();
        const secret = process.env.LUCKY_DRAW_SEED_SECRET!;
        expect(event.draw_mode).toBe('one_winner');
        expect(event.seed_nonce).toMatch(/^[0-9a-f]{64}$/);
        expect(event.seed_hash).toBe(
          drawSeedHash(deriveDrawSeed(secret, event.seed_nonce!)),
        );
        expect(event).not.toHaveProperty('seed');
        const [prize] = await prizesOf(event.id);
        expect(prize.seed_nonce).toBeNull();
        expect(prize.seed_hash).toBeNull();

        for (const [customerId, tickets] of [
          ['cus_c', 20],
          ['cus_a', 30],
          ['cus_b', 50],
        ] as const) {
          await fund(customerId, 100);
          await enterOk(customerId, event.id, tickets);
        }
        // Tickets add up per customer.
        await enterOk('cus_a', event.id, 5);

        await service.drawLuckyDrawEvent({
          eventId: event.id,
          now: afterEnd(event),
        });

        const result = await eventResultOf(event.id);
        const seed = deriveDrawSeed(secret, event.seed_nonce!);
        expect(result.seed).toBe(seed);
        expect(drawSeedHash(result.seed)).toBe(event.seed_hash);
        // Frozen in a fixed order: by customer id.
        const frozen: DrawEntrant[] = [
          { customer_id: 'cus_a', tickets: 35 },
          { customer_id: 'cus_b', tickets: 50 },
          { customer_id: 'cus_c', tickets: 20 },
        ];
        expect(result.entries).toEqual(frozen);
        const recomputed = drawWinner(frozen, seed, event.id)!;
        expect(result).toMatchObject({
          winner_customer_id: recomputed.winner.customer_id,
          winner_tickets: recomputed.winner.tickets,
          total_tickets: 105,
          entrant_count: 3,
          ticket_index: recomputed.ticketIndex,
          excluded: [],
        });
      });

      it('the winner takes every prize: two credits and a card, in one draw', async () => {
        clearFxDisplayCache();
        await makeCard('pot-card');
        const event = await liveEvent({}, async (id) => {
          await saveCredit(id, 25);
          await saveCredit(id, 10.5, { sort: 2 });
          await saveCard(id, 'pot-card');
        });
        await fund('cus_pot', 100);
        await enterOk('cus_pot', event.id, 10);

        const stock = jest.fn().mockResolvedValue(true);
        expect(
          await service.drawDueLuckyDrawEvents({
            now: afterEnd(event),
            decrementStock: stock,
          }),
        ).toEqual({ drawn: 1, failed: 0 });

        // Both credit prizes, each its own row, both bonus.
        const credits = await rewardCredits('cus_pot');
        expect(credits.map((c) => Number(c.amount)).sort()).toEqual([10.5, 25]);
        expect(credits.map((c) => c.bonus_cents).sort()).toEqual([1050, 2500]);
        expect(credits.map((c) => c.source_transaction_id).sort()).toEqual(
          (await prizesOf(event.id))
            .filter((p) => p.kind === 'credit')
            .map((p) => `luckydraw:${p.id}`)
            .sort(),
        );

        // The card as a reward pull, its stock taken after the commit.
        const pulls = await service.listPulls({
          pack_id: LUCKY_DRAW_PULL_PACK_ID,
        });
        expect(pulls).toHaveLength(1);
        expect(pulls[0]).toMatchObject({
          customer_id: 'cus_pot',
          card_id: 'pot-card',
          source: 'reward',
          bonus_bp: BONUS_BP_FULL,
          stock_earmarked: true,
        });
        expect(stock).toHaveBeenCalledTimes(1);
        expect(stock).toHaveBeenCalledWith('pot-card', 1);

        // A WP ledger row per prize.
        const ledger = await service.listLedgerEntries({ type: 'WP' });
        expect(ledger).toHaveLength(3);
        expect(new Set(ledger.map((l) => l.customer_id))).toEqual(
          new Set(['cus_pot']),
        );
        expect(new Set(ledger.map((l) => l.display_id)).size).toBe(3);

        // A mirror row per prize: the winner, the seed, no entries of its own.
        const prizes = await prizesOf(event.id);
        const mirrors = await service.listLuckyDrawResults({
          prize_id: prizes.map((p) => p.id),
        });
        const result = await eventResultOf(event.id);
        expect(mirrors).toHaveLength(3);
        for (const m of mirrors) {
          const prize = prizes.find((p) => p.id === m.prize_id)!;
          expect(m).toMatchObject({
            winner_customer_id: 'cus_pot',
            winner_tickets: 10,
            total_tickets: 10,
            entrant_count: 1,
            ticket_index: null,
            seed: result.seed,
            entries: [],
            excluded: [],
          });
          expect(Boolean(m.pull_id)).toBe(prize.kind === 'card');
          expect(Boolean(m.credit_transaction_id)).toBe(
            prize.kind === 'credit',
          );
        }
      });

      it('leaves a cancelled prize out of the pot', async () => {
        const startsAt = new Date(Date.now() + HOUR);
        const event = await liveEvent({ startsAt }, async (id) => {
          await saveCredit(id, 25);
          await saveCredit(id, 7, { sort: 2 });
        });
        const prizes = await prizesOf(event.id);
        const gone = prizes.find((p) => Number(p.credit_myr) === 7)!;
        await service.cancelLuckyDrawPrize({
          id: gone.id,
          adminId: ADMIN,
          reason: REASON,
        });
        await fund('cus_cp', 10);
        await service.createLuckyDrawEntries([
          { event_id: event.id, customer_id: 'cus_cp', tickets: 1 },
        ]);

        await service.drawLuckyDrawEvent({
          eventId: event.id,
          now: afterEnd(event),
        });

        const credits = await rewardCredits('cus_cp');
        expect(credits.map((c) => Number(c.amount))).toEqual([25]);
        expect(
          await service.listLuckyDrawResults({ prize_id: gone.id }),
        ).toHaveLength(0);
      });

      it('running the job twice draws and pays once', async () => {
        await makeCard('twice-card');
        const event = await liveEvent({}, async (id) => {
          await saveCredit(id, 25);
          await saveCard(id, 'twice-card');
        });
        await fund('cus_tw', 10);
        await enterOk('cus_tw', event.id, 10);
        const stock = jest.fn().mockResolvedValue(true);
        const job = () =>
          service.drawDueLuckyDrawEvents({
            now: afterEnd(event),
            decrementStock: stock,
          });

        expect(await job()).toEqual({ drawn: 1, failed: 0 });
        expect(await job()).toEqual({ drawn: 0, failed: 0 });
        // Even when a stale due list asks for it again.
        expect(
          await service.drawLuckyDrawEvent({
            eventId: event.id,
            now: afterEnd(event),
          }),
        ).toBeNull();

        expect(await rewardCredits('cus_tw')).toHaveLength(1);
        expect(
          await service.listPulls({ pack_id: LUCKY_DRAW_PULL_PACK_ID }),
        ).toHaveLength(1);
        expect(await service.listLuckyDrawEventResults({})).toHaveLength(1);
        expect(await service.listLuckyDrawResults({})).toHaveLength(2);
        expect(stock).toHaveBeenCalledTimes(1);
      });

      it('two jobs at once still draw and pay once', async () => {
        const event = await liveEvent();
        await fund('cus_two', 10);
        await enterOk('cus_two', event.id, 10);
        const job = () =>
          service.drawDueLuckyDrawEvents({ now: afterEnd(event) });

        const runs = await Promise.all([job(), job()]);

        expect(runs.reduce((n, r) => n + r.drawn, 0)).toBe(1);
        expect(runs.reduce((n, r) => n + r.failed, 0)).toBe(0);
        expect(await rewardCredits('cus_two')).toHaveLength(1);
      });

      it('a failure mid-payout leaves nothing paid, and the retry completes', async () => {
        await makeCard('fail-card');
        const event = await liveEvent({}, async (id) => {
          await saveCredit(id, 25);
          await saveCredit(id, 10, { sort: 2 });
          await saveCard(id, 'fail-card');
        });
        await fund('cus_ko', 10);
        await enterOk('cus_ko', event.id, 10);
        const real = PacksModuleService.prototype.recordLedgerEntry;
        let calls = 0;
        const spy = jest
          .spyOn(PacksModuleService.prototype, 'recordLedgerEntry')
          .mockImplementation(function (
            this: PacksModuleService,
            ...args: Parameters<typeof real>
          ) {
            calls += 1;
            if (calls === 2) throw new Error('boom on the second payout');
            return real.apply(this, args);
          });
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const job = () =>
          service.drawDueLuckyDrawEvents({ now: afterEnd(event) });

        try {
          expect(await job()).toEqual({ drawn: 0, failed: 1 });
          expect(calls).toBe(2);
          expect(JSON.stringify(warn.mock.calls)).toContain('not drawn');
        } finally {
          spy.mockRestore();
          warn.mockRestore();
        }

        // Not one payout survived, nor a result: the event is still due.
        await nothingPaid();
        expect(
          await service.listLuckyDrawEntries({ event_id: event.id }),
        ).toHaveLength(1);

        expect(await job()).toEqual({ drawn: 1, failed: 0 });
        expect(await rewardCredits('cus_ko')).toHaveLength(2);
        expect(
          await service.listPulls({ pack_id: LUCKY_DRAW_PULL_PACK_ID }),
        ).toHaveLength(1);
        expect(await service.listLedgerEntries({ type: 'WP' })).toHaveLength(3);
        expect(await service.listLuckyDrawResults({})).toHaveLength(3);
      });

      it('a commit-time failure rolls the whole payout back too', async () => {
        const event = await liveEvent({}, async (id) => {
          await saveCredit(id, 25);
          await saveCredit(id, 10, { sort: 2 });
        });
        await fund('cus_cm', 10);
        await enterOk('cus_cm', event.id, 10);
        // A result row already on one prize: its mirror row violates the unique
        // index at flush, after every payout is already in the transaction.
        const [prize] = await prizesOf(event.id);
        const [blocker] = await service.createLuckyDrawResults([
          {
            prize_id: prize.id,
            seed: 's',
            entries: {},
            excluded: {},
            drawn_at: new Date(),
          },
        ]);
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const job = () =>
          service.drawDueLuckyDrawEvents({ now: afterEnd(event) });

        expect(await job()).toEqual({ drawn: 0, failed: 1 });
        warn.mockRestore();
        expect(await rewardCredits('cus_cm')).toHaveLength(0);
        expect(await service.listLedgerEntries({ type: 'WP' })).toHaveLength(0);
        expect(await eventResultOf(event.id)).toBeUndefined();

        await service.deleteLuckyDrawResults(blocker.id);
        expect(await job()).toEqual({ drawn: 1, failed: 0 });
        expect(await rewardCredits('cus_cm')).toHaveLength(2);
      });

      it('no entries: a result with no winner, the seed revealed, nothing paid, not drawn again', async () => {
        await makeCard('none-card');
        const event = await liveEvent({}, async (id) => {
          await saveCredit(id, 25);
          await saveCard(id, 'none-card');
        });
        const job = () =>
          service.drawDueLuckyDrawEvents({ now: afterEnd(event) });

        expect(await job()).toEqual({ drawn: 1, failed: 0 });
        expect(await job()).toEqual({ drawn: 0, failed: 0 });

        const result = await eventResultOf(event.id);
        expect(result).toMatchObject({
          winner_customer_id: null,
          winner_tickets: 0,
          total_tickets: 0,
          entrant_count: 0,
          ticket_index: null,
          entries: [],
        });
        expect(result.seed).toMatch(/^[0-9a-f]{64}$/);
        expect(
          await service.listCreditTransactions({ reason: 'reward_credit' }),
        ).toHaveLength(0);
        expect(
          await service.listPulls({ pack_id: LUCKY_DRAW_PULL_PACK_ID }),
        ).toHaveLength(0);
        // The admin screen reads the outcome from the mirror rows, granted.
        const [row] = (await service.adminLuckyDrawOverview()).filter(
          (e) => e.id === event.id,
        );
        expect(row.prizes).toHaveLength(2);
        for (const p of row.prizes) {
          expect(p.result).toMatchObject({
            winner_customer_id: null,
            granted: true,
          });
        }
      });

      it('a disabled entrant is refunded and excluded; all disabled means no winner', async () => {
        const event = await liveEvent();
        await fund('cus_off', 100);
        await fund('cus_on', 100);
        await enterOk('cus_off', event.id, 90);
        await enterOk('cus_off', event.id, 5);
        await enterOk('cus_on', event.id, 1);
        await service.createCustomerAccountStates([
          { customer_id: 'cus_off', disabled: true },
        ]);

        await service.drawLuckyDrawEvent({
          eventId: event.id,
          now: afterEnd(event),
        });

        const result = await eventResultOf(event.id);
        expect(result).toMatchObject({
          winner_customer_id: 'cus_on',
          total_tickets: 1,
          entrant_count: 1,
          entries: [{ customer_id: 'cus_on', tickets: 1 }],
          excluded: ['cus_off'],
        });
        expect(await service.luckyDrawBalance('cus_off')).toBe(100);
        expect(await service.luckyDrawBalance('cus_on')).toBe(99);
        const refunds = await service.listLuckyDrawTickets({
          reason: 'refund',
        });
        expect(refunds).toHaveLength(1);
        expect(refunds[0]).toMatchObject({
          customer_id: 'cus_off',
          delta: 95,
          ref: `${event.id}:cus_off`,
        });

        const lone = await liveEvent({
          startsAt: afterEnd(event),
          endsAt: new Date(afterEnd(event).getTime() + HOUR),
        });
        await service.createLuckyDrawEntries([
          { event_id: lone.id, customer_id: 'cus_off', tickets: 3 },
        ]);
        await service.drawLuckyDrawEvent({
          eventId: lone.id,
          now: afterEnd(lone),
        });
        expect(await eventResultOf(lone.id)).toMatchObject({
          winner_customer_id: null,
          total_tickets: 0,
          excluded: ['cus_off'],
        });
        expect(await rewardCredits('cus_off')).toHaveLength(0);
      });

      it('a missing card stops the whole draw and warns; restoring it lets the retry pay everything', async () => {
        const [card] = await makeCard('gone-card');
        const event = await liveEvent({}, async (id) => {
          await saveCredit(id, 25);
          await saveCard(id, 'gone-card');
        });
        await fund('cus_gc', 10);
        await enterOk('cus_gc', event.id, 10);
        await service.deleteCards([card.id]);
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const job = () =>
          service.drawDueLuckyDrawEvents({ now: afterEnd(event) });

        expect(await job()).toEqual({ drawn: 0, failed: 1 });
        expect(JSON.stringify(warn.mock.calls)).toContain('gone-card');
        warn.mockRestore();
        await nothingPaid();

        await makeCard('gone-card');
        expect(await job()).toEqual({ drawn: 1, failed: 0 });
        expect(await rewardCredits('cus_gc')).toHaveLength(1);
        expect(
          await service.listPulls({ pack_id: LUCKY_DRAW_PULL_PACK_ID }),
        ).toHaveLength(1);
      });

      it('a missing card does not hold up a draw with nobody to pay', async () => {
        const [card] = await makeCard('idle-card');
        const event = await liveEvent({}, (id) => saveCard(id, 'idle-card'));
        await service.deleteCards([card.id]);
        expect(
          await service.drawDueLuckyDrawEvents({ now: afterEnd(event) }),
        ).toEqual({ drawn: 1, failed: 0 });
        expect(await eventResultOf(event.id)).toMatchObject({
          winner_customer_id: null,
        });
      });

      it('refuses to draw when the secret no longer matches the published hash', async () => {
        const event = await liveEvent();
        await fund('cus_sec', 10);
        await enterOk('cus_sec', event.id, 1);
        const saved = process.env.LUCKY_DRAW_SEED_SECRET;
        process.env.LUCKY_DRAW_SEED_SECRET = 'rotated';
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
          expect(
            await service.drawDueLuckyDrawEvents({ now: afterEnd(event) }),
          ).toEqual({ drawn: 0, failed: 1 });
        } finally {
          process.env.LUCKY_DRAW_SEED_SECRET = saved;
          warn.mockRestore();
        }
        await nothingPaid();
      });

      it('does not draw before the end, a draft or a withdrawn event', async () => {
        const event = await liveEvent();
        // A draft whose end has passed.
        const { id: draft } = await saveEvent({
          startsAt: new Date(Date.now() - 2 * HOUR),
          endsAt: new Date(Date.now() - HOUR),
        });
        await saveCredit(draft);

        expect(
          await service.drawLuckyDrawEvent({
            eventId: event.id,
            now: new Date(new Date(event.ends_at).getTime() - 1),
          }),
        ).toBeNull();
        expect(
          await service.drawDueLuckyDrawEvents({ now: new Date() }),
        ).toEqual({ drawn: 0, failed: 0 });
        await nothingPaid();
      });

      it('the draw waits for an in-flight entry and includes it', async () => {
        const event = await liveEvent();
        await fund('cus_fl', 100);
        const entering = await holdLock(
          'pg_advisory_xact_lock_shared',
          `luckydraw:${event.id}`,
        );
        let released = false;
        try {
          await entering.tx.execute(
            'INSERT INTO lucky_draw_entry (id, event_id, customer_id, tickets, created_at, updated_at) ' +
              "VALUES ('lden_fl', ?, 'cus_fl', 25, now(), now())",
            [event.id],
          );
          const drawing = service.drawDueLuckyDrawEvents({
            now: afterEnd(event),
          });
          expect(await settledWithin(drawing, 750)).toBe(false);
          await entering.release();
          released = true;
          expect(await drawing).toEqual({ drawn: 1, failed: 0 });
          expect(await eventResultOf(event.id)).toMatchObject({
            winner_customer_id: 'cus_fl',
            total_tickets: 25,
          });
        } finally {
          if (!released) await entering.tx.rollback();
        }
      });
    });

    describe('withdrawing', () => {
      it('refunds everyone exactly once, stamps the prizes and blocks a later draw', async () => {
        const event = await liveEvent({}, async (id) => {
          await saveCredit(id, 25);
          await saveCredit(id, 10, { sort: 2 });
        });
        await fund('cus_wa', 100);
        await fund('cus_wb', 40);
        await enterOk('cus_wa', event.id, 30);
        await enterOk('cus_wa', event.id, 20);
        await enterOk('cus_wb', event.id, 10);

        expect(await withdraw(event.id)).toEqual({ refunded: 2 });

        expect(await service.luckyDrawBalance('cus_wa')).toBe(100);
        expect(await service.luckyDrawBalance('cus_wb')).toBe(40);
        const refunds = await service.listLuckyDrawTickets({
          reason: 'refund',
        });
        expect(refunds.map((r) => r.ref).sort()).toEqual([
          `${event.id}:cus_wa`,
          `${event.id}:cus_wb`,
        ]);
        const [row] = await service.listLuckyDrawEvents({ id: event.id });
        expect(row.status).toBe('cancelled');
        expect((await prizesOf(event.id)).every((p) => p.cancelled_at)).toBe(
          true,
        );

        // Again: refused, nothing refunded twice.
        await expect(withdraw(event.id)).rejects.toMatchObject({
          type: MedusaError.Types.NOT_ALLOWED,
        });
        expect(await service.luckyDrawBalance('cus_wa')).toBe(100);

        // The draw finds nothing to do, and entering is over.
        expect(
          await service.drawDueLuckyDrawEvents({ now: afterEnd(event) }),
        ).toEqual({ drawn: 0, failed: 0 });
        expect(
          await service.drawLuckyDrawEvent({
            eventId: event.id,
            now: afterEnd(event),
          }),
        ).toBeNull();
        await nothingPaid();
        expect(await enter('cus_wa', event.id, 1)).toEqual({
          entered: false,
          reason: 'not_found',
        });

        const audits = await service.listAdminActionAudits({
          entity_type: 'lucky_draw_event',
          entity_id: event.id,
          action: 'disable',
        });
        expect(audits).toHaveLength(1);
        expect(audits[0]).toMatchObject({
          admin_id: ADMIN,
          reason: REASON,
          after: expect.objectContaining({
            refunded: 2,
            tickets_refunded: 60,
          }),
        });
      });

      it('is refused once a result exists, on an old-rule event and on a draft', async () => {
        const event = await liveEvent();
        await fund('cus_wd', 10);
        await enterOk('cus_wd', event.id, 5);
        await service.drawLuckyDrawEvent({
          eventId: event.id,
          now: afterEnd(event),
        });
        await expect(withdraw(event.id)).rejects.toMatchObject({
          type: MedusaError.Types.NOT_ALLOWED,
        });
        expect(await service.luckyDrawBalance('cus_wd')).toBe(5);

        const old = await oldEvent();
        await expect(withdraw(old.id)).rejects.toMatchObject({
          type: MedusaError.Types.NOT_ALLOWED,
        });
        const { id: draft } = await saveEvent();
        await expect(withdraw(draft)).rejects.toMatchObject({
          type: MedusaError.Types.NOT_ALLOWED,
        });
        await expect(withdraw('ldev_missing')).rejects.toMatchObject({
          type: MedusaError.Types.NOT_FOUND,
        });
      });

      it('waits for an in-flight entry and refunds it', async () => {
        const event = await liveEvent();
        await fund('cus_wf', 100);
        const entering = await holdLock(
          'pg_advisory_xact_lock_shared',
          `luckydraw:${event.id}`,
        );
        await entering.tx.execute(
          'INSERT INTO lucky_draw_entry (id, event_id, customer_id, tickets, created_at, updated_at) ' +
            "VALUES ('lden_wf', ?, 'cus_wf', 25, now(), now())",
          [event.id],
        );
        const going = withdraw(event.id);
        expect(await settledWithin(going, 500)).toBe(false);
        await entering.release();
        expect(await going).toEqual({ refunded: 1 });
        expect(await service.luckyDrawBalance('cus_wf')).toBe(125);
      });
    });

    describe('publishing', () => {
      const WINDOW_A = {
        startsAt: new Date(Date.now() + 10 * HOUR),
        endsAt: new Date(Date.now() + 20 * HOUR),
      };

      it('refuses an overlap, naming the clashing event; back-to-back is allowed', async () => {
        await liveEvent({ ...WINDOW_A, name: 'Event A' });

        const inside = await saveEvent({
          name: 'Inside',
          startsAt: new Date(WINDOW_A.startsAt.getTime() + HOUR),
          endsAt: new Date(WINDOW_A.endsAt.getTime() + HOUR),
        });
        await saveCredit(inside.id);
        await expect(publish(inside.id)).rejects.toMatchObject({
          type: MedusaError.Types.CONFLICT,
          message: expect.stringContaining('Event A'),
        });
        expect(
          (await service.listLuckyDrawEvents({ id: inside.id }))[0].status,
        ).toBe('draft');

        // Half-open windows: one ends the instant the next starts.
        const after = await saveEvent({
          name: 'After',
          startsAt: WINDOW_A.endsAt,
          endsAt: new Date(WINDOW_A.endsAt.getTime() + HOUR),
        });
        await saveCredit(after.id);
        await publish(after.id);
        const before = await saveEvent({
          name: 'Before',
          startsAt: new Date(WINDOW_A.startsAt.getTime() - HOUR),
          endsAt: WINDOW_A.startsAt,
        });
        await saveCredit(before.id);
        await publish(before.id);
      });

      it('an overlapping event with nothing left to draw does not clash', async () => {
        const window = {
          starts_at: new Date(Date.now() - HOUR),
          ends_at: new Date(Date.now() + 48 * HOUR),
        };
        // All cancelled, or all drawn, or withdrawn: nothing left to draw.
        const cancelled = await oldEvent(window);
        await oldPrize(cancelled.id, { cancelled_at: new Date() });
        const drawn = await oldEvent(window);
        const prize = await oldPrize(drawn.id);
        await service.drawLuckyDrawPrize({
          prizeId: prize.id,
          now: new Date(Date.now() + 2 * HOUR),
        });
        const withdrawn = await liveEvent({ name: 'Withdrawn' });
        await withdraw(withdrawn.id);

        await liveEvent({ name: 'Fine' });

        // One with a prize still to draw does clash, old rule or not.
        const open = await oldEvent({ ...window, name: 'Old Open' });
        await oldPrize(open.id);
        const { id } = await saveEvent({ name: 'Clashing' });
        await saveCredit(id);
        await expect(publish(id)).rejects.toMatchObject({
          type: MedusaError.Types.CONFLICT,
        });
      });

      it('two publishes at once cannot both go live', async () => {
        const a = await saveEvent({ ...WINDOW_A, name: 'Race A' });
        const b = await saveEvent({ ...WINDOW_A, name: 'Race B' });
        await saveCredit(a.id);
        await saveCredit(b.id);

        const results = await Promise.allSettled([
          publish(a.id),
          publish(b.id),
        ]);

        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        expect(
          await service.listLuckyDrawEvents({ status: 'published' }),
        ).toHaveLength(1);
      });

      it('re-runs the overlap check when a prize is added to a finished old event', async () => {
        const old = await oldEvent({
          name: 'Old Finished',
          starts_at: new Date(Date.now() - HOUR),
          ends_at: new Date(Date.now() + 48 * HOUR),
        });
        const prize = await oldPrize(old.id);
        await service.drawLuckyDrawPrize({
          prizeId: prize.id,
          now: new Date(Date.now() + 2 * HOUR),
        });
        await liveEvent({ name: 'New Live' });

        await expect(saveCredit(old.id)).rejects.toMatchObject({
          type: MedusaError.Types.CONFLICT,
          message: expect.stringContaining('New Live'),
        });
        expect(await prizesOf(old.id)).toHaveLength(1);
      });

      it('converts an existing draft: one winner, every prize at the end, seed on the event', async () => {
        await makeCard('draft-card');
        // A draft from before this change: per_prize, with its own draw times.
        const endsAt = new Date(Date.now() + 48 * HOUR);
        const [draft] = await service.createLuckyDrawEvents([
          {
            name: 'Old Draft',
            starts_at: new Date(Date.now() - HOUR),
            ends_at: endsAt,
            status: 'draft' as const,
            created_by: ADMIN,
          },
        ]);
        expect(draft.draw_mode).toBe('per_prize');
        await service.createLuckyDrawPrizes([
          {
            event_id: draft.id,
            kind: 'credit' as const,
            credit_myr: 5,
            title: 'Early',
            draw_at: new Date(Date.now() + HOUR),
          },
          {
            event_id: draft.id,
            kind: 'card' as const,
            card_handle: 'draft-card',
            title: 'Later',
            draw_at: new Date(Date.now() + 5 * HOUR),
          },
        ]);

        await publish(draft.id);

        const [row] = await service.listLuckyDrawEvents({ id: draft.id });
        expect(row).toMatchObject({
          status: 'published',
          draw_mode: 'one_winner',
        });
        expect(row.seed_hash).toMatch(/^[0-9a-f]{64}$/);
        for (const p of await prizesOf(draft.id)) {
          expect(new Date(p.draw_at).getTime()).toBe(endsAt.getTime());
          expect(p.seed_hash).toBeNull();
        }
        const [audit] = await service.listAdminActionAudits({
          entity_type: 'lucky_draw_event',
          entity_id: draft.id,
          action: 'publish',
        });
        expect(audit.after).toMatchObject({
          status: 'published',
          draw_mode: 'one_winner',
          seed_hash: row.seed_hash,
        });
        expect(JSON.stringify(audit)).not.toContain(row.seed_nonce);
      });

      it('new events are one_winner; a draft window edit moves its prizes', async () => {
        const { id } = await saveEvent();
        expect((await service.listLuckyDrawEvents({ id }))[0].draw_mode).toBe(
          'one_winner',
        );
        const prize = await saveCredit(id, 25, {
          // Ignored: a prize draws at the event's end.
          drawAt: new Date(Date.now() + HOUR),
        });
        const endsAt = new Date(Date.now() + 96 * HOUR);
        await saveEvent({ id, endsAt });
        const [row] = await service.listLuckyDrawPrizes({ id: prize.id });
        expect(new Date(row.draw_at).getTime()).toBe(endsAt.getTime());
      });

      it('refuses an end that has passed or is under 2 minutes away, and a missing card', async () => {
        const { id } = await saveEvent();
        await saveCredit(id);
        const [event] = await service.listLuckyDrawEvents({ id });
        const ends = new Date(event.ends_at).getTime();
        for (const now of [new Date(ends + 1000), new Date(ends - 60 * 1000)]) {
          await expect(publish(id, now)).rejects.toMatchObject({
            type: MedusaError.Types.INVALID_DATA,
          });
        }
        expect((await service.listLuckyDrawEvents({ id }))[0].status).toBe(
          'draft',
        );
        await publish(id, new Date(ends - 3 * 60 * 1000));

        const [card] = await makeCard('pub-gone');
        const later = await saveEvent({
          startsAt: new Date(Date.now() + 100 * HOUR),
          endsAt: new Date(Date.now() + 101 * HOUR),
        });
        await saveCard(later.id, 'pub-gone');
        await service.deleteCards([card.id]);
        await expect(publish(later.id)).rejects.toMatchObject({
          type: MedusaError.Types.INVALID_DATA,
          message: expect.stringContaining('pub-gone'),
        });
      });
    });

    describe('prize locks', () => {
      it('before the start a published event takes any change; from the start on, none', async () => {
        await makeCard('lock-a');
        await makeCard('lock-b');
        const startsAt = new Date(Date.now() + HOUR);
        const event = await liveEvent({ startsAt }, async (id) => {
          await saveCredit(id, 25);
        });
        const eventId = event.id;
        const [prize] = await prizesOf(eventId);
        const atStart = { now: startsAt };

        // Before: kind, card, amount, and a new prize. No seed on the prize.
        await saveCredit(eventId, 30, { id: prize.id });
        expect(Number((await prizesOf(eventId))[0].credit_myr)).toBe(30);
        await saveCard(eventId, 'lock-a', { id: prize.id });
        expect((await prizesOf(eventId))[0]).toMatchObject({
          kind: 'card',
          card_handle: 'lock-a',
        });
        const added = await saveCard(eventId, 'lock-b', { sort: 5 });
        const [addedRow] = await service.listLuckyDrawPrizes({ id: added.id });
        expect(addedRow.seed_hash).toBeNull();
        expect(new Date(addedRow.draw_at).getTime()).toBe(
          new Date(event.ends_at).getTime(),
        );

        // From the start: edits, a new prize, and even a retitle are refused.
        for (const attempt of [
          () => saveCard(eventId, 'lock-b', { id: prize.id, ...atStart }),
          () =>
            saveCard(eventId, 'lock-a', {
              id: prize.id,
              title: 'Retitled',
              ...atStart,
            }),
          () => saveCredit(eventId, 9, atStart),
        ]) {
          await expect(attempt()).rejects.toMatchObject({
            type: MedusaError.Types.NOT_ALLOWED,
          });
        }
        expect(await prizesOf(eventId)).toHaveLength(2);
      });

      it('a draft stays editable past its start date', async () => {
        const { id } = await saveEvent({
          startsAt: new Date(Date.now() - 5 * HOUR),
        });
        const { id: prizeId } = await saveCredit(id, 25);
        await saveCredit(id, 40, { id: prizeId });
        expect(Number((await prizesOf(id))[0].credit_myr)).toBe(40);
      });

      it('removing a prize: before the start only, and never the last one', async () => {
        const startsAt = new Date(Date.now() + HOUR);
        const event = await liveEvent({ startsAt }, async (id) => {
          await saveCredit(id, 25);
          await saveCredit(id, 10, { sort: 2 });
        });
        const [first, second] = await prizesOf(event.id);
        const cancel = (id: string, now?: Date) =>
          service.cancelLuckyDrawPrize({
            id,
            adminId: ADMIN,
            reason: REASON,
            now,
          });

        await expect(cancel(first.id, startsAt)).rejects.toMatchObject({
          type: MedusaError.Types.NOT_ALLOWED,
        });
        expect(await cancel(first.id)).toEqual({ refunded: 0 });
        await expect(cancel(second.id)).rejects.toMatchObject({
          type: MedusaError.Types.NOT_ALLOWED,
          message: expect.stringContaining('Withdraw'),
        });
        const [row] = await service.listLuckyDrawPrizes({ id: second.id });
        expect(row.cancelled_at).toBeNull();
      });

      it('a draft can lose its last prize', async () => {
        const { id } = await saveEvent();
        const { id: prizeId } = await saveCredit(id);
        expect(
          await service.cancelLuckyDrawPrize({
            id: prizeId,
            adminId: ADMIN,
            reason: REASON,
          }),
        ).toEqual({ refunded: 0 });
      });

      it('a prize save waits for an in-flight entry on a published event', async () => {
        const event = await liveEvent({
          startsAt: new Date(Date.now() + HOUR),
        });
        const entering = await holdLock(
          'pg_advisory_xact_lock_shared',
          `luckydraw:${event.id}`,
        );
        const saving = saveCredit(event.id, 7, { sort: 3 });
        expect(await settledWithin(saving, 500)).toBe(false);
        await entering.release();
        await saving;
      });
    });

    describe('old-rule events stay on the old rules', () => {
      it('enter and draw a per_prize event exactly as before, and the event job leaves it alone', async () => {
        const event = await oldEvent();
        const prize = await oldPrize(event.id);
        await fund('cus_old', 100);
        expect(
          await service.enterLuckyDraw({
            customerId: 'cus_old',
            prizeId: prize.id,
            tickets: 30,
          }),
        ).toMatchObject({ entered: true, balance: 70, myTickets: 30 });

        const now = new Date(Date.now() + 2 * HOUR);
        expect(await service.drawDueLuckyDrawEvents({ now })).toEqual({
          drawn: 0,
          failed: 0,
        });
        expect(await service.drawDueLuckyDrawPrizes({ now })).toEqual({
          drawn: 1,
          failed: 0,
        });

        const [result] = await service.listLuckyDrawResults({
          prize_id: prize.id,
        });
        const seed = deriveDrawSeed(
          process.env.LUCKY_DRAW_SEED_SECRET!,
          prize.seed_nonce!,
        );
        expect(result).toMatchObject({
          winner_customer_id: 'cus_old',
          seed,
          ticket_index: drawWinner(
            [{ customer_id: 'cus_old', tickets: 30 }],
            seed,
            prize.id,
          )!.ticketIndex,
          entries: [{ customer_id: 'cus_old', tickets: 30 }],
        });
        expect(await rewardCredits('cus_old')).toHaveLength(1);
        expect(await service.listLuckyDrawEventResults({})).toHaveLength(0);
      });

      it('a one-winner prize stays off the old paths', async () => {
        const event = await liveEvent();
        const [prize] = await prizesOf(event.id);
        await fund('cus_op', 100);
        expect(
          await service.enterLuckyDraw({
            customerId: 'cus_op',
            prizeId: prize.id,
            tickets: 1,
          }),
        ).toEqual({ entered: false, reason: 'not_found' });

        // Due by time, yet no "no published seed hash" warning every minute.
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
          expect(
            await service.drawDueLuckyDrawPrizes({ now: afterEnd(event) }),
          ).toEqual({ drawn: 0, failed: 0 });
          expect(warn).not.toHaveBeenCalled();
        } finally {
          warn.mockRestore();
        }
        expect(
          await service.drawLuckyDrawPrize({
            prizeId: prize.id,
            now: afterEnd(event),
          }),
        ).toBeNull();
        await nothingPaid();
      });

      it('per_prize events keep their own cancel and draw-time rules', async () => {
        const event = await oldEvent();
        const prize = await oldPrize(event.id);
        await fund('cus_oc', 100);
        await service.enterLuckyDraw({
          customerId: 'cus_oc',
          prizeId: prize.id,
          tickets: 10,
        });
        // Started, and its last prize: both fine under the old rule.
        expect(
          await service.cancelLuckyDrawPrize({
            id: prize.id,
            adminId: ADMIN,
            reason: REASON,
          }),
        ).toEqual({ refunded: 1 });
        expect(await service.luckyDrawBalance('cus_oc')).toBe(100);

        await expect(
          saveCredit(event.id, 5, {
            drawAt: new Date(Date.now() + 72 * HOUR),
          }),
        ).rejects.toMatchObject({ type: MedusaError.Types.INVALID_DATA });
        const drawAt = new Date(Date.now() + 2 * HOUR);
        const { id } = await saveCredit(event.id, 5, { drawAt });
        const [row] = await service.listLuckyDrawPrizes({ id });
        expect(new Date(row.draw_at).getTime()).toBe(drawAt.getTime());
        expect(row.seed_hash).toMatch(/^[0-9a-f]{64}$/);
      });
    });

    describe('the player page', () => {
      it('a fully drawn event no longer hides a live one', async () => {
        // The bug of 2026-10-30: this one started later and ends later, so the
        // old pick took it, and every prize of it had already drawn.
        const live = await oldEvent({
          name: 'Live',
          starts_at: new Date(Date.now() - 2 * HOUR),
          ends_at: new Date(Date.now() + 10 * HOUR),
        });
        const liveCredit = await oldPrize(live.id);
        const drawn = await oldEvent({
          name: 'Drawn',
          starts_at: new Date(Date.now() - HOUR),
          ends_at: new Date(Date.now() + 20 * HOUR),
        });
        const drawnPrize = await oldPrize(drawn.id, {
          draw_at: new Date(Date.now() + 1000),
        });
        await service.drawLuckyDrawPrize({
          prizeId: drawnPrize.id,
          now: new Date(Date.now() + 2000),
        });

        const page = await service.luckyDrawPage();
        expect(page.event?.id).toBe(live.id);
        expect(page.prizes.map((p) => p.id)).toEqual([liveCredit.id]);
      });

      it('with nothing left to draw, the event that finished last shows', async () => {
        // Found in the browser, 2026-10-30: an old event, fully drawn days ago
        // but still inside its window, hid a result drawn minutes ago.
        const older = await oldEvent({
          name: 'Older',
          starts_at: new Date(Date.now() - 5 * HOUR),
          ends_at: new Date(Date.now() + 20 * HOUR),
        });
        const olderPrize = await oldPrize(older.id, {
          draw_at: new Date(Date.now() - 4 * HOUR),
        });
        await service.drawLuckyDrawPrize({
          prizeId: olderPrize.id,
          now: new Date(Date.now() - 3 * HOUR),
        });
        const fresh = await oldEvent({
          name: 'Fresh',
          starts_at: new Date(Date.now() - 2 * HOUR),
          ends_at: new Date(Date.now() - HOUR),
        });
        const freshPrize = await oldPrize(fresh.id, {
          draw_at: new Date(Date.now() - HOUR),
        });
        await service.drawLuckyDrawPrize({
          prizeId: freshPrize.id,
          now: new Date(Date.now() - 30 * 60 * 1000),
        });

        const page = await service.luckyDrawPage();
        expect(page.event?.id).toBe(fresh.id);
      });

      it('a running one-winner event beats one that ended but is not drawn yet', async () => {
        const ended = await liveEvent({
          name: 'Ended',
          startsAt: new Date(Date.now() - 5 * HOUR),
          endsAt: new Date(Date.now() + 1 * HOUR),
        });
        const running = await liveEvent({
          name: 'Running',
          startsAt: new Date(Date.now() + 1 * HOUR),
          endsAt: new Date(Date.now() + 10 * HOUR),
        });
        const page = await service.luckyDrawPage({
          now: new Date(Date.now() + 2 * HOUR),
        });
        expect(page.event?.id).toBe(running.id);
        // Not running yet: the earlier one shows and this one is next.
        const before = await service.luckyDrawPage();
        expect(before.event?.id).toBe(ended.id);
        expect(before.next_event).toMatchObject({
          name: 'Running',
          starts_at: new Date(running.starts_at).toISOString(),
          ends_at: new Date(running.ends_at).toISOString(),
        });
      });

      it('shows the pot: totals, top entrants, no seed, then the result', async () => {
        const event = await liveEvent({ name: 'The Pot' });
        await fund('cus_pa', 100);
        await fund('cus_pb', 100);
        await enterOk('cus_pa', event.id, 10);
        await enterOk('cus_pb', event.id, 30);
        await enterOk('cus_pa', event.id, 5);

        const open = await service.luckyDrawPage();
        expect(open.event).toMatchObject({
          id: event.id,
          draw_mode: 'one_winner',
          seed_hash: event.seed_hash,
          total_tickets: 45,
          entrant_count: 2,
          top: [
            { customer_id: 'cus_pb', tickets: 30 },
            { customer_id: 'cus_pa', tickets: 15 },
          ],
          result: null,
        });
        expect(JSON.stringify(open)).not.toContain(event.seed_nonce);
        expect(open.prizes[0].result).toBeNull();
        expect(await service.luckyDrawMyEventTickets('cus_pa', event.id)).toBe(
          15,
        );
        expect(await service.luckyDrawMyEventTickets('cus_x', event.id)).toBe(
          0,
        );

        const now = afterEnd(event);
        await service.drawLuckyDrawEvent({ eventId: event.id, now });
        const done = await service.luckyDrawPage({ now });
        const stored = await eventResultOf(event.id);
        expect(done.event?.result).toEqual({
          winner_customer_id: stored.winner_customer_id,
          winner_tickets: stored.winner_tickets,
          total_tickets: 45,
          entrant_count: 2,
          seed: stored.seed,
          seed_hash: event.seed_hash,
          drawn_at: new Date(stored.drawn_at).toISOString(),
        });
        // The mirror row reads the event's hash and keeps luckyDrawLive right.
        expect(done.prizes[0].result).toMatchObject({
          seed: stored.seed,
          seed_hash: event.seed_hash,
        });
      });

      it('after the draw the top list and totals are the frozen ones', async () => {
        const event = await liveEvent();
        await fund('cus_ta', 100);
        await fund('cus_tb', 100);
        await enterOk('cus_ta', event.id, 90);
        await enterOk('cus_tb', event.id, 1);
        await service.createCustomerAccountStates([
          { customer_id: 'cus_ta', disabled: true },
        ]);
        const now = afterEnd(event);
        await service.drawLuckyDrawEvent({ eventId: event.id, now });
        const page = await service.luckyDrawPage({ now });
        expect(page.event).toMatchObject({
          total_tickets: 1,
          entrant_count: 1,
          top: [{ customer_id: 'cus_tb', tickets: 1 }],
        });
      });

      it('coming soon: no event, but the next one with a live prize is named', async () => {
        const later = await liveEvent({
          name: 'Later',
          startsAt: new Date(Date.now() + 50 * HOUR),
          endsAt: new Date(Date.now() + 60 * HOUR),
        });
        // Sooner, but nothing to win.
        const empty = await oldEvent({
          name: 'Empty',
          starts_at: new Date(Date.now() + 10 * HOUR),
          ends_at: new Date(Date.now() + 20 * HOUR),
        });
        await oldPrize(empty.id, { cancelled_at: new Date() });

        const page = await service.luckyDrawPage();
        expect(page.event).toBeNull();
        expect(page.prizes).toEqual([]);
        // The whole pool it will hold, so a player can see what is coming: no
        // seed, no ids, and a cancelled prize left out.
        expect(page.next_event).toEqual({
          name: 'Later',
          starts_at: new Date(later.starts_at).toISOString(),
          ends_at: new Date(later.ends_at).toISOString(),
          prizes: [
            {
              kind: 'credit',
              title: 'RM 25 credit',
              image: null,
              value_myr: 25,
            },
          ],
        });
        expect(JSON.stringify(page.next_event)).not.toContain('seed');
      });

      it('lingers 7 days after a draw, then goes', async () => {
        const event = await liveEvent();
        const now = afterEnd(event);
        await service.drawLuckyDrawEvent({ eventId: event.id, now });
        const day = 24 * HOUR;
        const seen = await service.luckyDrawPage({
          now: new Date(now.getTime() + 6 * day),
        });
        expect(seen.event?.id).toBe(event.id);
        const gone = await service.luckyDrawPage({
          now: new Date(now.getTime() + 8 * day),
        });
        expect(gone.event).toBeNull();
      });
    });

    describe('history', () => {
      const drawnEvent = async (
        name: string,
        winnerId: string,
        gap: number,
      ) => {
        await makeCard(`${name}-card`);
        const event = await liveEvent(
          {
            name,
            startsAt: new Date(Date.now() - 100 * HOUR + gap * HOUR),
            endsAt: new Date(Date.now() + gap * HOUR + HOUR),
          },
          async (id) => {
            await saveCredit(id, 25);
            await saveCard(id, `${name}-card`);
          },
        );
        await fund(winnerId, 10);
        await enterOk(winnerId, event.id, 10);
        await service.drawLuckyDrawEvent({
          eventId: event.id,
          now: afterEnd(event),
        });
        return event;
      };

      it('the feed has one row per event plus old prizes, never a mirror row', async () => {
        const event = await drawnEvent('Pot', 'cus_h1', 0);
        const old = await oldEvent();
        const prize = await oldPrize(old.id);
        await service.drawLuckyDrawPrize({
          prizeId: prize.id,
          now: new Date(Date.now() + 2 * HOUR),
        });

        const { rows, nextBefore } = await service.luckyDrawResultPage({
          limit: 10,
        });
        expect(nextBefore).toBeNull();
        expect(rows.map((r) => [r.kind, r.id]).sort()).toEqual([
          ['event', event.id],
          ['prize', prize.id],
        ]);

        const onePage = await service.luckyDrawResultPage({ limit: 1 });
        expect(onePage.rows).toHaveLength(1);
        expect(onePage.nextBefore).not.toBeNull();
        const second = await service.luckyDrawResultPage({
          limit: 1,
          before: new Date(onePage.nextBefore!),
        });
        expect(second.rows).toHaveLength(1);
        expect(second.rows[0].id).not.toBe(onePage.rows[0].id);
      });

      it('an event row carries the pot; the detail carries the frozen entries', async () => {
        const event = await drawnEvent('Detail', 'cus_h2', 0);
        const [row] = await service.luckyDrawEventResultRows([event.id]);
        const prizes = await prizesOf(event.id);
        expect(row).toMatchObject({
          event_id: event.id,
          event_name: 'Detail',
          winner_customer_id: 'cus_h2',
          seed_hash: event.seed_hash,
        });
        expect(row.prizes.map((p) => p.id).sort()).toEqual(
          prizes.map((p) => p.id).sort(),
        );

        const detail = await service.luckyDrawEventResult(event.id);
        expect(detail).toMatchObject({
          row: { event_id: event.id },
          entries: [{ customer_id: 'cus_h2', tickets: 10 }],
          ticket_index: expect.any(Number),
        });
        expect(await service.luckyDrawEventResult('ldev_none')).toBeNull();
      });

      it('/me has one row per event, with no NULL prize group', async () => {
        const event = await drawnEvent('Won', 'cus_me', 0);
        const lost = await liveEvent({
          name: 'Lost',
          startsAt: new Date(Date.now() + 5 * HOUR),
          endsAt: new Date(Date.now() + 6 * HOUR),
        });
        const open = await liveEvent({
          name: 'Open',
          startsAt: new Date(Date.now() + 7 * HOUR),
          endsAt: new Date(Date.now() + 8 * HOUR),
        });
        const gone = await liveEvent({
          name: 'Gone',
          startsAt: new Date(Date.now() + 9 * HOUR),
          endsAt: new Date(Date.now() + 10 * HOUR),
        });
        for (const e of [lost, open, gone]) {
          await service.createLuckyDrawEntries([
            { event_id: e.id, customer_id: 'cus_me', tickets: 2 },
            { event_id: e.id, customer_id: 'cus_me', tickets: 3 },
          ]);
        }
        await service.createLuckyDrawEntries([
          { event_id: lost.id, customer_id: 'cus_other', tickets: 1000 },
        ]);
        // A mixed result: seed picks one, so force the loser with an empty win.
        await service.createLuckyDrawEventResults([
          {
            event_id: lost.id,
            winner_customer_id: 'cus_other',
            winner_tickets: 1000,
            total_tickets: 1005,
            entrant_count: 2,
            seed: 's',
            entries: {},
            excluded: {},
            drawn_at: new Date(),
          },
        ]);
        await withdraw(gone.id);

        const mine = await service.luckyDrawMine('cus_me');
        const byId = new Map(mine.entries.map((e) => [e.prize_id, e]));
        expect(mine.entries).toHaveLength(4);
        expect(byId.get(event.id)).toMatchObject({
          event_id: event.id,
          title: 'Won',
          my_tickets: 10,
          status: 'won',
          draw_at: new Date(event.ends_at).toISOString(),
        });
        expect(byId.get(lost.id)).toMatchObject({
          my_tickets: 5,
          status: 'lost',
        });
        expect(byId.get(open.id)).toMatchObject({
          my_tickets: 5,
          status: 'open',
        });
        expect(byId.get(gone.id)).toMatchObject({ status: 'cancelled' });
        expect(byId.has(null as unknown as string)).toBe(false);
        // The pool's total, for "my chance": the draw's frozen number once drawn,
        // the entries so far while it runs.
        expect(byId.get(lost.id)?.total_tickets).toBe(1005);
        expect(byId.get(open.id)?.total_tickets).toBe(5);
      });
    });

    describe('the admin overview', () => {
      it('adds the mode, the totals and the hash, and never a nonce or an undrawn seed', async () => {
        const event = await liveEvent();
        await fund('cus_ad', 100);
        await fund('cus_ae', 100);
        await enterOk('cus_ad', event.id, 10);
        await enterOk('cus_ad', event.id, 5);
        await enterOk('cus_ae', event.id, 1);

        const rows = await service.adminLuckyDrawOverview();
        const row = rows.find((e) => e.id === event.id)!;
        expect(row).toMatchObject({
          draw_mode: 'one_winner',
          seed_hash: event.seed_hash,
          total_tickets: 16,
          entrant_count: 2,
        });
        const secret = process.env.LUCKY_DRAW_SEED_SECRET!;
        const text = JSON.stringify(rows);
        expect(text).not.toContain(event.seed_nonce);
        expect(text).not.toContain(deriveDrawSeed(secret, event.seed_nonce!));

        await service.drawLuckyDrawEvent({
          eventId: event.id,
          now: afterEnd(event),
        });
        const [drawn] = (await service.adminLuckyDrawOverview()).filter(
          (e) => e.id === event.id,
        );
        expect(drawn.prizes[0].result).toMatchObject({
          winner_customer_id: expect.any(String),
          seed: deriveDrawSeed(secret, event.seed_nonce!),
          granted: true,
        });
      });

      it('names the event holding a card, only while it is published and undrawn', async () => {
        await makeCard('held-card');
        expect(await service.luckyDrawEventHoldingCard('held-card')).toBeNull();

        const { id } = await saveEvent({ name: 'Holder' });
        await saveCard(id, 'held-card');
        // A draft holds nothing: publish re-checks the card.
        expect(await service.luckyDrawEventHoldingCard('held-card')).toBeNull();
        await publish(id);
        expect(await service.luckyDrawEventHoldingCard('held-card')).toBe(
          'Holder',
        );

        const [event] = await service.listLuckyDrawEvents({ id });
        await service.drawLuckyDrawEvent({
          eventId: id,
          now: afterEnd(event),
        });
        expect(await service.luckyDrawEventHoldingCard('held-card')).toBeNull();

        // A withdrawn event holds nothing either.
        const other = await liveEvent({
          name: 'Withdrawn holder',
          startsAt: afterEnd(event),
          endsAt: new Date(afterEnd(event).getTime() + HOUR),
        });
        await saveCard(other.id, 'held-card', { sort: 9 });
        expect(await service.luckyDrawEventHoldingCard('held-card')).toBe(
          'Withdrawn holder',
        );
        await withdraw(other.id);
        expect(await service.luckyDrawEventHoldingCard('held-card')).toBeNull();
      });
    });
  },
});
