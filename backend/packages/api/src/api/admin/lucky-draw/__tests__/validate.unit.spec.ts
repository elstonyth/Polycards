import { MedusaError } from '@medusajs/framework/utils';
import { parseLuckyDrawEvent, parseLuckyDrawPrize } from '../validate';

const invalid = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e as { type?: string };
  }
  throw new Error('expected a throw');
};
const INVALID = { type: MedusaError.Types.INVALID_DATA };

describe('parseLuckyDrawEvent', () => {
  const body = (over: Record<string, unknown> = {}) => ({
    name: 'November Lucky Draw',
    starts_at: '2026-11-01T00:00:00+08:00',
    ends_at: '2026-11-30T23:59:00+08:00',
    ...over,
  });

  it('parses a create and an edit', () => {
    const out = parseLuckyDrawEvent(body({ id: 'ldev_1' }));
    expect(out.id).toBe('ldev_1');
    expect(out.name).toBe('November Lucky Draw');
    expect(out.startsAt.toISOString()).toBe('2026-10-31T16:00:00.000Z');
    expect(out.endsAt.toISOString()).toBe('2026-11-30T15:59:00.000Z');
    expect(parseLuckyDrawEvent(body()).id).toBeUndefined();
  });

  it.each([
    ['no name', { name: undefined }],
    ['a non-string name', { name: 5 }],
    ['no starts_at', { starts_at: undefined }],
    ['an unparseable starts_at', { starts_at: 'soon' }],
    ['a numeric ends_at', { ends_at: 1790000000000 }],
    ['an unparseable ends_at', { ends_at: 'later' }],
  ])('refuses %s as INVALID_DATA', (_, over) => {
    expect(invalid(() => parseLuckyDrawEvent(body(over)))).toMatchObject(INVALID);
  });

  it('refuses a missing body', () => {
    expect(invalid(() => parseLuckyDrawEvent(undefined))).toMatchObject(INVALID);
  });

  describe('with a prize pool', () => {
    const pool = [
      {
        kind: 'card',
        card_handle: 'pikachu',
        title: 'Pikachu',
        sort: 0,
      },
      {
        kind: 'credit',
        credit_myr: 25,
        title: 'RM 25 bonus credit',
        image_url: '/c.webp',
        sort: 1,
        draw_at: '2026-11-30T23:00:00+08:00',
      },
    ];

    it('parses each prize like the prize route does, without an event_id', () => {
      const out = parseLuckyDrawEvent(body({ prizes: pool }));
      expect(out.prizes).toEqual([
        {
          kind: 'card',
          cardHandle: 'pikachu',
          creditMyr: null,
          title: 'Pikachu',
          imageUrl: null,
          sort: 0,
          drawAt: null,
        },
        {
          kind: 'credit',
          cardHandle: null,
          creditMyr: 25,
          title: 'RM 25 bonus credit',
          imageUrl: '/c.webp',
          sort: 1,
          drawAt: new Date('2026-11-30T15:00:00.000Z'),
        },
      ]);
    });

    it('treats absent and null prizes as none, and [] as an empty pool', () => {
      expect(parseLuckyDrawEvent(body()).prizes).toBeUndefined();
      expect(parseLuckyDrawEvent(body({ prizes: null })).prizes).toBeUndefined();
      expect(parseLuckyDrawEvent(body({ prizes: [] })).prizes).toEqual([]);
    });

    it('refuses prizes on an edit, even an empty list', () => {
      for (const prizes of [pool, []]) {
        expect(
          invalid(() => parseLuckyDrawEvent(body({ id: 'ldev_1', prizes }))),
        ).toMatchObject(INVALID);
      }
    });

    it('takes up to 100 prizes and refuses 101', () => {
      const many = (n: number) =>
        Array.from({ length: n }, () => pool[0]);
      expect(parseLuckyDrawEvent(body({ prizes: many(100) })).prizes).toHaveLength(100);
      expect(
        invalid(() => parseLuckyDrawEvent(body({ prizes: many(101) }))),
      ).toMatchObject(INVALID);
    });

    it.each([
      ['a non-array', { prizes: 'pikachu' }],
      ['an object', { prizes: { kind: 'card' } }],
      ['a null item', { prizes: [null] }],
      ['an unknown kind', { prizes: [{ ...pool[0], kind: 'cash' }] }],
      ['a string credit_myr', { prizes: [{ ...pool[1], credit_myr: '25' }] }],
      ['no title', { prizes: [{ ...pool[0], title: undefined }] }],
      ['an unparseable draw_at', { prizes: [{ ...pool[0], draw_at: 'soon' }] }],
    ])('refuses %s as INVALID_DATA', (_, over) => {
      expect(invalid(() => parseLuckyDrawEvent(body(over)))).toMatchObject(
        INVALID,
      );
    });
  });
});

describe('parseLuckyDrawPrize', () => {
  const credit = (over: Record<string, unknown> = {}) => ({
    event_id: 'ldev_1',
    kind: 'credit',
    credit_myr: 25,
    title: 'RM 25',
    image_url: '/c.webp',
    sort: 2,
    ...over,
  });

  it('parses a credit prize; absent optional fields become null / defaults', () => {
    expect(parseLuckyDrawPrize(credit())).toEqual({
      id: undefined,
      eventId: 'ldev_1',
      kind: 'credit',
      cardHandle: null,
      creditMyr: 25,
      title: 'RM 25',
      imageUrl: '/c.webp',
      sort: 2,
      drawAt: null,
    });
  });

  it('parses a card prize with a draw time and an id', () => {
    const out = parseLuckyDrawPrize({
      id: 'ldpz_1',
      event_id: 'ldev_1',
      kind: 'card',
      card_handle: 'pikachu',
      title: 'Pikachu',
      draw_at: '2026-11-30T23:59:00+08:00',
    });
    expect(out).toMatchObject({
      id: 'ldpz_1',
      kind: 'card',
      cardHandle: 'pikachu',
      creditMyr: null,
      imageUrl: null,
      sort: 0,
    });
    expect(out.drawAt?.toISOString()).toBe('2026-11-30T15:59:00.000Z');
  });

  it.each([
    ['no event_id', { event_id: undefined }],
    ['an unknown kind', { kind: 'cash' }],
    ['no title', { title: undefined }],
    ['a non-string card_handle', { card_handle: 7 }],
    ['a string credit_myr', { credit_myr: '25' }],
    ['a fractional sort', { sort: 1.5 }],
    ['a string sort', { sort: '2' }],
    ['an unparseable draw_at', { draw_at: 'tomorrow' }],
    ['a non-string image_url', { image_url: 4 }],
  ])('refuses %s as INVALID_DATA', (_, over) => {
    expect(invalid(() => parseLuckyDrawPrize(credit(over)))).toMatchObject(
      INVALID,
    );
  });
});
