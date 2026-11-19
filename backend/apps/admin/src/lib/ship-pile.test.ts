import { describe, expect, it } from 'vitest';
import {
  SHIP_PILE_STATUSES,
  isShipPileStatus,
  pileCancelCount,
  pilePrompt,
} from './ship-pile';

// Mirror of the backend ship-pile rule (modules/packs/delivery.ts), which the
// server re-checks under the order's lock. This side decides when to ask.
describe('ship pile (admin mirror)', () => {
  it('holds exactly ready_to_ship and pending_ship', () => {
    expect([...SHIP_PILE_STATUSES].sort()).toEqual([
      'pending_ship',
      'ready_to_ship',
    ]);
  });

  it.each([
    ['requested', false],
    ['processed', false],
    ['ready_to_ship', true],
    ['pending_ship', true],
    ['shipped', false],
    ['completed', false],
    ['canceled', false],
  ])('%s in the pile: %s', (status, inPile) => {
    expect(isShipPileStatus(status)).toBe(inPile);
  });
});

describe('pileCancelCount', () => {
  const orders = [
    { status: 'requested' },
    { status: 'ready_to_ship' },
    { status: 'pending_ship' },
    { status: 'shipped' },
  ];

  it('counts the orders a cancel would take out of the pile', () => {
    expect(pileCancelCount(orders, 'canceled')).toBe(2);
  });

  it('is zero for any move that is not a cancel', () => {
    expect(pileCancelCount(orders, 'shipped')).toBe(0);
    expect(pileCancelCount(orders, 'pending_ship')).toBe(0);
    expect(pileCancelCount(orders, 'processed')).toBe(0);
  });

  it('is zero for a cancel of orders before the pile', () => {
    expect(
      pileCancelCount(
        [{ status: 'requested' }, { status: 'processed' }],
        'canceled',
      ),
    ).toBe(0);
  });
});

describe('pilePrompt', () => {
  it('asks about one order by its number', () => {
    const p = pilePrompt(1, 'do_01TESTSHIPPILE000000PILE01');
    expect(p.title).toBe('This order may already be packed');
    expect(p.description).toMatch(/#PILE01/);
    expect(p.description).toMatch(/Has the parcel been pulled from the pile\?/);
  });

  it('asks about several orders by count', () => {
    const p = pilePrompt(3);
    expect(p.title).toBe('3 of these orders may already be packed');
    expect(p.description).toMatch(/Have their parcels been pulled/);
  });

  it('keeps the order as the safe answer', () => {
    expect(pilePrompt(1, 'do_1').cancelText).toBe('Keep order');
    expect(pilePrompt(2).cancelText).toBe('Keep orders');
  });
});
