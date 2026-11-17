import { MedusaError } from '@medusajs/framework/utils';
import {
  cancelLuckyDrawPrize,
  drawDueLuckyDrawEvents,
  drawLuckyDrawEvent,
  publishLuckyDrawEvent,
  withdrawLuckyDrawEvent,
  type LuckyDrawPort,
} from '../lucky-draw-operations';
import { commitDrawSeed } from '../lucky-draw';

// Lucky Draw runs on a narrow port, so draw / publish / cancel are testable
// with an in-memory fake: no PacksModuleService, no database. The SQL the
// operations still run themselves (advisory locks, the due list) goes to a
// recording `execute`, which also pins every lock key and its order.

type Row = Record<string, unknown> & { id: string };
type Filter = Record<string, unknown>;

const matches = (row: Row, filter: Filter) =>
  Object.entries(filter).every(([k, v]) =>
    Array.isArray(v) ? v.includes(row[k]) : row[k] === v,
  );

function table(prefix: string) {
  const rows: Row[] = [];
  let n = 0;
  return {
    rows,
    list: jest.fn(
      async (
        filter: Filter = {},
        opts: { skip?: number; take?: number } = {},
      ) => {
        const hit = rows.filter((r) => matches(r, filter));
        const skip = opts.skip ?? 0;
        return hit.slice(
          skip,
          opts.take === undefined ? undefined : skip + opts.take,
        );
      },
    ),
    create: jest.fn(async (data: Record<string, unknown>[]) =>
      data.map((d) => {
        const row = { id: `${prefix}_${++n}`, ...d } as Row;
        rows.push(row);
        return row;
      }),
    ),
    update: jest.fn(async (arg: unknown) => {
      const apply = (sel: Filter, data: Record<string, unknown>) =>
        rows
          .filter((r) => matches(r, sel))
          .forEach((r) => Object.assign(r, data));
      if (Array.isArray(arg)) {
        for (const { id, ...data } of arg as Row[]) apply({ id }, data);
      } else if ((arg as { selector?: Filter }).selector) {
        const { selector, data } = arg as { selector: Filter; data: Filter };
        apply(selector, data);
      } else {
        const { id, ...data } = arg as Row;
        apply({ id }, data);
      }
      return [];
    }),
  };
}

function fakePort(opts: { disabled?: string[] } = {}) {
  const t = {
    events: table('lde'),
    prizes: table('ldp'),
    entries: table('ldn'),
    tickets: table('ldt'),
    results: table('ldr'),
    eventResults: table('lder'),
  };
  const audits: Record<string, unknown>[] = [];
  const credits: Record<string, unknown>[] = [];
  const port = {
    listLuckyDrawEvents: t.events.list,
    createLuckyDrawEvents: t.events.create,
    updateLuckyDrawEvents: t.events.update,
    listLuckyDrawPrizes: t.prizes.list,
    createLuckyDrawPrizes: t.prizes.create,
    updateLuckyDrawPrizes: t.prizes.update,
    listLuckyDrawEntries: t.entries.list,
    createLuckyDrawEntries: t.entries.create,
    listLuckyDrawTickets: t.tickets.list,
    createLuckyDrawTickets: t.tickets.create,
    listLuckyDrawResults: t.results.list,
    createLuckyDrawResults: t.results.create,
    listLuckyDrawEventResults: t.eventResults.list,
    createLuckyDrawEventResults: t.eventResults.create,
    listCards: jest.fn(async () => []),
    listFxRates: jest.fn(async () => []),
    createPulls: jest.fn(async () => {
      throw new Error('no card prize in these specs');
    }),
    updatePulls: jest.fn(async () => []),
    mutateCreditAtomic: jest.fn(async (input: Record<string, unknown>) => {
      credits.push(input);
      return { id: `ct_${credits.length}` };
    }),
    recordLedgerEntry: jest.fn(async () => undefined),
    audit: jest.fn(async (row: Record<string, unknown>) => {
      audits.push(row);
    }),
    assertNotFrozen: jest.fn(async () => undefined),
    mayPlay: jest.fn(async () => null),
    assertMayReceive: jest.fn(async () => undefined),
    disabledCustomerIds: jest.fn(
      async (ids: string[]) =>
        new Set(ids.filter((id) => opts.disabled?.includes(id))),
    ),
    drawLuckyDrawPrize: jest.fn(async () => null),
    drawLuckyDrawEvent: jest.fn(async () => null),
  };
  const sql: { text: string; params: unknown[] }[] = [];
  const em = {
    execute: jest.fn(async (text: string, params: unknown[] = []) => {
      sql.push({ text, params });
      return [];
    }),
  };
  const ctx = { transactionManager: em, manager: em } as never;
  // Only the advisory-lock keys, in the order they were taken.
  const locks = () =>
    sql
      .filter((q) => q.text.includes('pg_advisory_xact_lock'))
      .map((q) => q.params[0]);
  return {
    t,
    audits,
    credits,
    port: port as unknown as LuckyDrawPort & typeof port,
    em,
    ctx,
    locks,
  };
}

