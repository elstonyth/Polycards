/**
 * The one-winner fields on the Lucky Draw payloads. Every new field is optional
 * so either side can deploy first: a card-era payload must still parse, and one
 * drifted new field must not blank the page (`event` is one nested object, not
 * a row that can drop alone).
 */
import { describe, expect, it } from 'vitest';
import {
  LuckyDrawEventDetailSchema,
  LuckyDrawEventResultSchema,
  LuckyDrawMineSchema,
  LuckyDrawPageSchema,
  LuckyDrawResultDetailSchema,
  LuckyDrawResultsSchema,
  NextEventSchema,
} from '@/lib/data/schemas';

const person = {
  who: 'Collector8011',
  face_seed: 7,
  avatar_url: null,
  frame_url: null,
};

const oldEvent = {
  id: 'ldev_1',
  name: 'November Lucky Draw',
  starts_at: '2026-11-01T00:00:00.000Z',
  ends_at: '2026-11-30T15:59:00.000Z',
};

const prize = (over: Record<string, unknown> = {}) => ({
  id: 'ldpz_1',
  kind: 'card',
  title: 'PSA 10 Charizard',
  image: '/images/x.webp',
  value_myr: 1200,
  draw_at: oldEvent.ends_at,
  seed_hash: 'a'.repeat(64),
  total_tickets: 0,
  entrant_count: 0,
  my_tickets: 0,
  top: [],
  result: null,
  ...over,
});

const eventResult = {
  winner: person,
  winner_tickets: 40,
  total_tickets: 100,
  entrant_count: 3,
  seed: 'c'.repeat(64),
  seed_hash: 'd'.repeat(64),
  drawn_at: '2026-11-30T16:00:00.000Z',
};

const newEvent = {
  ...oldEvent,
  draw_mode: 'one_winner',
  seed_hash: 'd'.repeat(64),
  total_tickets: 100,
  entrant_count: 3,
  top: [{ person, tickets: 60 }],
  my_tickets: 40,
  result: null,
};

const page = (event: unknown, extra: Record<string, unknown> = {}) => ({
  balance: 40,
  event,
  prizes: [prize()],
  ...extra,
});

