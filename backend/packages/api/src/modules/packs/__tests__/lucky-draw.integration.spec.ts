/**
 * Lucky Draw entry — integration:modules
 *
 * enterLuckyDraw spends tickets on a prize under two advisory locks (the
 * shared prize lock, then the per-customer ticket lock). This pins the
 * rule order and the no-overspend guarantee against a real Postgres.
 */
process.env.LUCKY_DRAW_SEED_SECRET ??= 'test-lucky-draw-seed-secret';

import path from 'path';
import { moduleIntegrationTestRunner } from '@medusajs/test-utils';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../index';
import type PacksModuleService from '../service';
import LuckyDrawEvent from '../models/lucky-draw-event';
import LuckyDrawPrize from '../models/lucky-draw-prize';
import LuckyDrawEntry from '../models/lucky-draw-entry';
import LuckyDrawTicket from '../models/lucky-draw-ticket';
import LuckyDrawResult from '../models/lucky-draw-result';
import CreditTransaction from '../models/credit-transaction';
import CustomerAccountState from '../models/customer-account-state';
import AdminActionAudit from '../models/admin-action-audit';

jest.setTimeout(300 * 1000);

const HOUR = 60 * 60 * 1000;

moduleIntegrationTestRunner<PacksModuleService>({
  moduleName: PACKS_MODULE,
  resolve: path.resolve(__dirname, '../../..', 'modules/packs'),
  // A modules-type spec builds its schema from THIS array, never from the
  // migrations — every table the service touches has to be listed.
  moduleModels: [
    LuckyDrawEvent,
    LuckyDrawPrize,
    LuckyDrawEntry,
    LuckyDrawTicket,
    LuckyDrawResult,
    CreditTransaction,
    CustomerAccountState,
    AdminActionAudit,
  ],
  testSuite: ({ service, MikroOrmWrapper }) => {
    // Fixtures use the generated create methods. Each test uses its own
    // customer ids, so leftovers from another test never touch a balance.
    const makeEvent = async (
      over: Partial<{
        starts_at: Date;
        status: 'draft' | 'published' | 'cancelled';
      }> = {},
    ) => {
      const [event] = await service.createLuckyDrawEvents([
        {
          name: 'October Lucky Draw',
          starts_at: new Date(Date.now() - HOUR),
          ends_at: new Date(Date.now() + 24 * HOUR),
          status: 'published',
          created_by: 'admin_ld',
          ...over,
        },
      ]);
      return event;
    };

    const makePrize = async (
      eventId: string,
      over: Partial<{ draw_at: Date; cancelled_at: Date | null }> = {},
    ) => {
      const [prize] = await service.createLuckyDrawPrizes([
        {
          event_id: eventId,
          kind: 'card',
          card_handle: 'pikachu-base-set',
          credit_myr: null,
          title: 'Pikachu',
          draw_at: new Date(Date.now() + HOUR),
          ...over,
        },
      ]);
      return prize;
    };

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

    // Resolved-yet probe that cannot itself hang the suite.
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

    // Hold an advisory lock in its own open transaction, as a competing
    // writer would. `release` commits it.
    const holdLock = async (fn: 'pg_advisory_xact_lock', key: string) => {
      const tx = MikroOrmWrapper.forkManager();
      await tx.begin();
      await tx.execute(`SELECT ${fn}(hashtextextended(?, 0))`, [key]);
      return { tx, release: () => tx.commit() };
    };

    // A live prize in a published event that has started, drawn in an hour.
    const livePrize = async () => makePrize((await makeEvent()).id);

    it('spends tickets and records the entry', async () => {
      const prize = await livePrize();
      await fund('cus_e', 100);

      const r = await service.enterLuckyDraw({
        customerId: 'cus_e',
        prizeId: prize.id,
        tickets: 30,
      });

      expect(r).toMatchObject({ entered: true, balance: 70, myTickets: 30 });
      expect(await service.luckyDrawBalance('cus_e')).toBe(70);
      const entries = await service.listLuckyDrawEntries({
        prize_id: prize.id,
      });
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ customer_id: 'cus_e', tickets: 30 });
      const [spend] = await service.listLuckyDrawTickets({ reason: 'entry' });
      expect(spend).toMatchObject({
        customer_id: 'cus_e',
        delta: -30,
        ref: entries[0].id,
      });
    });

    it('adds up myTickets across entries on the same prize', async () => {
      const prize = await livePrize();
      await fund('cus_m', 100);
      const enter = (tickets: number) =>
        service.enterLuckyDraw({
          customerId: 'cus_m',
          prizeId: prize.id,
          tickets,
        });

      await enter(10);
      expect(await enter(15)).toMatchObject({
        entered: true,
        balance: 75,
        myTickets: 25,
      });
    });

    it('two parallel enters cannot overspend', async () => {
      const prize = await livePrize();
      await fund('cus_p', 100);

      const rs = await Promise.all(
        [1, 2].map(() =>
          service.enterLuckyDraw({
            customerId: 'cus_p',
            prizeId: prize.id,
            tickets: 80,
          }),
        ),
      );

      expect(rs.filter((r) => r.entered)).toHaveLength(1);
      expect(rs.filter((r) => !r.entered)).toEqual([
        { entered: false, reason: 'not_enough_tickets' },
      ]);
      expect(await service.luckyDrawBalance('cus_p')).toBe(20);
    });

    it('waits on the customer ticket lock, so parallel enters cannot both pass the balance check', async () => {
      const prize = await livePrize();
      await fund('cus_h', 100);
      const holder = await holdLock('pg_advisory_xact_lock', 'tickets:cus_h');
      let released = false;
      try {
        const enters = [1, 2].map(() =>
          service.enterLuckyDraw({
            customerId: 'cus_h',
            prizeId: prize.id,
            tickets: 80,
          }),
        );
        // Without the lock both would run to completion right now.
        expect(await settledWithin(Promise.all(enters), 750)).toBe(false);

        await holder.release();
        released = true;
        const rs = await Promise.all(enters);
        expect(rs.filter((r) => r.entered)).toHaveLength(1);
        expect(rs.filter((r) => !r.entered)).toEqual([
          { entered: false, reason: 'not_enough_tickets' },
        ]);
        expect(await service.luckyDrawBalance('cus_h')).toBe(20);
      } finally {
        if (!released) await holder.tx.rollback();
      }
    });

    it('an entry waits for a draw in flight, then sees its result and is refused', async () => {
      const prize = await livePrize();
      await fund('cus_w', 100);
      // The draw: exclusive prize lock, result written, commit.
      const draw = await holdLock(
        'pg_advisory_xact_lock',
        `luckydraw:${prize.id}`,
      );
      let released = false;
      try {
        await draw.tx.execute(
          'INSERT INTO lucky_draw_result (id, prize_id, seed, entries, excluded, drawn_at, created_at, updated_at) ' +
            "VALUES ('ldrs_test', ?, 'seed', '[]', '[]', now(), now(), now())",
          [prize.id],
        );
        const entering = service.enterLuckyDraw({
          customerId: 'cus_w',
          prizeId: prize.id,
          tickets: 10,
        });
        expect(await settledWithin(entering, 750)).toBe(false);

        await draw.release();
        released = true;
        expect(await entering).toEqual({ entered: false, reason: 'closed' });
        expect(await service.luckyDrawBalance('cus_w')).toBe(100);
      } finally {
        if (!released) await draw.tx.rollback();
      }
    });

    it('refuses at exactly draw_at', async () => {
      const drawAt = new Date(Date.now() + HOUR);
      const event = await makeEvent();
      const prize = await makePrize(event.id, { draw_at: drawAt });
      await fund('cus_d', 100);

      expect(
        await service.enterLuckyDraw({
          customerId: 'cus_d',
          prizeId: prize.id,
          tickets: 1,
          now: drawAt,
        }),
      ).toEqual({ entered: false, reason: 'closed' });
      // One millisecond earlier is still open.
      expect(
        await service.enterLuckyDraw({
          customerId: 'cus_d',
          prizeId: prize.id,
          tickets: 1,
          now: new Date(drawAt.getTime() - 1),
        }),
      ).toMatchObject({ entered: true });
    });

    it('refuses once the prize has a result, even before draw_at', async () => {
      const prize = await livePrize();
      await fund('cus_r', 100);
      await service.createLuckyDrawResults([
        {
          prize_id: prize.id,
          seed: 'a'.repeat(64),
          entries: {},
          excluded: {},
          drawn_at: new Date(),
        },
      ]);

      expect(
        await service.enterLuckyDraw({
          customerId: 'cus_r',
          prizeId: prize.id,
          tickets: 1,
        }),
      ).toEqual({ entered: false, reason: 'closed' });
      expect(await service.luckyDrawBalance('cus_r')).toBe(100);
    });

    it('refuses before the event starts', async () => {
      const startsAt = new Date(Date.now() + HOUR);
      const event = await makeEvent({ starts_at: startsAt });
      const prize = await makePrize(event.id, {
        draw_at: new Date(Date.now() + 3 * HOUR),
      });
      await fund('cus_s', 100);

      expect(
        await service.enterLuckyDraw({
          customerId: 'cus_s',
          prizeId: prize.id,
          tickets: 1,
          now: new Date(startsAt.getTime() - 1),
        }),
      ).toEqual({ entered: false, reason: 'not_open' });
      // At starts_at itself the window is open.
      expect(
        await service.enterLuckyDraw({
          customerId: 'cus_s',
          prizeId: prize.id,
          tickets: 1,
          now: startsAt,
        }),
      ).toMatchObject({ entered: true });
    });

    it('refuses an account that never topped up', async () => {
      const prize = await livePrize();
      await fund('cus_n', 100, false);

      expect(
        await service.enterLuckyDraw({
          customerId: 'cus_n',
          prizeId: prize.id,
          tickets: 1,
        }),
      ).toEqual({ entered: false, reason: 'no_topup' });
      expect(await service.luckyDrawBalance('cus_n')).toBe(100);
    });

    it('refuses more tickets than the balance', async () => {
      const prize = await livePrize();
      await fund('cus_b', 5);

      expect(
        await service.enterLuckyDraw({
          customerId: 'cus_b',
          prizeId: prize.id,
          tickets: 6,
        }),
      ).toEqual({ entered: false, reason: 'not_enough_tickets' });
    });

    it('refuses a cancelled prize and a draft event as not_found', async () => {
      await fund('cus_c', 100);
      const live = await makeEvent();
      const cancelledPrize = await makePrize(live.id, {
        cancelled_at: new Date(),
      });
      const draft = await makeEvent({ status: 'draft' });
      const draftPrize = await makePrize(draft.id);
      const cancelled = await makeEvent({ status: 'cancelled' });
      const cancelledEventPrize = await makePrize(cancelled.id);

      for (const prizeId of [
        cancelledPrize.id,
        draftPrize.id,
        cancelledEventPrize.id,
        'ldpz_missing',
      ]) {
        expect(
          await service.enterLuckyDraw({
            customerId: 'cus_c',
            prizeId,
            tickets: 1,
          }),
        ).toEqual({ entered: false, reason: 'not_found' });
      }
    });

    it('throws NOT_ALLOWED for a frozen account', async () => {
      const prize = await livePrize();
      await fund('cus_f', 100);
      await service.createCustomerAccountStates([
        { customer_id: 'cus_f', frozen: true, cause: 'manual' },
      ]);

      await expect(
        service.enterLuckyDraw({
          customerId: 'cus_f',
          prizeId: prize.id,
          tickets: 1,
        }),
      ).rejects.toMatchObject({ type: MedusaError.Types.NOT_ALLOWED });
    });

    it('throws INVALID_DATA for 0, negative and fractional tickets', async () => {
      const prize = await livePrize();
      await fund('cus_i', 100);

      for (const tickets of [0, -5, 1.5, '3', null, undefined]) {
        await expect(
          service.enterLuckyDraw({
            customerId: 'cus_i',
            prizeId: prize.id,
            tickets,
          }),
        ).rejects.toMatchObject({ type: MedusaError.Types.INVALID_DATA });
      }
      expect(await service.luckyDrawBalance('cus_i')).toBe(100);
    });
  },
});