const HOUR = 60 * 60 * 1000;
const now = new Date('2026-11-17T12:00:00Z');
const at = (ms: number) => new Date(now.getTime() + ms);

beforeAll(() => {
  process.env.LUCKY_DRAW_SEED_SECRET = 'unit-spec-secret';
});

describe('Lucky Draw through its port', () => {
  it('publish commits a seed, moves every prize to the end and audits the hash', async () => {
    const f = fakePort();
    const [event] = await f.t.events.create([
      {
        name: 'Gate',
        status: 'draft',
        draw_mode: 'one_winner',
        starts_at: at(HOUR),
        ends_at: at(2 * HOUR),
      },
    ]);
    const [prize] = await f.t.prizes.create([
      { event_id: event.id, kind: 'credit', credit_myr: 5, draw_at: at(HOUR) },
    ]);

    await publishLuckyDrawEvent(
      f.port,
      { id: event.id, adminId: 'adm_1', reason: 'go', now },
      f.ctx,
    );

    expect(f.locks()).toEqual([`luckydrawevent:${event.id}`]);
    expect(event).toMatchObject({
      status: 'published',
      draw_mode: 'one_winner',
    });
    expect(event.seed_hash).toEqual(expect.any(String));
    expect(event.seed_nonce).toEqual(expect.any(String));
    expect(prize.draw_at).toEqual(at(2 * HOUR));
    expect(f.audits).toEqual([
      expect.objectContaining({
        action: 'publish',
        entity_id: event.id,
        after: expect.objectContaining({
          seed_hash: event.seed_hash,
          prizes: [prize.id],
        }),
      }),
    ]);
    // The nonce never reaches the audit row.
    expect(JSON.stringify(f.audits)).not.toContain(String(event.seed_nonce));
  });

  it('publish refuses an event with no live prize, writing nothing', async () => {
    const f = fakePort();
    const [event] = await f.t.events.create([
      {
        status: 'draft',
        draw_mode: 'one_winner',
        starts_at: at(HOUR),
        ends_at: at(2 * HOUR),
      },
    ]);
    await expect(
      publishLuckyDrawEvent(
        f.port,
        { id: event.id, adminId: 'a', reason: 'r', now },
        f.ctx,
      ),
    ).rejects.toMatchObject({ type: MedusaError.Types.NOT_ALLOWED });
    expect(f.t.events.update).not.toHaveBeenCalled();
    expect(f.audits).toHaveLength(0);
  });

  it('cancel takes prize then event then gate lock and refunds all but the disabled', async () => {
    const f = fakePort({ disabled: ['cus_off'] });
    const [event] = await f.t.events.create([
      {
        status: 'published',
        draw_mode: 'one_winner',
        starts_at: at(HOUR),
        ends_at: at(2 * HOUR),
      },
    ]);
    const [prize, other] = await f.t.prizes.create([
      { event_id: event.id, kind: 'credit', credit_myr: 5 },
      { event_id: event.id, kind: 'credit', credit_myr: 1 },
    ]);
    await f.t.entries.create([
      { prize_id: prize.id, customer_id: 'cus_a', tickets: 3 },
      { prize_id: prize.id, customer_id: 'cus_a', tickets: 2 },
      { prize_id: prize.id, customer_id: 'cus_off', tickets: 7 },
    ]);

    const out = await cancelLuckyDrawPrize(
      f.port,
      { id: prize.id, adminId: 'adm_1', reason: 'oops', now },
      f.ctx,
    );

    expect(out).toEqual({ refunded: 1 });
    expect(f.locks()).toEqual([
      `luckydraw:${prize.id}`,
      `luckydrawevent:${event.id}`,
      `luckydraw:${event.id}`,
    ]);
    expect(prize.cancelled_at).toBeInstanceOf(Date);
    expect(other.cancelled_at).toBeUndefined();
    expect(f.t.tickets.rows).toEqual([
      expect.objectContaining({
        customer_id: 'cus_a',
        delta: 5,
        reason: 'refund',
        ref: `${prize.id}:cus_a`,
      }),
    ]);
    expect(f.audits[0]).toMatchObject({
      action: 'disable',
      after: expect.objectContaining({ refunded: 1, tickets_refunded: 5 }),
    });
  });

  it('cancel refuses the last prize of a published event', async () => {
    const f = fakePort();
    const [event] = await f.t.events.create([
      {
        status: 'published',
        draw_mode: 'one_winner',
        starts_at: at(HOUR),
        ends_at: at(2 * HOUR),
      },
    ]);
    const [prize] = await f.t.prizes.create([
      { event_id: event.id, kind: 'credit', credit_myr: 5 },
    ]);
    await expect(
      cancelLuckyDrawPrize(
        f.port,
        { id: prize.id, adminId: 'a', reason: 'r', now },
        f.ctx,
      ),
    ).rejects.toThrow(/keeps at least one prize/);
    expect(f.t.prizes.update).not.toHaveBeenCalled();
    expect(f.t.tickets.rows).toHaveLength(0);
  });

  it('withdraw takes the event lock then the gate lock and refunds the gate', async () => {
    const f = fakePort();
    const [event] = await f.t.events.create([
      {
        status: 'published',
        draw_mode: 'one_winner',
        starts_at: at(-HOUR),
        ends_at: at(HOUR),
      },
    ]);
    const [prize] = await f.t.prizes.create([
      { event_id: event.id, kind: 'credit', credit_myr: 5 },
    ]);
    await f.t.entries.create([
      { event_id: event.id, customer_id: 'cus_a', tickets: 4 },
    ]);

    expect(
      await withdrawLuckyDrawEvent(
        f.port,
        { id: event.id, adminId: 'a', reason: 'r' },
        f.ctx,
      ),
    ).toEqual({ refunded: 1 });
    expect(f.locks()).toEqual([
      `luckydrawevent:${event.id}`,
      `luckydraw:${event.id}`,
    ]);
    expect(event.status).toBe('cancelled');
    expect(prize.cancelled_at).toBeInstanceOf(Date);
    expect(f.t.tickets.rows).toEqual([
      expect.objectContaining({
        delta: 4,
        reason: 'refund',
        ref: `${event.id}:cus_a`,
      }),
    ]);
  });

  describe('drawing a one_winner event', () => {
    const ended = async (f: ReturnType<typeof fakePort>) => {
      const [event] = await f.t.events.create([
        {
          status: 'published',
          draw_mode: 'one_winner',
          starts_at: at(-2 * HOUR),
          ends_at: at(-HOUR),
          ...commitDrawSeed('unit-spec-secret'),
        },
      ]);
      const [prize] = await f.t.prizes.create([
        { event_id: event.id, kind: 'credit', credit_myr: 25, sort: 1 },
      ]);
      return { event, prize };
    };

    it('pays the one live entrant through credit posting and writes both results', async () => {
      const f = fakePort({ disabled: ['cus_off'] });
      const { event, prize } = await ended(f);
      await f.t.entries.create([
        { event_id: event.id, customer_id: 'cus_win', tickets: 3 },
        { event_id: event.id, customer_id: 'cus_off', tickets: 9 },
      ]);

      const outcomes = await drawLuckyDrawEvent(
        f.port,
        { eventId: event.id, now },
        f.ctx,
      );

      expect(f.locks()).toEqual([`luckydraw:${event.id}`]);
      expect(outcomes).toEqual([
        {
          prizeId: prize.id,
          winnerId: 'cus_win',
          kind: 'credit',
          cardHandle: null,
          pullId: null,
        },
      ]);
      expect(f.credits).toEqual([
        expect.objectContaining({
          customerId: 'cus_win',
          amount: 25,
          reason: 'reward_credit',
          idempotencyReference: `luckydraw:${prize.id}`,
        }),
      ]);
      expect(f.t.eventResults.rows).toEqual([
        expect.objectContaining({
          event_id: event.id,
          winner_customer_id: 'cus_win',
          total_tickets: 3,
          entrant_count: 1,
          excluded: ['cus_off'],
        }),
      ]);
      expect(f.t.results.rows).toEqual([
        expect.objectContaining({
          prize_id: prize.id,
          credit_transaction_id: 'ct_1',
        }),
      ]);
    });

    it('does nothing before the end, and nothing twice', async () => {
      const f = fakePort();
      const { event } = await ended(f);
      expect(
        await drawLuckyDrawEvent(
          f.port,
          { eventId: event.id, now: at(-3 * HOUR) },
          f.ctx,
        ),
      ).toBeNull();
      await drawLuckyDrawEvent(f.port, { eventId: event.id, now }, f.ctx);
      expect(
        await drawLuckyDrawEvent(f.port, { eventId: event.id, now }, f.ctx),
      ).toBeNull();
      expect(f.t.eventResults.rows).toHaveLength(1);
    });

    it('refuses a seed secret that changed since publish, paying nothing', async () => {
      const f = fakePort();
      const { event } = await ended(f);
      event.seed_hash = 'not-the-published-hash';
      await expect(
        drawLuckyDrawEvent(f.port, { eventId: event.id, now }, f.ctx),
      ).rejects.toThrow(/LUCKY_DRAW_SEED_SECRET changed/);
      expect(f.credits).toHaveLength(0);
      expect(f.t.eventResults.rows).toHaveLength(0);
    });
  });

  it('the job draws each due event through the port with no context (its own transaction)', async () => {
    const f = fakePort();
    f.em.execute.mockResolvedValueOnce([
      { id: 'lde_a' },
      { id: 'lde_b' },
    ] as never);
    f.port.drawLuckyDrawEvent
      .mockRejectedValueOnce(new Error('boom') as never)
      .mockResolvedValueOnce([] as never);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await drawDueLuckyDrawEvents(f.port, { now }, f.ctx)).toEqual({
        drawn: 1,
        failed: 1,
      });
    } finally {
      warn.mockRestore();
    }
    expect(f.port.drawLuckyDrawEvent.mock.calls).toEqual([
      [{ eventId: 'lde_a', now }],
      [{ eventId: 'lde_b', now }],
    ]);
  });
});
