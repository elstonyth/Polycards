/**
 * The Lucky Draw payloads (GET /store/lucky-draw and friends). Deploy-skew
 * rule, as TaskHubSchema: one prize or row this build cannot read drops alone
 * instead of blanking the page.
 */
import { describe, expect, it } from 'vitest';
import {
  LuckyDrawEnterSchema,
  LuckyDrawPageSchema,
  LuckyDrawResultDetailSchema,
} from '@/lib/data/schemas';

const person = {
  who: 'Collector8011',
  face_seed: 7,
  avatar_url: null,
  frame_url: null,
};

const prize = (id: string) => ({
  id,
  kind: 'card',
  title: 'PSA 10 Charizard',
  image: '/images/x.webp',
  value_myr: 1200,
  draw_at: '2026-11-30T15:59:00.000Z',
  seed_hash: 'a'.repeat(64),
  total_tickets: 300,
  entrant_count: 2,
  my_tickets: 10,
  top: [{ person, tickets: 290 }],
  result: null,
});

const page = (prizes: unknown[]) => ({
  balance: 40,
  event: {
    id: 'ev_1',
    name: 'November Lucky Draw',
    starts_at: '2026-11-01T00:00:00.000Z',
    ends_at: '2026-11-30T15:59:00.000Z',
  },
  prizes,
});

describe('LuckyDrawPageSchema', () => {
  it('drops a malformed prize and keeps the rest', () => {
    const r = LuckyDrawPageSchema.safeParse(
      page([prize('p1'), { ...prize('p2'), value_myr: 'lots' }, prize('p3')]),
    );
    expect(r.success).toBe(true);
    expect(r.data?.prizes.map((p) => p.id)).toEqual(['p1', 'p3']);
  });

  it('reads a prize without `top` as an empty top list', () => {
    const { top: _top, ...noTop } = prize('p1');
    const r = LuckyDrawPageSchema.safeParse(page([noTop]));
    expect(r.success).toBe(true);
    expect(r.data?.prizes[0]?.top).toEqual([]);
  });

  it('still accepts a prize carrying a `seed` (loose) — the UI never reads it', () => {
    const r = LuckyDrawPageSchema.safeParse(
      page([{ ...prize('p1'), seed: 'b'.repeat(64) }]),
    );
    expect(r.success).toBe(true);
    expect(r.data?.prizes).toHaveLength(1);
    // Defence in depth: never carried on into the RSC payload.
    expect(r.data?.prizes[0]).not.toHaveProperty('seed');
  });

  it('turns a person into the avatar the leaderboard would show', () => {
    const r = LuckyDrawPageSchema.parse(page([prize('p1')]));
    expect(r.prizes[0]?.top[0]?.person).toEqual({
      who: 'Collector8011',
      avatar: '/images/pfps/pfp-8.webp',
      frame: null,
    });
  });

  it('reads no event as null', () => {
    const r = LuckyDrawPageSchema.parse({
      balance: 0,
      event: null,
      prizes: [],
    });
    expect(r.event).toBeNull();
  });
});

describe('LuckyDrawResultDetailSchema', () => {
  it('keeps the entry list in the order sent (the draw order)', () => {
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
      entries: [
        { person: { ...person, who: 'B' }, tickets: 2 },
        { person: { ...person, who: 'A' }, tickets: 1 },
      ],
      ticket_index: 2,
    });
    expect(r.entries.map((e) => e.person.who)).toEqual(['B', 'A']);
    expect(r.ticket_index).toBe(2);
  });
});

describe('LuckyDrawEnterSchema', () => {
  it('reads an accepted entry', () => {
    expect(
      LuckyDrawEnterSchema.parse({
        entered: true,
        entryId: 'e1',
        balance: 30,
        myTickets: 20,
      }),
    ).toMatchObject({ entered: true, balance: 30, myTickets: 20 });
  });

  it('still reads an accepted entry whose numbers drifted — the tickets are spent', () => {
    const r = LuckyDrawEnterSchema.safeParse({ entered: true, balance: '30' });
    expect(r.success).toBe(true);
    expect(r.data).toMatchObject({ entered: true });
  });

  it('reads a refusal', () => {
    expect(
      LuckyDrawEnterSchema.parse({ entered: false, reason: 'closed' }),
    ).toMatchObject({ entered: false, reason: 'closed' });
  });
});
