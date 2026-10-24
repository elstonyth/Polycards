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