describe('LuckyDrawPageSchema, one-winner fields', () => {
  it('reads a card-era payload as a per-prize event with nothing new', () => {
    const r = LuckyDrawPageSchema.parse(page(oldEvent));
    expect(r.event).toMatchObject({
      draw_mode: 'per_prize',
      total_tickets: 0,
      entrant_count: 0,
      my_tickets: 0,
      top: [],
      result: null,
    });
    expect(r.next_event).toBeNull();
    expect(r.prizes).toHaveLength(1);
  });

  it('reads a new payload, people turned into avatars', () => {
    const r = LuckyDrawPageSchema.parse(
      page(newEvent, {
        next_event: { name: 'December', starts_at: '2026-12-01T00:00:00.000Z' },
      }),
    );
    expect(r.event).toMatchObject({
      draw_mode: 'one_winner',
      total_tickets: 100,
      entrant_count: 3,
      my_tickets: 40,
    });
    expect(r.event?.top[0]?.person).toEqual({
      who: 'Collector8011',
      avatar: '/images/pfps/pfp-8.webp',
      frame: null,
    });
    // An older backend names the next pool only: nothing to show, nothing lost.
    expect(r.next_event).toEqual({
      name: 'December',
      starts_at: '2026-12-01T00:00:00.000Z',
      prizes: [],
    });
  });

  it('reads the next pool with its dates and every prize, dropping a bad row', () => {
    const r = LuckyDrawPageSchema.parse(
      page(null, {
        prizes: [],
        next_event: {
          name: 'December',
          starts_at: '2026-12-01T00:00:00.000Z',
          ends_at: '2026-12-31T00:00:00.000Z',
          prizes: [
            { kind: 'card', title: 'Mew', image: '/a.webp', value_myr: 900 },
            { kind: 'credit', title: 'RM 50', image: null, value_myr: 50 },
            { kind: 'card', title: 7 },
          ],
        },
      }),
    );
    expect(r.next_event?.ends_at).toBe('2026-12-31T00:00:00.000Z');
    expect(r.next_event?.prizes.map((p) => p.title)).toEqual(['Mew', 'RM 50']);
  });

  it('reads no event with a next one coming', () => {
    const r = LuckyDrawPageSchema.parse(
      page(null, {
        prizes: [],
        next_event: { name: 'December', starts_at: '2026-12-01T00:00:00.000Z' },
      }),
    );
    expect(r.event).toBeNull();
    expect(r.next_event?.name).toBe('December');
  });

  it('reads a drawn event with its winner, and with no entries', () => {
    const won = LuckyDrawPageSchema.parse(
      page({ ...newEvent, result: eventResult }),
    );
    expect(won.event?.result?.winner?.who).toBe('Collector8011');
    expect(won.event?.result?.seed).toBe(eventResult.seed);
    const empty = LuckyDrawPageSchema.parse(
      page({
        ...newEvent,
        result: { ...eventResult, winner: null, total_tickets: 0 },
      }),
    );
    expect(empty.event?.result).not.toBeNull();
    expect(empty.event?.result?.winner).toBeNull();
  });

  it('never blanks the page over one drifted new field', () => {
    const r = LuckyDrawPageSchema.parse(
      page(
        {
          ...newEvent,
          total_tickets: 'many',
          entrant_count: null,
          my_tickets: 'none',
          top: 'nope',
          seed_hash: 42,
          result: { winner: 'someone' },
        },
        { next_event: { name: 7 } },
      ),
    );
    expect(r.event).toMatchObject({
      id: 'ldev_1',
      draw_mode: 'one_winner',
      total_tickets: 0,
      entrant_count: 0,
      my_tickets: 0,
      top: [],
      result: null,
    });
    expect(r.next_event).toBeNull();
  });

  it('reads a mode this build does not know as the old page', () => {
    const r = LuckyDrawPageSchema.parse(
      page({ ...newEvent, draw_mode: 'team_draw' }),
    );
    expect(r.event?.draw_mode).toBe('per_prize');
  });

  it('keeps a pot prize whose own seed fields are null (only the event has a seed)', () => {
    const r = LuckyDrawPageSchema.parse(
      page(newEvent, { prizes: [prize({ seed_hash: null })] }),
    );
    expect(r.prizes).toHaveLength(1);
  });

  it('never carries an undrawn seed on into the client payload', () => {
    const r = LuckyDrawPageSchema.parse(
      page({ ...newEvent, seed: 'b'.repeat(64), seed_nonce: 'n' }),
    );
    expect(r.event).not.toHaveProperty('seed');
    expect(r.event).not.toHaveProperty('seed_nonce');
  });
});

describe('NextEventSchema and LuckyDrawEventResultSchema', () => {
  it('read their contract shapes', () => {
    expect(
      NextEventSchema.parse({ name: 'D', starts_at: oldEvent.starts_at }),
    ).toMatchObject({ name: 'D' });
    expect(LuckyDrawEventResultSchema.parse(eventResult)).toMatchObject({
      winner_tickets: 40,
      seed_hash: eventResult.seed_hash,
    });
  });
});

describe('LuckyDrawResultsSchema', () => {
  const row = {
    prize_id: 'ldpz_1',
    title: 'PSA 10 Charizard',
    image: null,
    value_myr: 1200,
    drawn_at: '2026-11-30T16:00:00.000Z',
    winner: person,
    winner_tickets: 40,
    total_tickets: 100,
    entrant_count: 3,
    seed: 'c'.repeat(64),
    seed_hash: 'd'.repeat(64),
  };

  it('reads an old row and a new event row side by side', () => {
    const r = LuckyDrawResultsSchema.parse({
      results: [
        row,
        {
          ...row,
          event_id: 'ldev_1',
          draw_mode: 'one_winner',
          event_name: 'November',
          prize_count: 4,
        },
      ],
      next_before: null,
    });
    expect(r.results).toHaveLength(2);
    expect(r.results[0]?.event_id).toBeUndefined();
    expect(r.results[1]).toMatchObject({
      event_id: 'ldev_1',
      draw_mode: 'one_winner',
      event_name: 'November',
      prize_count: 4,
    });
  });

  it('keeps a row whose new fields drifted', () => {
    const r = LuckyDrawResultsSchema.parse({
      results: [{ ...row, event_id: 9, prize_count: 'four', event_name: 1 }],
      next_before: null,
    });
    expect(r.results).toHaveLength(1);
    expect(r.results[0]?.event_id).toBeUndefined();
  });
});

