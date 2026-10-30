/**
 * Lucky Draw — integration:modules
 *
 * enterLuckyDraw spends tickets on a prize under two advisory locks (the
 * shared prize lock, then the per-customer ticket lock). This pins the
 * rule order and the no-overspend guarantee against a real Postgres, then the
 * admin console's writes and the draw job: once per prize, against the
 * published seed hash, paying exactly one winner.
 */
process.env.LUCKY_DRAW_SEED_SECRET ??= 'test-lucky-draw-seed-secret';

import path from 'path';
import { moduleIntegrationTestRunner } from '@medusajs/test-utils';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../index';
import type PacksModuleService from '../service';
import type { LuckyDrawOutcome } from '../service';
import {
  LUCKY_DRAW_PULL_PACK_ID,
  MAX_PRIZE_CREDIT_MYR,
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
    // Fixtures use the generated create methods. Each test uses its own
    // customer ids, so leftovers from another test never touch a balance. A row
    // made here is per_prize, the column's default: what every event published
    // before the one-winner change is. The admin writes can no longer make one.
    const makeEvent = async (
      over: Partial<{
        name: string;
        starts_at: Date;
        ends_at: Date;
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
      over: Partial<{
        draw_at: Date;
        cancelled_at: Date | null;
        kind: 'card' | 'credit';
        card_handle: string | null;
        credit_myr: number | null;
        seed_nonce: string;
        seed_hash: string;
      }> = {},
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
    const holdLock = async (
      fn: 'pg_advisory_xact_lock' | 'pg_advisory_xact_lock_shared',
      key: string,
    ) => {
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

    describe('admin events and prizes', () => {
      const ADMIN = 'user_admin_ld';
      const REASON = 'testing';

      const saveEvent = (over: Record<string, unknown> = {}) =>
        service.saveLuckyDrawEvent({
          name: 'November Lucky Draw',
          startsAt: new Date(Date.now() - HOUR),
          endsAt: new Date(Date.now() + 48 * HOUR),
          adminId: ADMIN,
          reason: REASON,
          ...over,
        });

      const makeCard = async (handle: string, marketValue = 50) => {
        const [card] = await service.createCards([
          {
            handle,
            name: `Card ${handle}`,
            set: 'Test Set',
            grader: 'PSA',
            grade: '10',
            market_value: marketValue,
            market_multiplier: 1.2,
            image: `/cdn/${handle}.webp`,
          },
        ]);
        return card;
      };

      const saveCreditPrize = (
        eventId: string,
        over: Record<string, unknown> = {},
      ) =>
        service.saveLuckyDrawPrize({
          eventId,
          kind: 'credit',
          creditMyr: 25,
          title: 'RM 25 credit',
          imageUrl: '/cdn/credit.webp',
          sort: 0,
          adminId: ADMIN,
          reason: REASON,
          ...over,
        });

      const saveCardPrize = (
        eventId: string,
        cardHandle: string,
        over: Record<string, unknown> = {},
      ) =>
        service.saveLuckyDrawPrize({
          eventId,
          kind: 'card',
          cardHandle,
          title: 'A card',
          sort: 1,
          adminId: ADMIN,
          reason: REASON,
          ...over,
        });

      const publish = (id: string, reason = REASON) =>
        service.publishLuckyDrawEvent({ id, adminId: ADMIN, reason });

      const cancel = (id: string, reason = REASON) =>
        service.cancelLuckyDrawPrize({ id, adminId: ADMIN, reason });

      const prizeRow = async (id: string) =>
        (await service.listLuckyDrawPrizes({ id }))[0];

      const rejectsWith = (p: Promise<unknown>, type: string) =>
        expect(p).rejects.toMatchObject({ type });

      it('saves a draft event, edits it freely, and audits both', async () => {
        const { id } = await saveEvent();
        const [draft] = await service.listLuckyDrawEvents({ id });
        expect(draft).toMatchObject({
          name: 'November Lucky Draw',
          status: 'draft',
          created_by: ADMIN,
        });

        const endsAt = new Date(Date.now() + 72 * HOUR);
        await saveEvent({ id, name: 'Renamed', endsAt });
        const [edited] = await service.listLuckyDrawEvents({ id });
        expect(edited.name).toBe('Renamed');
        expect(new Date(edited.ends_at).getTime()).toBe(endsAt.getTime());

        const audits = await service.listAdminActionAudits({
          entity_type: 'lucky_draw_event',
          entity_id: id,
        });
        expect(audits.map((a) => a.action).sort()).toEqual(['create', 'edit']);
        expect(audits.every((a) => a.admin_id === ADMIN)).toBe(true);
      });

      it('refuses a bad event name or window as INVALID_DATA', async () => {
        for (const name of ['', '   ', 'x'.repeat(81)]) {
          await rejectsWith(
            saveEvent({ name }),
            MedusaError.Types.INVALID_DATA,
          );
        }
        const at = new Date(Date.now() + HOUR);
        await rejectsWith(
          saveEvent({ startsAt: at, endsAt: at }),
          MedusaError.Types.INVALID_DATA,
        );
        await rejectsWith(
          saveEvent({ startsAt: at, endsAt: new Date(at.getTime() - 1) }),
          MedusaError.Types.INVALID_DATA,
        );
        await rejectsWith(
          saveEvent({ id: 'ldev_missing' }),
          MedusaError.Types.NOT_FOUND,
        );
      });

      it('lets a published event change only its name; a cancelled one is refused', async () => {
        const { id } = await saveEvent();
        await saveCreditPrize(id);
        await publish(id);
        const [published] = await service.listLuckyDrawEvents({ id });

        // Re-posting the unchanged window with a new name saves.
        await saveEvent({
          id,
          name: 'Renamed live',
          startsAt: new Date(published.starts_at),
          endsAt: new Date(published.ends_at),
        });
        expect((await service.listLuckyDrawEvents({ id }))[0].name).toBe(
          'Renamed live',
        );

        // A moved window is refused and nothing changes.
        await rejectsWith(
          saveEvent({
            id,
            startsAt: new Date(published.starts_at),
            endsAt: new Date(new Date(published.ends_at).getTime() + HOUR),
          }),
          MedusaError.Types.NOT_ALLOWED,
        );
        expect(
          new Date(
            (await service.listLuckyDrawEvents({ id }))[0].ends_at,
          ).getTime(),
        ).toBe(new Date(published.ends_at).getTime());

        const cancelled = await makeEvent({ status: 'cancelled' });
        await rejectsWith(
          saveEvent({ id: cancelled.id }),
          MedusaError.Types.NOT_ALLOWED,
        );
      });

      it('refuses a prize that is not exactly one of card / credit', async () => {
        const { id: eventId } = await saveEvent();
        await makeCard('real-card');
        const bad = [
          // card must exist
          saveCardPrize(eventId, 'no-such-card'),
          saveCardPrize(eventId, ''),
          // a card prize carries no credit
          saveCardPrize(eventId, 'real-card', { creditMyr: 10 }),
          // credit: amount required, in range, whole sen; no card handle
          saveCreditPrize(eventId, { creditMyr: undefined }),
          saveCreditPrize(eventId, { creditMyr: 0 }),
          saveCreditPrize(eventId, { creditMyr: -5 }),
          saveCreditPrize(eventId, { creditMyr: MAX_PRIZE_CREDIT_MYR + 1 }),
          saveCreditPrize(eventId, { creditMyr: 10.005 }),
          saveCreditPrize(eventId, { cardHandle: 'real-card' }),
          // title and sort
          saveCreditPrize(eventId, { title: '' }),
          saveCreditPrize(eventId, { sort: 1.5 }),
        ];
        for (const p of bad) {
          await rejectsWith(p, MedusaError.Types.INVALID_DATA);
        }
        expect(
          await service.listLuckyDrawPrizes({ event_id: eventId }),
        ).toHaveLength(0);
        await rejectsWith(
          saveCreditPrize('ldev_missing'),
          MedusaError.Types.NOT_FOUND,
        );
      });

      it('accepts the credit ceiling and a card prize; draw time defaults to the event end', async () => {
        const { id: eventId } = await saveEvent();
        await makeCard('c-ok');
        // No image: the storefront shows the credit coins.
        const credit = await saveCreditPrize(eventId, {
          creditMyr: MAX_PRIZE_CREDIT_MYR,
          imageUrl: '  ',
        });
        const card = await saveCardPrize(eventId, 'c-ok', { imageUrl: null });
        const [event] = await service.listLuckyDrawEvents({ id: eventId });

        const c = await prizeRow(credit.id);
        expect(Number(c.credit_myr)).toBe(MAX_PRIZE_CREDIT_MYR);
        expect(c).toMatchObject({
          kind: 'credit',
          card_handle: null,
          image_url: null,
        });
        expect(new Date(c.draw_at).getTime()).toBe(
          new Date(event.ends_at).getTime(),
        );
        const k = await prizeRow(card.id);
        expect(k).toMatchObject({
          kind: 'card',
          card_handle: 'c-ok',
          image_url: null,
        });
        expect(k.credit_myr).toBeNull();
        // Drafts have no commitment yet.
        expect(c.seed_nonce).toBeNull();
        expect(c.seed_hash).toBeNull();
      });

      it('refuses a draw time outside the event window', async () => {
        const startsAt = new Date(Date.now() + HOUR);
        const endsAt = new Date(Date.now() + 5 * HOUR);
        const { id: eventId } = await makeEvent({
          starts_at: startsAt,
          ends_at: endsAt,
        });
        for (const drawAt of [
          startsAt, // must be strictly after the start
          new Date(startsAt.getTime() - 1),
          new Date(endsAt.getTime() + 1),
        ]) {
          await rejectsWith(
            saveCreditPrize(eventId, { drawAt }),
            MedusaError.Types.INVALID_DATA,
          );
        }
        // The end itself is allowed.
        const { id } = await saveCreditPrize(eventId, { drawAt: endsAt });
        expect(new Date((await prizeRow(id)).draw_at).getTime()).toBe(
          endsAt.getTime(),
        );
      });

      it('refuses a draw time that has passed or is under 2 minutes away', async () => {
        // The event opened an hour ago: these draw times are inside its window,
        // so only the past-time rule can refuse them.
        const { id: eventId } = await makeEvent();
        for (const drawAt of [
          new Date(Date.now() - 10 * 60 * 1000),
          new Date(Date.now() + 60 * 1000),
        ]) {
          await rejectsWith(
            saveCreditPrize(eventId, { drawAt }),
            MedusaError.Types.INVALID_DATA,
          );
        }
        // The clock is injectable: an hour ahead is "past" once now moves on.
        const drawAt = new Date(Date.now() + HOUR);
        await rejectsWith(
          saveCreditPrize(eventId, {
            drawAt,
            now: new Date(drawAt.getTime() + 1000),
          }),
          MedusaError.Types.INVALID_DATA,
        );
        expect(
          await service.listLuckyDrawPrizes({ event_id: eventId }),
        ).toHaveLength(0);

        // An edit that MOVES the time is checked too...
        const { id } = await saveCreditPrize(eventId, { drawAt });
        const later = new Date(drawAt.getTime() + HOUR);
        await rejectsWith(
          saveCreditPrize(eventId, {
            id,
            drawAt: later,
            now: new Date(later.getTime() - 60 * 1000),
          }),
          MedusaError.Types.INVALID_DATA,
        );
        // ...but an unchanged re-post after the time passed still saves.
        await saveCreditPrize(eventId, {
          id,
          title: 'Retitled late',
          drawAt,
          now: new Date(drawAt.getTime() + HOUR),
        });
        expect((await prizeRow(id)).title).toBe('Retitled late');
      });

      it('refuses publishing an event with no live prize, or one already published', async () => {
        const { id: empty } = await saveEvent();
        await rejectsWith(publish(empty), MedusaError.Types.NOT_ALLOWED);

        const { id: only } = await saveEvent();
        const { id: prizeId } = await saveCreditPrize(only);
        await cancel(prizeId);
        await rejectsWith(publish(only), MedusaError.Types.NOT_ALLOWED);

        const { id: once } = await saveEvent();
        await saveCreditPrize(once);
        await publish(once);
        await rejectsWith(publish(once), MedusaError.Types.NOT_ALLOWED);
        await rejectsWith(publish('ldev_missing'), MedusaError.Types.NOT_FOUND);
      });

      it('refuses to publish, or add a prize to a published event, without the seed secret', async () => {
        const { id: eventId } = await saveEvent();
        await saveCreditPrize(eventId);
        const { id: liveId } = await makeEvent();

        const saved = process.env.LUCKY_DRAW_SEED_SECRET;
        delete process.env.LUCKY_DRAW_SEED_SECRET;
        try {
          await expect(publish(eventId)).rejects.toMatchObject({
            type: MedusaError.Types.NOT_ALLOWED,
            message: 'LUCKY_DRAW_SEED_SECRET is not set',
          });
          await expect(saveCreditPrize(liveId)).rejects.toMatchObject({
            type: MedusaError.Types.NOT_ALLOWED,
            message: 'LUCKY_DRAW_SEED_SECRET is not set',
          });
        } finally {
          process.env.LUCKY_DRAW_SEED_SECRET = saved;
        }
        // Nothing half-published.
        expect(
          (await service.listLuckyDrawEvents({ id: eventId }))[0].status,
        ).toBe('draft');
        expect(
          await service.listLuckyDrawPrizes({ event_id: liveId }),
        ).toHaveLength(0);
      });

      it('a published prize keeps kind, card, credit and draw time; title/image/sort still save', async () => {
        const { id: eventId } = await makeEvent();
        await makeCard('c-keep');
        await makeCard('c-other');
        const credit = await saveCreditPrize(eventId);
        const card = await saveCardPrize(eventId, 'c-keep');
        const before = await prizeRow(credit.id);
        const cardBefore = await prizeRow(card.id);

        // Each locked field refuses a changed value...
        const drawAt = new Date(new Date(before.draw_at).getTime() - HOUR);
        const locked = [
          saveCreditPrize(eventId, { id: credit.id, creditMyr: 99 }),
          saveCreditPrize(eventId, { id: credit.id, drawAt }),
          service.saveLuckyDrawPrize({
            id: credit.id,
            eventId,
            kind: 'card',
            cardHandle: 'c-keep',
            title: 'x',
            sort: 0,
            adminId: ADMIN,
            reason: REASON,
          }),
          saveCardPrize(eventId, 'c-other', { id: card.id }),
        ];
        for (const p of locked) {
          await rejectsWith(p, MedusaError.Types.NOT_ALLOWED);
        }
        const after = await prizeRow(credit.id);
        expect(Number(after.credit_myr)).toBe(25);
        expect(new Date(after.draw_at).getTime()).toBe(
          new Date(before.draw_at).getTime(),
        );
        expect((await prizeRow(card.id)).card_handle).toBe('c-keep');

        // ...while title / image / sort save, with the locked fields
        // re-posted unchanged (what the admin console sends)...
        await saveCreditPrize(eventId, {
          id: credit.id,
          title: 'Bigger title',
          imageUrl: '/cdn/new.webp',
          sort: 7,
          creditMyr: 25,
          drawAt: new Date(before.draw_at),
        });
        // ...or omitted.
        await saveCardPrize(eventId, 'c-keep', {
          id: card.id,
          title: 'Retitled',
          sort: 3,
          imageUrl: '/cdn/card-art.webp',
        });
        const saved = await prizeRow(credit.id);
        expect(saved).toMatchObject({
          title: 'Bigger title',
          image_url: '/cdn/new.webp',
          sort: 7,
          kind: 'credit',
        });
        expect(new Date(saved.draw_at).getTime()).toBe(
          new Date(before.draw_at).getTime(),
        );
        // The commitment is untouched by an edit.
        expect(saved.seed_nonce).toBe(before.seed_nonce);
        expect(saved.seed_hash).toBe(before.seed_hash);
        const savedCard = await prizeRow(card.id);
        expect(savedCard).toMatchObject({ title: 'Retitled', sort: 3 });
        expect(savedCard.seed_hash).toBe(cardBefore.seed_hash);
      });

      it('a prize added to a published event is committed at creation', async () => {
        const { id: eventId } = await makeEvent();

        const { id } = await saveCreditPrize(eventId, { sort: 5 });
        const row = await prizeRow(id);
        expect(row.seed_nonce).toMatch(/^[0-9a-f]{64}$/);
        expect(row.seed_hash).toBe(
          drawSeedHash(
            deriveDrawSeed(
              process.env.LUCKY_DRAW_SEED_SECRET!,
              row.seed_nonce!,
            ),
          ),
        );
      });

      it("refuses saving a prize on a cancelled event, a cancelled prize, or another event's prize", async () => {
        const cancelledEvent = await makeEvent({ status: 'cancelled' });
        await rejectsWith(
          saveCreditPrize(cancelledEvent.id),
          MedusaError.Types.NOT_ALLOWED,
        );

        const { id: eventId } = await saveEvent();
        const { id: other } = await saveEvent();
        const { id: prizeId } = await saveCreditPrize(eventId);
        await rejectsWith(
          saveCreditPrize(other, { id: prizeId }),
          MedusaError.Types.INVALID_DATA,
        );
        await cancel(prizeId);
        await rejectsWith(
          saveCreditPrize(eventId, { id: prizeId, title: 'late' }),
          MedusaError.Types.NOT_ALLOWED,
        );
      });

      it('cancel refunds every entrant their total on that prize, once', async () => {
        const prize = await livePrize();
        await fund('cus_ra', 100);
        await fund('cus_rb', 40);
        const enter = (customerId: string, tickets: number) =>
          service.enterLuckyDraw({ customerId, prizeId: prize.id, tickets });
        await enter('cus_ra', 30);
        await enter('cus_ra', 20);
        await enter('cus_rb', 10);
        expect(await service.luckyDrawBalance('cus_ra')).toBe(50);
        expect(await service.luckyDrawBalance('cus_rb')).toBe(30);

        const r = await cancel(prize.id);

        expect(r).toEqual({ refunded: 2 });
        expect(await service.luckyDrawBalance('cus_ra')).toBe(100);
        expect(await service.luckyDrawBalance('cus_rb')).toBe(40);
        const refunds = await service.listLuckyDrawTickets({
          reason: 'refund',
        });
        expect(
          refunds
            .filter((t) => t.ref.startsWith(`${prize.id}:`))
            .map((t) => [t.ref, t.delta])
            .sort(),
        ).toEqual([
          [`${prize.id}:cus_ra`, 50],
          [`${prize.id}:cus_rb`, 10],
        ]);
        expect((await prizeRow(prize.id)).cancelled_at).not.toBeNull();
        // Entries stay as the record of what was entered.
        expect(
          await service.listLuckyDrawEntries({ prize_id: prize.id }),
        ).toHaveLength(3);

        // A second cancel throws and refunds nothing more.
        await rejectsWith(cancel(prize.id), MedusaError.Types.NOT_ALLOWED);
        expect(await service.luckyDrawBalance('cus_ra')).toBe(100);
        // And the cancelled prize no longer takes entries.
        expect(await enter('cus_ra', 1)).toEqual({
          entered: false,
          reason: 'not_found',
        });
      });

      it('cancelling a prize with no entries refunds nobody; an unknown prize is NOT_FOUND', async () => {
        const prize = await livePrize();
        expect(await cancel(prize.id)).toEqual({ refunded: 0 });
        await rejectsWith(cancel('ldpz_missing'), MedusaError.Types.NOT_FOUND);
      });

      it('cancel is refused once the prize has a result', async () => {
        const prize = await makePrize(
          (await makeEvent()).id,
          commitDrawSeed(process.env.LUCKY_DRAW_SEED_SECRET!),
        );
        await fund('cus_rd', 100);
        await service.enterLuckyDraw({
          customerId: 'cus_rd',
          prizeId: prize.id,
          tickets: 10,
        });
        await service.drawLuckyDrawPrize({
          prizeId: prize.id,
          now: new Date(new Date(prize.draw_at).getTime() + 1000),
        });
        expect(
          await service.listLuckyDrawResults({ prize_id: prize.id }),
        ).toHaveLength(1);

        await rejectsWith(cancel(prize.id), MedusaError.Types.NOT_ALLOWED);
        expect((await prizeRow(prize.id)).cancelled_at).toBeNull();
        const refunds = await service.listLuckyDrawTickets({
          reason: 'refund',
        });
        expect(
          refunds.filter((t) => t.ref.startsWith(`${prize.id}:`)),
        ).toHaveLength(0);
        expect(await service.luckyDrawBalance('cus_rd')).toBe(90);
      });

      it('cancel waits for an in-flight entry, refunds it, and refuses entries afterwards', async () => {
        const prize = await livePrize();
        await fund('cus_in', 100);
        // An entry that has taken the SHARED prize lock but not yet committed.
        const entering = await holdLock(
          'pg_advisory_xact_lock_shared',
          `luckydraw:${prize.id}`,
        );
        let released = false;
        try {
          await entering.tx.execute(
            'INSERT INTO lucky_draw_entry (id, prize_id, customer_id, tickets, created_at, updated_at) ' +
              "VALUES ('lden_inflight', ?, 'cus_in', 25, now(), now())",
            [prize.id],
          );
          await entering.tx.execute(
            'INSERT INTO lucky_draw_ticket (id, customer_id, delta, reason, ref, created_at, updated_at) ' +
              "VALUES ('ldtk_inflight', 'cus_in', -25, 'entry', 'lden_inflight', now(), now())",
          );
          const cancelling = cancel(prize.id);
          // The exclusive lock cannot be had while the entry is in flight.
          expect(await settledWithin(cancelling, 750)).toBe(false);

          await entering.release();
          released = true;
          // The cancel then sees the committed entry and refunds it.
          expect(await cancelling).toEqual({ refunded: 1 });
          expect(await service.luckyDrawBalance('cus_in')).toBe(100);
          expect(
            await service.enterLuckyDraw({
              customerId: 'cus_in',
              prizeId: prize.id,
              tickets: 1,
            }),
          ).toEqual({ entered: false, reason: 'not_found' });
        } finally {
          if (!released) await entering.tx.rollback();
        }
      });

      it('writes an audit row per admin action', async () => {
        const { id: eventId } = await saveEvent({
          startsAt: new Date(Date.now() + HOUR),
        });
        const { id: prizeId } = await saveCreditPrize(eventId);
        await saveCreditPrize(eventId, { sort: 3 });
        await saveCreditPrize(eventId, { id: prizeId, title: 'Edited' });
        await publish(eventId, 'go live');
        await cancel(prizeId, 'withdrawn');

        const eventAudits = await service.listAdminActionAudits({
          entity_type: 'lucky_draw_event',
          entity_id: eventId,
        });
        expect(eventAudits.map((a) => a.action).sort()).toEqual([
          'create',
          'publish',
        ]);
        expect(eventAudits.find((a) => a.action === 'publish')).toMatchObject({
          admin_id: ADMIN,
          reason: 'go live',
        });

        const prizeAudits = await service.listAdminActionAudits({
          entity_type: 'lucky_draw_prize',
          entity_id: prizeId,
        });
        expect(prizeAudits.map((a) => a.action).sort()).toEqual([
          'create',
          'disable',
          'edit',
        ]);
        expect(prizeAudits.find((a) => a.action === 'disable')).toMatchObject({
          admin_id: ADMIN,
          reason: 'withdrawn',
          after: expect.objectContaining({ refunded: 0 }),
        });
      });

      it('a refused action leaves no audit row', async () => {
        const { id: eventId } = await saveEvent();
        await expect(publish(eventId)).rejects.toBeDefined();
        const audits = await service.listAdminActionAudits({
          entity_type: 'lucky_draw_event',
          entity_id: eventId,
        });
        expect(audits.map((a) => a.action)).toEqual(['create']);
      });

      describe('create an event with its prize pool', () => {
        const create = (over: Record<string, unknown> = {}) =>
          service.createLuckyDrawEventWithPrizes({
            name: 'December Lucky Draw',
            startsAt: new Date(Date.now() - HOUR),
            endsAt: new Date(Date.now() + 48 * HOUR),
            prizes: [],
            adminId: ADMIN,
            reason: REASON,
            ...over,
          });

        const cardPrize = (
          cardHandle: string,
          over: Record<string, unknown> = {},
        ) => ({
          kind: 'card' as const,
          cardHandle,
          creditMyr: null,
          title: `Card ${cardHandle}`,
          imageUrl: null,
          sort: 0,
          drawAt: null,
          ...over,
        });

        const creditPrize = (over: Record<string, unknown> = {}) => ({
          kind: 'credit' as const,
          cardHandle: null,
          creditMyr: 25,
          title: 'RM 25 bonus credit',
          imageUrl: '/cdn/credit.webp',
          sort: 0,
          drawAt: null,
          ...over,
        });

        const nothingExists = async () => {
          expect(await service.listLuckyDrawEvents({})).toHaveLength(0);
          expect(await service.listLuckyDrawPrizes({})).toHaveLength(0);
          expect(
            await service.listAdminActionAudits({
              entity_type: ['lucky_draw_event', 'lucky_draw_prize'],
            }),
          ).toHaveLength(0);
        };

        it('creates a draft event with every prize, draw time at the event end, and an audit row each', async () => {
          await makeCard('pool-a');
          await makeCard('pool-b');
          const { id, prizeIds } = await create({
            prizes: [
              cardPrize('pool-a', { sort: 0 }),
              creditPrize({ sort: 1 }),
              cardPrize('pool-b', { title: '  Second card  ', sort: 2 }),
            ],
          });

          const [event] = await service.listLuckyDrawEvents({ id });
          expect(event).toMatchObject({
            name: 'December Lucky Draw',
            status: 'draft',
            created_by: ADMIN,
          });
          expect(prizeIds).toHaveLength(3);

          // prizeIds follow the input order.
          const rows = await Promise.all(prizeIds.map((p) => prizeRow(p)));
          expect(rows.map((r) => r.sort)).toEqual([0, 1, 2]);
          expect(rows.map((r) => r.kind)).toEqual(['card', 'credit', 'card']);
          expect(rows.map((r) => r.event_id)).toEqual([id, id, id]);
          expect(rows[0]).toMatchObject({
            card_handle: 'pool-a',
            image_url: null,
          });
          expect(rows[0].credit_myr).toBeNull();
          expect(rows[1]).toMatchObject({
            card_handle: null,
            image_url: '/cdn/credit.webp',
          });
          expect(Number(rows[1].credit_myr)).toBe(25);
          expect(rows[2].title).toBe('Second card');
          for (const r of rows) {
            expect(new Date(r.draw_at).getTime()).toBe(
              new Date(event.ends_at).getTime(),
            );
            // A draft carries no seed commitment: publish makes it.
            expect(r.seed_nonce).toBeNull();
            expect(r.seed_hash).toBeNull();
          }

          const eventAudits = await service.listAdminActionAudits({
            entity_type: 'lucky_draw_event',
            entity_id: id,
          });
          expect(eventAudits).toHaveLength(1);
          expect(eventAudits[0]).toMatchObject({
            action: 'create',
            admin_id: ADMIN,
            reason: REASON,
          });
          const prizeAudits = await service.listAdminActionAudits({
            entity_type: 'lucky_draw_prize',
            entity_id: prizeIds,
          });
          expect(prizeAudits.map((a) => a.entity_id).sort()).toEqual(
            [...prizeIds].sort(),
          );
          expect(
            prizeAudits.every(
              (a) =>
                a.action === 'create' &&
                a.admin_id === ADMIN &&
                a.reason === REASON,
            ),
          ).toBe(true);
        });

        it('ignores a draw time: a prize draws at the event end', async () => {
          await makeCard('pool-t');
          const endsAt = new Date(Date.now() + 48 * HOUR);
          const { prizeIds } = await create({
            endsAt,
            prizes: [
              cardPrize('pool-t', { drawAt: new Date(Date.now() + HOUR) }),
            ],
          });
          expect(
            new Date((await prizeRow(prizeIds[0])).draw_at).getTime(),
          ).toBe(endsAt.getTime());
        });

        it('refuses a pool on an event that ends under 2 minutes from now', async () => {
          await makeCard('pool-s');
          await rejectsWith(
            create({
              endsAt: new Date(Date.now() + 60 * 1000),
              prizes: [cardPrize('pool-s')],
            }),
            MedusaError.Types.INVALID_DATA,
          );
          await nothingExists();
        });

        it('with no prizes is a plain draft event', async () => {
          const { id, prizeIds } = await create();
          expect(prizeIds).toEqual([]);
          const [event] = await service.listLuckyDrawEvents({ id });
          expect(event.status).toBe('draft');
          expect(
            await service.listLuckyDrawPrizes({ event_id: id }),
          ).toHaveLength(0);
          expect(
            await service.listAdminActionAudits({
              entity_type: 'lucky_draw_event',
              entity_id: id,
            }),
          ).toHaveLength(1);
        });

        it('one bad prize creates nothing: no event, no prizes, no audit', async () => {
          await makeCard('pool-ok');
          const good = [cardPrize('pool-ok'), creditPrize({ sort: 1 })];
          const bad: Record<string, unknown>[] = [
            creditPrize({ creditMyr: 0 }),
            creditPrize({ creditMyr: MAX_PRIZE_CREDIT_MYR + 1 }),
            creditPrize({ creditMyr: 10.005 }),
            creditPrize({ cardHandle: 'pool-ok' }),
            cardPrize('no-such-card'),
            cardPrize(''),
            cardPrize('pool-ok', { creditMyr: 10 }),
            cardPrize('pool-ok', { title: '' }),
            cardPrize('pool-ok', { sort: 1.5 }),
          ];
          for (const prize of bad) {
            await rejectsWith(
              create({ prizes: [...good, prize] }),
              MedusaError.Types.INVALID_DATA,
            );
            await nothingExists();
          }
        });

        it('a database failure after the event and prizes are written rolls all of it back', async () => {
          await makeCard('pool-r');
          // Passes every rule above, then Postgres refuses the NUL character on
          // the prize insert — after the event row is already in the transaction.
          await expect(
            create({
              prizes: [
                cardPrize('pool-r'),
                creditPrize({ title: 'bad\u0000' }),
              ],
            }),
          ).rejects.toThrow(/insert into "lucky_draw_prize"/);
          await nothingExists();
        });

        it('names the offending prize in the refusal', async () => {
          await makeCard('pool-n');
          await expect(
            create({
              prizes: [cardPrize('pool-n'), creditPrize({ creditMyr: 0 })],
            }),
          ).rejects.toThrow(/^Prize 2: .*credit_myr/);
        });

        it('applies the event rules too: a bad name or window creates nothing', async () => {
          await makeCard('pool-e');
          const at = new Date(Date.now() + HOUR);
          for (const over of [
            { name: '   ' },
            { name: 'x'.repeat(81) },
            { startsAt: at, endsAt: at },
            { startsAt: at, endsAt: new Date(at.getTime() - 1) },
          ]) {
            await rejectsWith(
              create({ ...over, prizes: [cardPrize('pool-e')] }),
              MedusaError.Types.INVALID_DATA,
            );
          }
          await nothingExists();
        });

        it('lets the same card be a prize twice', async () => {
          await makeCard('pool-d');
          const { prizeIds } = await create({
            prizes: [cardPrize('pool-d'), cardPrize('pool-d', { sort: 1 })],
          });
          expect(prizeIds).toHaveLength(2);
        });

        it('publishes like any other draft', async () => {
          await makeCard('pool-p');
          const { id } = await create({ prizes: [cardPrize('pool-p')] });
          await publish(id);
          expect((await service.listLuckyDrawEvents({ id }))[0].status).toBe(
            'published',
          );
        });
      });
    });

    describe('admin ticket grants', () => {
      const reject = (p: Promise<unknown>, type: string) =>
        expect(p).rejects.toMatchObject({ type });
      const grant = (
        customerId: string,
        tickets: unknown,
        idempotencyKey?: unknown,
        note: unknown = 'Launch gift',
      ) =>
        service.adjustLuckyDrawTickets({
          customerId,
          tickets,
          note,
          adminId: 'user_grant',
          idempotencyKey,
        });

      it('gives tickets once per key, writes the ledger and the audit', async () => {
        expect(await grant('cus_g1', 50, 'k1')).toEqual({
          tickets: 50,
          balance: 50,
          replayed: false,
        });
        // A retried request (lost response) replays: no second grant.
        expect(await grant('cus_g1', 50, 'k1')).toEqual({
          tickets: 50,
          balance: 50,
          replayed: true,
        });
        expect(await service.luckyDrawBalance('cus_g1')).toBe(50);
        const rows = await service.listLuckyDrawTickets({
          customer_id: 'cus_g1',
        });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          delta: 50,
          reason: 'admin_grant',
          ref: 'admin:cus_g1:k1',
        });
        const audits = await service.listAdminActionAudits({
          entity_type: 'customer',
          entity_id: 'cus_g1',
        });
        expect(audits).toHaveLength(1);
        expect(audits[0]).toMatchObject({
          admin_id: 'user_grant',
          action: 'edit',
          reason: 'Launch gift',
          before: { lucky_draw_tickets: 0 },
          after: { lucky_draw_tickets: 50, delta: 50 },
        });
      });

      it('a key is scoped to its customer; reused with another amount it conflicts', async () => {
        await grant('cus_g2', 10, 'shared');
        // The same key for another customer is a separate grant.
        expect(await grant('cus_g3', 10, 'shared')).toMatchObject({
          balance: 10,
          replayed: false,
        });
        await reject(grant('cus_g2', 99, 'shared'), MedusaError.Types.CONFLICT);
        expect(await service.luckyDrawBalance('cus_g2')).toBe(10);
      });

      it('takes tickets back, never below zero', async () => {
        await grant('cus_g4', 30, 'a');
        expect(await grant('cus_g4', -20, 'b')).toMatchObject({ balance: 10 });
        await reject(grant('cus_g4', -11, 'c'), MedusaError.Types.NOT_ALLOWED);
        expect(await grant('cus_g4', -10, 'd')).toMatchObject({ balance: 0 });
        expect(await service.luckyDrawBalance('cus_g4')).toBe(0);
      });

      it('refuses a bad amount, note or key and writes nothing', async () => {
        for (const bad of [0, 1.5, '5', null, 1_000_001]) {
          await reject(grant('cus_g5', bad), MedusaError.Types.INVALID_DATA);
        }
        await reject(
          grant('cus_g5', 5, undefined, '   '),
          MedusaError.Types.INVALID_DATA,
        );
        await reject(
          grant('cus_g5', 5, undefined, 'x'.repeat(513)),
          MedusaError.Types.INVALID_DATA,
        );
        await reject(grant('cus_g5', 5, 42), MedusaError.Types.INVALID_DATA);
        expect(await service.luckyDrawBalance('cus_g5')).toBe(0);
        expect(
          await service.listAdminActionAudits({ entity_id: 'cus_g5' }),
        ).toHaveLength(0);
      });

      it('without a key, each call is its own grant', async () => {
        await grant('cus_g6', 5);
        await grant('cus_g6', 5);
        expect(await service.luckyDrawBalance('cus_g6')).toBe(10);
      });
    });

    describe('admin overview and ticket history', () => {
      it('lists events with prize facts and never an undrawn seed', async () => {
        clearFxDisplayCache();
        await service.createFxRates([
          { pair: 'USD_MYR', rate: 4, source: 'test', manual_override: false },
        ]);
        await service.createCards([
          {
            handle: 'ov-card',
            name: 'Overview Card',
            set: 'S',
            grader: 'PSA',
            grade: '10',
            market_value: 50,
            market_multiplier: 1.2,
            image: '/cdn/ov.webp',
          },
        ]);
        const admin = { adminId: 'user_ov', reason: 'x' };
        const { id: eventId } = await makeEvent({ name: 'Overview Draw' });
        const credit = await service.saveLuckyDrawPrize({
          eventId,
          kind: 'credit',
          creditMyr: 25,
          title: 'Credit',
          imageUrl: '/c.webp',
          sort: 2,
          ...admin,
        });
        const card = await service.saveLuckyDrawPrize({
          eventId,
          kind: 'card',
          cardHandle: 'ov-card',
          title: 'Card',
          sort: 1,
          ...admin,
        });
        await fund('cus_ov1', 100);
        await fund('cus_ov2', 100);
        for (const [customerId, tickets] of [
          ['cus_ov1', 30],
          ['cus_ov1', 20],
          ['cus_ov2', 10],
        ] as const) {
          await service.enterLuckyDraw({
            customerId,
            prizeId: card.id,
            tickets,
          });
        }

        const events = await service.adminLuckyDrawOverview();
        const ev = events.find((e) => e.id === eventId)!;
        expect(ev).toMatchObject({
          name: 'Overview Draw',
          status: 'published',
        });
        expect(typeof ev.starts_at).toBe('string');
        // Ordered by sort: the card (1) before the credit (2).
        expect(ev.prizes.map((p) => p.id)).toEqual([card.id, credit.id]);
        const [cardPrize, creditPrize] = ev.prizes;
        expect(cardPrize).toMatchObject({
          kind: 'card',
          card_handle: 'ov-card',
          credit_myr: null,
          total_tickets: 60,
          entrant_count: 2,
          // FMV $50 x FX 4 x markup 1.2, the number the task hub shows.
          value_myr: 240,
          result: null,
          cancelled_at: null,
        });
        expect(creditPrize).toMatchObject({
          kind: 'credit',
          credit_myr: 25,
          value_myr: 25,
          total_tickets: 0,
          entrant_count: 0,
          result: null,
        });
        const [row] = await service.listLuckyDrawPrizes({ id: card.id });
        expect(cardPrize.seed_hash).toBe(row.seed_hash);
        // Nothing seed-shaped anywhere for an undrawn prize.
        const seed = deriveDrawSeed(
          process.env.LUCKY_DRAW_SEED_SECRET!,
          row.seed_nonce!,
        );
        expect(JSON.stringify(events)).not.toContain(seed);
        expect(cardPrize).not.toHaveProperty('seed');
        expect(cardPrize).not.toHaveProperty('seed_nonce');
      });

      it('shows the seed only from a result row', async () => {
        const event = await makeEvent();
        const prize = await makePrize(event.id);
        const drawnAt = new Date();
        await service.createLuckyDrawResults([
          {
            prize_id: prize.id,
            winner_customer_id: 'cus_win',
            winner_tickets: 30,
            total_tickets: 60,
            entrant_count: 2,
            seed: 'e'.repeat(64),
            entries: {},
            excluded: {},
            drawn_at: drawnAt,
          },
        ]);

        const ev = (await service.adminLuckyDrawOverview()).find(
          (e) => e.id === event.id,
        )!;
        expect(ev.prizes[0].result).toEqual({
          winner_customer_id: 'cus_win',
          winner_tickets: 30,
          total_tickets: 60,
          entrant_count: 2,
          drawn_at: drawnAt.toISOString(),
          seed: 'e'.repeat(64),
          // A card prize with a winner and no pull: nothing was minted.
          granted: false,
        });
      });

      it('ticket history is newest first with the live balance', async () => {
        await service.createLuckyDrawTickets([
          {
            customer_id: 'cus_h1',
            delta: 50,
            reason: 'task_claim',
            ref: 'h-claim-1',
          },
        ]);
        await service.createLuckyDrawTickets([
          {
            customer_id: 'cus_h1',
            delta: -20,
            reason: 'entry',
            ref: 'h-entry-1',
          },
        ]);
        await service.createLuckyDrawTickets([
          {
            customer_id: 'cus_h2',
            delta: 7,
            reason: 'task_claim',
            ref: 'h-claim-2',
          },
        ]);

        const h = await service.luckyDrawTicketHistory('cus_h1', 10);
        expect(h.balance).toBe(30);
        expect(h.rows.map((r) => [r.delta, r.reason, r.ref])).toEqual([
          [-20, 'entry', 'h-entry-1'],
          [50, 'task_claim', 'h-claim-1'],
        ]);
        expect(typeof h.rows[0].created_at).toBe('string');
        // take bounds the rows, not the balance.
        const one = await service.luckyDrawTicketHistory('cus_h1', 1);
        expect(one.rows).toHaveLength(1);
        expect(one.balance).toBe(30);
        expect(await service.luckyDrawTicketHistory('cus_nobody', 10)).toEqual({
          balance: 0,
          rows: [],
        });
      });
    });
    describe('the player page', () => {
      it('skips a published event whose prizes were all cancelled', async () => {
        const credit = {
          kind: 'credit' as const,
          card_handle: null,
          credit_myr: 5,
        };
        const right = await makeEvent({
          starts_at: new Date(Date.now() - 2 * HOUR),
        });
        const shown = await makePrize(right.id, credit);
        // Starts later and ends later, so it would win both picks — but it
        // has nothing left to enter.
        const wrong = await makeEvent();
        await makePrize(wrong.id, { ...credit, cancelled_at: new Date() });

        const live = await service.luckyDrawPage();
        expect(live.event?.id).toBe(right.id);
        expect(live.prizes.map((p) => p.id)).toEqual([shown.id]);

        // The recently-ended fallback skips it too.
        const ended = await service.luckyDrawPage({
          now: new Date(Date.now() + 30 * HOUR),
        });
        expect(ended.event?.id).toBe(right.id);
      });
    });

    describe('the draw', () => {
      const secret = () => process.env.LUCKY_DRAW_SEED_SECRET!;

      // A published, committed RM 25 credit prize that draws in an hour, so the
      // test can still enter; draw it with `after(prize)`.
      const committedPrize = async (
        over: Parameters<typeof makePrize>[1] = {},
        event: Parameters<typeof makeEvent>[0] = {},
      ) =>
        makePrize((await makeEvent(event)).id, {
          kind: 'credit',
          card_handle: null,
          credit_myr: 25,
          ...commitDrawSeed(secret()),
          ...over,
        });

      const after = (prize: { draw_at: Date | string }) =>
        new Date(new Date(prize.draw_at).getTime() + 1000);

      const enter = async (
        customerId: string,
        prizeId: string,
        tickets: number,
      ) => {
        const r = await service.enterLuckyDraw({
          customerId,
          prizeId,
          tickets,
        });
        expect(r).toMatchObject({ entered: true });
      };

      const resultOf = async (prizeId: string) => {
        const rows = await service.listLuckyDrawResults({ prize_id: prizeId });
        expect(rows.length).toBeLessThanOrEqual(1);
        return rows[0];
      };

      const createCard = (handle: string) =>
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

      const rewardCredits = (customerId: string) =>
        service.listCreditTransactions({
          customer_id: customerId,
          reason: 'reward_credit',
        });

      const drawnCreditPrize = async () => {
        const prize = await committedPrize();
        for (const [customerId, tickets] of [
          ['cus_da', 30],
          ['cus_db', 50],
          ['cus_dc', 20],
        ] as const) {
          await fund(customerId, 100);
          await enter(customerId, prize.id, tickets);
        }
        return prize;
      };

      it('draws a due credit prize once, pays bonus credit, stores a checkable result', async () => {
        const prize = await drawnCreditPrize();
        const seed = deriveDrawSeed(secret(), prize.seed_nonce!);
        const entrants = [
          { customer_id: 'cus_da', tickets: 30 },
          { customer_id: 'cus_db', tickets: 50 },
          { customer_id: 'cus_dc', tickets: 20 },
        ];
        const expected = drawWinner(entrants, seed, prize.id)!;
        const winner = expected.winner.customer_id;

        expect(
          await service.drawDueLuckyDrawPrizes({ now: after(prize) }),
        ).toEqual({ drawn: 1, failed: 0 });

        const res = await resultOf(prize.id);
        expect(res).toMatchObject({
          winner_customer_id: winner,
          winner_tickets: expected.winner.tickets,
          ticket_index: expected.ticketIndex,
          total_tickets: 100,
          entrant_count: 3,
          seed,
          pull_id: null,
        });
        expect(res.entries).toEqual(entrants);
        expect(res.excluded).toEqual([]);
        expect(drawSeedHash(res.seed)).toBe(prize.seed_hash);

        // Bonus credit: the whole row is spend-only, keyed once per prize.
        const credits = await rewardCredits(winner);
        expect(credits).toHaveLength(1);
        expect(credits[0]).toMatchObject({
          id: res.credit_transaction_id,
          source_transaction_id: `luckydraw:${prize.id}`,
          bonus_cents: 2500,
        });
        expect(Number(credits[0].amount)).toBe(25);
        const wp = await service.listLedgerEntries({
          type: 'WP',
          customer_id: winner,
        });
        expect(wp).toHaveLength(1);
        expect(wp[0].ref_id).toBe(res.credit_transaction_id);
        expect(Number(wp[0].wallet_delta)).toBe(25);
        expect(wp[0].payload).toMatchObject({
          period: `luckydraw:${prize.id}`,
        });
        for (const loser of ['cus_da', 'cus_db', 'cus_dc'].filter(
          (c) => c !== winner,
        )) {
          expect(await rewardCredits(loser)).toHaveLength(0);
        }

        // Never twice: the loop finds nothing, the direct call re-checks under
        // the lock, and nothing more is paid.
        expect(
          await service.drawDueLuckyDrawPrizes({ now: after(prize) }),
        ).toEqual({ drawn: 0, failed: 0 });
        expect(
          await service.drawLuckyDrawPrize({
            prizeId: prize.id,
            now: after(prize),
          }),
        ).toBeNull();
        expect(await rewardCredits(winner)).toHaveLength(1);
        expect(
          await service.listLuckyDrawResults({ prize_id: prize.id }),
        ).toHaveLength(1);
      });

      it('a recompute from the stored result picks the same winner', async () => {
        const prize = await drawnCreditPrize();
        await service.drawDueLuckyDrawPrizes({ now: after(prize) });

        const res = await resultOf(prize.id);
        const again = drawWinner(
          res.entries as unknown as DrawEntrant[],
          res.seed,
          prize.id,
        );
        expect(again?.winner.customer_id).toBe(res.winner_customer_id);
        expect(again?.ticketIndex).toBe(res.ticket_index);
      });

      it('a card prize mints one reward pull for the winner with full bonus bp, earmarked once stock is taken', async () => {
        await createCard('ld-card');
        const prize = await committedPrize({
          kind: 'card',
          card_handle: 'ld-card',
          credit_myr: null,
        });
        await fund('cus_k', 100);
        await enter('cus_k', prize.id, 10);
        const takes: [string, number][] = [];
        const outcomes: LuckyDrawOutcome[] = [];

        expect(
          await service.drawDueLuckyDrawPrizes({
            now: after(prize),
            decrementStock: async (handle, qty) => {
              takes.push([handle, qty]);
              return true;
            },
            onDrawn: async (o) => {
              outcomes.push(o);
            },
          }),
        ).toEqual({ drawn: 1, failed: 0 });

        const res = await resultOf(prize.id);
        const pulls = await service.listPulls({ customer_id: 'cus_k' });
        expect(pulls).toHaveLength(1);
        expect(pulls[0]).toMatchObject({
          id: res.pull_id,
          pack_id: LUCKY_DRAW_PULL_PACK_ID,
          card_id: 'ld-card',
          order_id: null,
          source: 'reward',
          bonus_bp: BONUS_BP_FULL,
          stock_earmarked: true,
        });
        expect(res).toMatchObject({
          winner_customer_id: 'cus_k',
          credit_transaction_id: null,
        });
        expect(takes).toEqual([['ld-card', 1]]);
        expect(outcomes).toEqual([
          {
            prizeId: prize.id,
            winnerId: 'cus_k',
            kind: 'card',
            cardHandle: 'ld-card',
            pullId: res.pull_id,
          },
        ]);
        expect(await rewardCredits('cus_k')).toHaveLength(0);
        // A card-only WP row, like a weekly-challenge card prize.
        const wp = await service.listLedgerEntries({
          type: 'WP',
          customer_id: 'cus_k',
        });
        expect(wp).toHaveLength(1);
        expect(wp[0].ref_id).toBe(res.pull_id);
        expect(Number(wp[0].wallet_delta)).toBe(0);
        expect(wp[0].payload).toMatchObject({
          period: `luckydraw:${prize.id}`,
          sku: 'ld-card',
        });
      });

      it('an untracked or failed stock take leaves the pull unflagged and the prize still drawn', async () => {
        await createCard('ld-untracked');
        await createCard('ld-broken');
        const untracked = await committedPrize({
          kind: 'card',
          card_handle: 'ld-untracked',
          credit_myr: null,
        });
        const broken = await committedPrize({
          kind: 'card',
          card_handle: 'ld-broken',
          credit_myr: null,
        });
        await fund('cus_u', 100);
        await enter('cus_u', untracked.id, 5);
        await enter('cus_u', broken.id, 5);

        expect(
          await service.drawDueLuckyDrawPrizes({
            now: after(untracked),
            decrementStock: async (handle) => {
              if (handle === 'ld-broken') throw new Error('inventory down');
              return false;
            },
          }),
        ).toEqual({ drawn: 2, failed: 0 });

        const pulls = await service.listPulls({ customer_id: 'cus_u' });
        expect(pulls.map((p) => [p.card_id, p.stock_earmarked]).sort()).toEqual(
          [
            ['ld-broken', false],
            ['ld-untracked', false],
          ],
        );
      });

      it('a card prize whose Card row is gone still writes the result, with no pull, flagged for the job', async () => {
        const prize = await committedPrize({
          kind: 'card',
          card_handle: 'ld-gone',
          credit_myr: null,
        });
        await fund('cus_g', 100);
        await enter('cus_g', prize.id, 5);
        const outcomes: LuckyDrawOutcome[] = [];
        const takes: string[] = [];

        expect(
          await service.drawDueLuckyDrawPrizes({
            now: after(prize),
            decrementStock: async (handle) => {
              takes.push(handle);
              return true;
            },
            onDrawn: async (o) => {
              outcomes.push(o);
            },
          }),
        ).toEqual({ drawn: 1, failed: 0 });

        expect(await resultOf(prize.id)).toMatchObject({
          winner_customer_id: 'cus_g',
          pull_id: null,
        });
        expect(outcomes).toEqual([
          {
            prizeId: prize.id,
            winnerId: 'cus_g',
            kind: 'card',
            cardHandle: 'ld-gone',
            pullId: null,
          },
        ]);
        expect(await service.listPulls({ customer_id: 'cus_g' })).toHaveLength(
          0,
        );
        expect(takes).toEqual([]);
        expect(
          await service.listLedgerEntries({ type: 'WP', customer_id: 'cus_g' }),
        ).toHaveLength(0);
      });

      it('an entry accepted before draw_at counts even though its row is written after draw_at', async () => {
        // draw_at is an hour in the REAL past; enter with now = draw_at - 1s,
        // so the gate accepts while created_at (real clock) lands after it.
        const drawAt = new Date(Date.now() - HOUR);
        const prize = await committedPrize(
          { draw_at: drawAt },
          { starts_at: new Date(Date.now() - 3 * HOUR) },
        );
        await fund('cus_late', 10);
        expect(
          await service.enterLuckyDraw({
            customerId: 'cus_late',
            prizeId: prize.id,
            tickets: 5,
            now: new Date(drawAt.getTime() - 1000),
          }),
        ).toMatchObject({ entered: true });

        expect(
          await service.drawDueLuckyDrawPrizes({ now: new Date() }),
        ).toEqual({ drawn: 1, failed: 0 });
        const res = await resultOf(prize.id);
        expect(res.entries).toContainEqual({
          customer_id: 'cus_late',
          tickets: 5,
        });
        expect(res.winner_customer_id).toBe('cus_late');
      });

      it('an enter after the result exists is refused as closed and spends nothing', async () => {
        const prize = await committedPrize();
        await service.drawDueLuckyDrawPrizes({ now: after(prize) });
        expect(await resultOf(prize.id)).toBeDefined();
        await fund('cus_af', 100);

        expect(
          await service.enterLuckyDraw({
            customerId: 'cus_af',
            prizeId: prize.id,
            tickets: 1,
            now: new Date(new Date(prize.draw_at).getTime() - 1000),
          }),
        ).toEqual({ entered: false, reason: 'closed' });
        expect(await service.luckyDrawBalance('cus_af')).toBe(100);
      });

      it('no entries → result with null winner, nothing paid, not drawn again', async () => {
        const prize = await committedPrize();
        const outcomes: LuckyDrawOutcome[] = [];

        expect(
          await service.drawDueLuckyDrawPrizes({
            now: after(prize),
            onDrawn: async (o) => {
              outcomes.push(o);
            },
          }),
        ).toEqual({ drawn: 1, failed: 0 });

        const res = await resultOf(prize.id);
        expect(res).toMatchObject({
          winner_customer_id: null,
          winner_tickets: 0,
          total_tickets: 0,
          entrant_count: 0,
          ticket_index: null,
          seed: deriveDrawSeed(secret(), prize.seed_nonce!),
          credit_transaction_id: null,
          pull_id: null,
        });
        expect(res.entries).toEqual([]);
        expect(res.excluded).toEqual([]);
        expect(outcomes).toEqual([
          {
            prizeId: prize.id,
            winnerId: null,
            kind: 'credit',
            cardHandle: null,
            pullId: null,
          },
        ]);
        expect(
          await service.listCreditTransactions({ reason: 'reward_credit' }),
        ).toHaveLength(0);
        expect(
          await service.drawDueLuckyDrawPrizes({ now: after(prize) }),
        ).toEqual({ drawn: 0, failed: 0 });
      });

      it('the admin overview flags a drawn prize whose winner got nothing', async () => {
        await createCard('gr-card');
        const credit = await committedPrize();
        const card = await committedPrize({
          kind: 'card',
          card_handle: 'gr-card',
          credit_myr: null,
        });
        const gone = await committedPrize({
          kind: 'card',
          card_handle: 'gr-gone',
          credit_myr: null,
        });
        const empty = await committedPrize();
        await fund('cus_gr', 100);
        for (const p of [credit, card, gone]) await enter('cus_gr', p.id, 5);

        expect(
          // `empty` was made last, so it draws last.
          await service.drawDueLuckyDrawPrizes({ now: after(empty) }),
        ).toEqual({ drawn: 4, failed: 0 });

        const grantedOf = new Map(
          (await service.adminLuckyDrawOverview())
            .flatMap((e) => e.prizes)
            .map((p) => [p.id, p.result?.granted]),
        );
        expect(grantedOf.get(credit.id)).toBe(true);
        expect(grantedOf.get(card.id)).toBe(true);
        // A winner with no pull minted (the Card row was gone) is owed a prize.
        expect(grantedOf.get(gone.id)).toBe(false);
        // Nobody entered: nothing is owed.
        expect(grantedOf.get(empty.id)).toBe(true);
      });

      it('disabled entrants are excluded and refunded; all-disabled → null winner', async () => {
        const prize = await committedPrize();
        await fund('cus_x1', 100);
        await fund('cus_x2', 100);
        await enter('cus_x1', prize.id, 10);
        await enter('cus_x1', prize.id, 20);
        await enter('cus_x2', prize.id, 15);
        const lonely = await committedPrize();
        await fund('cus_x3', 100);
        await enter('cus_x3', lonely.id, 40);
        await service.createCustomerAccountStates([
          { customer_id: 'cus_x1', disabled: true },
          { customer_id: 'cus_x3', disabled: true },
        ]);

        expect(
          await service.drawDueLuckyDrawPrizes({ now: after(prize) }),
        ).toEqual({ drawn: 2, failed: 0 });

        const res = await resultOf(prize.id);
        expect(res).toMatchObject({
          winner_customer_id: 'cus_x2',
          winner_tickets: 15,
          total_tickets: 15,
          entrant_count: 1,
        });
        expect(res.entries).toEqual([{ customer_id: 'cus_x2', tickets: 15 }]);
        expect(res.excluded).toEqual(['cus_x1']);
        expect(await service.luckyDrawBalance('cus_x1')).toBe(100);
        expect(await rewardCredits('cus_x2')).toHaveLength(1);

        const none = await resultOf(lonely.id);
        expect(none).toMatchObject({
          winner_customer_id: null,
          total_tickets: 0,
          entrant_count: 0,
          credit_transaction_id: null,
        });
        expect(none.entries).toEqual([]);
        expect(none.excluded).toEqual(['cus_x3']);
        expect(await service.luckyDrawBalance('cus_x3')).toBe(100);
        expect(await rewardCredits('cus_x3')).toHaveLength(0);

        // Same ref as a cancel refund: a prize is either drawn or cancelled.
        const refunds = await service.listLuckyDrawTickets({
          reason: 'refund',
        });
        expect(refunds.map((t) => [t.ref, t.delta])).toHaveLength(2);
        expect(refunds.map((t) => [t.ref, t.delta])).toEqual(
          expect.arrayContaining([
            [`${lonely.id}:cus_x3`, 40],
            [`${prize.id}:cus_x1`, 30],
          ]),
        );
      });

      it('a prize not yet due, cancelled, or on a draft or cancelled event is not drawn', async () => {
        const past = new Date(Date.now() - 1000);
        const notDue = await committedPrize();
        const cancelled = await committedPrize({
          draw_at: past,
          cancelled_at: new Date(),
        });
        const draft = await committedPrize(
          { draw_at: past },
          { status: 'draft' },
        );
        const cancelledEvent = await committedPrize(
          { draw_at: past },
          { status: 'cancelled' },
        );
        const now = new Date();

        expect(await service.drawDueLuckyDrawPrizes({ now })).toEqual({
          drawn: 0,
          failed: 0,
        });
        // The re-check under the lock is the real guard, not the list.
        for (const p of [notDue, cancelled, draft, cancelledEvent]) {
          expect(
            await service.drawLuckyDrawPrize({ prizeId: p.id, now }),
          ).toBeNull();
        }
        expect(
          await service.drawLuckyDrawPrize({ prizeId: 'ldpz_missing', now }),
        ).toBeNull();
        expect(await service.listLuckyDrawResults({})).toHaveLength(0);
      });

      it('refuses to draw (failed: 1, no result) when the secret no longer matches the published hash', async () => {
        const prize = await committedPrize();
        await fund('cus_sc', 100);
        await enter('cus_sc', prize.id, 10);

        const saved = process.env.LUCKY_DRAW_SEED_SECRET;
        try {
          process.env.LUCKY_DRAW_SEED_SECRET = 'a-rotated-secret';
          expect(
            await service.drawDueLuckyDrawPrizes({ now: after(prize) }),
          ).toEqual({ drawn: 0, failed: 1 });
          await expect(
            service.drawLuckyDrawPrize({
              prizeId: prize.id,
              now: after(prize),
            }),
          ).rejects.toThrow('LUCKY_DRAW_SEED_SECRET changed since publish');

          delete process.env.LUCKY_DRAW_SEED_SECRET;
          expect(
            await service.drawDueLuckyDrawPrizes({ now: after(prize) }),
          ).toEqual({ drawn: 0, failed: 1 });
        } finally {
          process.env.LUCKY_DRAW_SEED_SECRET = saved;
        }
        expect(await resultOf(prize.id)).toBeUndefined();
        expect(await rewardCredits('cus_sc')).toHaveLength(0);

        // The original secret back: the next tick draws it.
        expect(
          await service.drawDueLuckyDrawPrizes({ now: after(prize) }),
        ).toEqual({ drawn: 1, failed: 0 });
      });

      it('refuses a committed-less prize on a published event loudly', async () => {
        const prize = await makePrize((await makeEvent()).id, {
          draw_at: new Date(Date.now() - 1000),
        });
        expect(
          await service.drawDueLuckyDrawPrizes({ now: new Date() }),
        ).toEqual({ drawn: 0, failed: 1 });
        expect(await resultOf(prize.id)).toBeUndefined();
      });

      it('a prize that throws does not stop the tick; the next prize still draws and pays', async () => {
        const past = new Date(Date.now() - 1000);
        // No commitment: drawLuckyDrawPrize throws for this one. It draws
        // first (earlier draw_at), so the good prize comes after the throw.
        const broken = await makePrize((await makeEvent()).id, {
          draw_at: new Date(past.getTime() - 1000),
        });
        const good = await committedPrize({ draw_at: past });
        await fund('cus_ok', 100);
        await service.createLuckyDrawEntries([
          { prize_id: good.id, customer_id: 'cus_ok', tickets: 10 },
        ]);

        expect(
          await service.drawDueLuckyDrawPrizes({ now: new Date() }),
        ).toEqual({ drawn: 1, failed: 1 });

        expect(await resultOf(broken.id)).toBeUndefined();
        const res = await resultOf(good.id);
        expect(res).toMatchObject({ winner_customer_id: 'cus_ok' });
        const credits = await rewardCredits('cus_ok');
        expect(credits).toHaveLength(1);
        expect(credits[0].id).toBe(res.credit_transaction_id);
      });

      it('the draw waits for an in-flight entry and includes it', async () => {
        const prize = await committedPrize();
        await fund('cus_fl', 100);
        // An entry that has taken the SHARED prize lock but not yet committed.
        const entering = await holdLock(
          'pg_advisory_xact_lock_shared',
          `luckydraw:${prize.id}`,
        );
        let released = false;
        try {
          await entering.tx.execute(
            'INSERT INTO lucky_draw_entry (id, prize_id, customer_id, tickets, created_at, updated_at) ' +
              "VALUES ('lden_fl', ?, 'cus_fl', 25, now(), now())",
            [prize.id],
          );
          await entering.tx.execute(
            'INSERT INTO lucky_draw_ticket (id, customer_id, delta, reason, ref, created_at, updated_at) ' +
              "VALUES ('ldtk_fl', 'cus_fl', -25, 'entry', 'lden_fl', now(), now())",
          );
          const drawing = service.drawDueLuckyDrawPrizes({ now: after(prize) });
          // The exclusive lock cannot be had while the entry is in flight.
          expect(await settledWithin(drawing, 750)).toBe(false);

          await entering.release();
          released = true;
          expect(await drawing).toEqual({ drawn: 1, failed: 0 });
          const res = await resultOf(prize.id);
          expect(res).toMatchObject({
            winner_customer_id: 'cus_fl',
            total_tickets: 25,
            entrant_count: 1,
          });
          expect(res.entries).toEqual([{ customer_id: 'cus_fl', tickets: 25 }]);
        } finally {
          if (!released) await entering.tx.rollback();
        }
      });
    });
  },
});
