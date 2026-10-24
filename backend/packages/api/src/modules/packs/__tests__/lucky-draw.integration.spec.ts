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
import {
  MAX_PRIZE_CREDIT_MYR,
  deriveDrawSeed,
  drawSeedHash,
} from '../lucky-draw';
import { clearFxDisplayCache } from '../pricing';
import LuckyDrawEvent from '../models/lucky-draw-event';
import LuckyDrawPrize from '../models/lucky-draw-prize';
import LuckyDrawEntry from '../models/lucky-draw-entry';
import LuckyDrawTicket from '../models/lucky-draw-ticket';
import LuckyDrawResult from '../models/lucky-draw-result';
import CreditTransaction from '../models/credit-transaction';
import CustomerAccountState from '../models/customer-account-state';
import AdminActionAudit from '../models/admin-action-audit';
import Card from '../models/card';
import FxRate from '../models/fx-rate';

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
    Card,
    FxRate,
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
          // a credit prize needs a picture
          saveCreditPrize(eventId, { imageUrl: null }),
          saveCreditPrize(eventId, { imageUrl: '  ' }),
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
        const credit = await saveCreditPrize(eventId, {
          creditMyr: MAX_PRIZE_CREDIT_MYR,
        });
        const card = await saveCardPrize(eventId, 'c-ok', { imageUrl: null });
        const [event] = await service.listLuckyDrawEvents({ id: eventId });

        const c = await prizeRow(credit.id);
        expect(Number(c.credit_myr)).toBe(MAX_PRIZE_CREDIT_MYR);
        expect(c).toMatchObject({ kind: 'credit', card_handle: null });
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
        const { id: eventId } = await saveEvent({ startsAt, endsAt });
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

      it('publish gives every prize a seed hash and moves the event to published', async () => {
        const { id: eventId } = await saveEvent();
        await makeCard('c-pub');
        const a = await saveCreditPrize(eventId);
        const b = await saveCardPrize(eventId, 'c-pub');

        await publish(eventId);

        expect(
          (await service.listLuckyDrawEvents({ id: eventId }))[0].status,
        ).toBe('published');
        const secret = process.env.LUCKY_DRAW_SEED_SECRET!;
        const nonces = new Set<string>();
        for (const { id } of [a, b]) {
          const row = await prizeRow(id);
          expect(row.seed_nonce).toMatch(/^[0-9a-f]{64}$/);
          // The commitment verifies against the derived seed...
          expect(row.seed_hash).toBe(
            drawSeedHash(deriveDrawSeed(secret, row.seed_nonce!)),
          );
          // ...and the row holds no seed, only the nonce and the hash.
          expect(row).not.toHaveProperty('seed');
          nonces.add(row.seed_nonce!);
        }
        expect(nonces.size).toBe(2);

        const audits = await service.listAdminActionAudits({
          entity_type: 'lucky_draw_event',
          entity_id: eventId,
        });
        const published = audits.find((x) => x.action === 'publish')!;
        expect(published).toBeDefined();
        // The audit trail never carries a seed either.
        for (const { id } of [a, b]) {
          const row = await prizeRow(id);
          expect(JSON.stringify(published)).not.toContain(
            deriveDrawSeed(secret, row.seed_nonce!),
          );
        }
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

      it('refuses publishing when a prize draw time fell outside an edited window', async () => {
        const { id: eventId } = await saveEvent();
        const { id } = await saveCreditPrize(eventId); // draws at the old end
        await saveEvent({
          id: eventId,
          endsAt: new Date(Date.now() + 2 * HOUR),
        });
        await rejectsWith(publish(eventId), MedusaError.Types.INVALID_DATA);
        expect((await prizeRow(id)).seed_hash).toBeNull();
      });

      it('refuses to publish, or add a prize to a published event, without the seed secret', async () => {
        const { id: eventId } = await saveEvent();
        await saveCreditPrize(eventId);
        const { id: liveId } = await saveEvent();
        await saveCreditPrize(liveId);
        await publish(liveId);

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
        ).toHaveLength(1);
      });

      it('a published prize keeps kind, card, credit and draw time; title/image/sort still save', async () => {
        const { id: eventId } = await saveEvent();
        await makeCard('c-keep');
        await makeCard('c-other');
        const credit = await saveCreditPrize(eventId);
        const card = await saveCardPrize(eventId, 'c-keep');
        await publish(eventId);
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
        const { id: eventId } = await saveEvent();
        await saveCreditPrize(eventId);
        await publish(eventId);

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
        const prize = await livePrize();
        await fund('cus_rd', 100);
        await service.enterLuckyDraw({
          customerId: 'cus_rd',
          prizeId: prize.id,
          tickets: 10,
        });
        // The draw job (a later task) writes this row; stand in for it.
        await service.createLuckyDrawResults([
          {
            prize_id: prize.id,
            winner_customer_id: 'cus_rd',
            winner_tickets: 10,
            total_tickets: 10,
            entrant_count: 1,
            seed: 'f'.repeat(64),
            // The draw job stores arrays; the generated type says Record.
            entries: [
              { customer_id: 'cus_rd', tickets: 10 },
            ] as unknown as Record<string, unknown>,
            excluded: [] as unknown as Record<string, unknown>,
            drawn_at: new Date(),
          },
        ]);

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
        const { id: eventId } = await saveEvent();
        const { id: prizeId } = await saveCreditPrize(eventId);
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
        const { id: eventId } = await service.saveLuckyDrawEvent({
          name: 'Overview Draw',
          startsAt: new Date(Date.now() - HOUR),
          endsAt: new Date(Date.now() + 48 * HOUR),
          ...admin,
        });
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
        await service.publishLuckyDrawEvent({ id: eventId, ...admin });
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
  },
});