describe('LuckyDrawEventDetailSchema', () => {
  const detail = {
    result: eventResult,
    prizes: [
      {
        id: 'ldpz_1',
        kind: 'card',
        title: 'Umbreon',
        image: '/u.webp',
        value_myr: 4200,
      },
      { kind: 'credit', title: 'RM 500', image: null, value_myr: 500 },
    ],
    entries: [
      { person: { ...person, who: 'B' }, tickets: 60 },
      { person: { ...person, who: 'A' }, tickets: 40 },
    ],
    ticket_index: 12,
  };

  it('keeps the entries in the order sent (the draw order)', () => {
    const r = LuckyDrawEventDetailSchema.parse(detail);
    expect(r.entries.map((e) => e.person.who)).toEqual(['B', 'A']);
    expect(r.prizes.map((p) => p.title)).toEqual(['Umbreon', 'RM 500']);
    expect(r.ticket_index).toBe(12);
  });

  it('drops a prize it cannot read and keeps the rest', () => {
    const r = LuckyDrawEventDetailSchema.parse({
      ...detail,
      prizes: [detail.prizes[0], { title: 'broken', value_myr: 'lots' }],
    });
    expect(r.prizes.map((p) => p.title)).toEqual(['Umbreon']);
  });

  it('refuses a detail with no ticket_index: drift must not read as "No entries"', () => {
    const { ticket_index: _gone, ...noTicket } = detail;
    expect(LuckyDrawEventDetailSchema.safeParse(noTicket).success).toBe(false);
  });

  it('reads a no-entries draw', () => {
    const r = LuckyDrawEventDetailSchema.parse({
      ...detail,
      result: { ...eventResult, winner: null, winner_tickets: 0 },
      entries: [],
      ticket_index: null,
    });
    expect(r.result.winner).toBeNull();
    expect(r.ticket_index).toBeNull();
  });
});

describe('LuckyDrawResultDetailSchema', () => {
  it('still reads an old per-prize detail, with no prizes', () => {
    const r = LuckyDrawResultDetailSchema.parse({
      result: {
        prize_id: 'p1',
        title: 'PSA 10 Charizard',
        image: null,
        value_myr: 1200,
        drawn_at: '2026-11-30T16:00:00.000Z',
        winner: person,
        winner_tickets: 1,
        total_tickets: 3,
        entrant_count: 2,
        seed: 'c'.repeat(64),
        seed_hash: 'd'.repeat(64),
      },
      entries: [{ person, tickets: 3 }],
      ticket_index: 2,
    });
    expect(r.prizes).toBeUndefined();
  });
});

describe('LuckyDrawMineSchema', () => {
  const row = {
    prize_id: 'ldpz_1',
    title: 'PSA 10 Charizard',
    image: null,
    my_tickets: 10,
    draw_at: oldEvent.ends_at,
    status: 'open',
  };

  it('reads old prize rows and event rows, and the new ledger reason', () => {
    const r = LuckyDrawMineSchema.parse({
      balance: 40,
      history: [
        { delta: 50, reason: 'pack_spin', created_at: oldEvent.starts_at },
      ],
      entries: [row, { ...row, prize_id: 'ldev_1', event_id: 'ldev_1' }],
    });
    expect(r.entries).toHaveLength(2);
    expect(r.entries[0]?.event_id).toBeUndefined();
    expect(r.entries[1]?.event_id).toBe('ldev_1');
    expect(r.history[0]?.reason).toBe('pack_spin');
  });

  it('keeps an event row with no image', () => {
    const { image: _none, ...noImage } = row;
    const r = LuckyDrawMineSchema.parse({
      balance: 0,
      history: [],
      entries: [{ ...noImage, event_id: 'ldev_1' }],
    });
    expect(r.entries[0]?.image).toBeNull();
  });
});
