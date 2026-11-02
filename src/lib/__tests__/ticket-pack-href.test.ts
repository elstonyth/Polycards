import { describe, expect, it } from 'vitest';
import { ticketPackHref } from '@/lib/packs-data';

describe('ticketPackHref', () => {
  it('points at the category holding a ticket pack', () => {
    expect(
      ticketPackHref([
        { id: 'pokemon', packs: [{}] },
        { id: 'poly', packs: [{}, { prizeType: 'tickets' }] },
      ]),
    ).toBe('/slots?category=poly');
  });

  it('skips a sold-out ticket pack', () => {
    const soldOut = { prizeType: 'tickets', inStock: false } as const;
    expect(ticketPackHref([{ id: 'poly', packs: [soldOut] }])).toBeNull();
    expect(
      ticketPackHref([
        { id: 'poly', packs: [soldOut] },
        { id: 'promo', packs: [{ prizeType: 'tickets' }] },
      ]),
    ).toBe('/slots?category=promo');
  });

  it('is null with no ticket pack on sale', () => {
    expect(
      ticketPackHref([
        { id: 'pokemon', packs: [{}] },
        { id: 'poly', packs: [] },
      ]),
    ).toBeNull();
  });
});
