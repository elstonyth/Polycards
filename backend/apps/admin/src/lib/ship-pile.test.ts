import { describe, expect, it } from 'vitest';
import {
  SHIP_PILE_EXITS,
  SHIP_PILE_STATUSES,
  isShipPileExit,
  isShipPileStatus,
  pileCheckPlan,
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

  it('leaves the pile without shipping by a cancel or a step back', () => {
    expect([...SHIP_PILE_EXITS].sort()).toEqual(['canceled', 'processed']);
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

  it('is an exit only from the pile, and only by a cancel or a step back', () => {
    expect(isShipPileExit('ready_to_ship', 'canceled')).toBe(true);
    expect(isShipPileExit('pending_ship', 'processed')).toBe(true);
    expect(isShipPileExit('ready_to_ship', 'shipped')).toBe(false);
    expect(isShipPileExit('ready_to_ship', 'pending_ship')).toBe(false);
    expect(isShipPileExit('processed', 'canceled')).toBe(false);
  });
});

// What save() (one order) and applyBulk() (the selection) send.
describe('pileCheckPlan', () => {
  const selection = [
    { id: 'do_a', status: 'requested' },
    { id: 'do_b', status: 'ready_to_ship' },
    { id: 'do_c', status: 'pending_ship' },
    { id: 'do_d', status: 'shipped' },
  ];

  it('asks about, and checks, only the orders a cancel takes out of the pile', () => {
    const plan = pileCheckPlan(selection, 'canceled');
    expect(plan.ids).toEqual(['do_b', 'do_c']);
    expect(plan.prompt?.title).toBe('2 of these orders may already be packed');
  });

  it('asks about a step back to processed too', () => {
    const plan = pileCheckPlan(selection, 'processed');
    expect(plan.ids).toEqual(['do_b', 'do_c']);
    expect(plan.prompt?.confirmText).toBe('Parcels pulled, move them back');
  });

  it('asks nothing and checks nothing for shipping or a move within the pile', () => {
    for (const to of ['shipped', 'pending_ship', 'ready_to_ship'] as const) {
      expect(pileCheckPlan(selection, to)).toEqual({ ids: [], prompt: null });
    }
  });

  it('asks nothing for a cancel of orders before the pile', () => {
    expect(
      pileCheckPlan(
        [
          { id: 'do_a', status: 'requested' },
          { id: 'do_e', status: 'processed' },
        ],
        'canceled',
      ),
    ).toEqual({ ids: [], prompt: null });
  });

  it('asks about one order in the Manage modal by its number', () => {
    const plan = pileCheckPlan(
      [{ id: 'do_01TESTSHIPPILE000000PILE01', status: 'ready_to_ship' }],
      'canceled',
    );
    expect(plan.ids).toEqual(['do_01TESTSHIPPILE000000PILE01']);
    expect(plan.prompt?.description).toMatch(/#PILE01/);
  });
});

describe('pilePrompt', () => {
  it('asks the packing question for one order', () => {
    const p = pilePrompt(['do_01TESTSHIPPILE000000PILE01'], 'canceled');
    expect(p.title).toBe('This order may already be packed');
    expect(p.description).toMatch(/Has the parcel been pulled from the pile\?/);
    expect(p.confirmText).toBe('Parcel pulled, cancel it');
  });

  it('words a step back as a move, not a cancel', () => {
    const p = pilePrompt(['do_1'], 'processed');
    expect(p.confirmText).toBe('Parcel pulled, move it back');
    expect(p.description).not.toMatch(/refunds/);
  });

  it('keeps the order as the safe answer', () => {
    expect(pilePrompt(['do_1'], 'canceled').cancelText).toBe('Keep order');
    expect(pilePrompt(['do_1', 'do_2'], 'canceled').cancelText).toBe(
      'Keep orders',
    );
  });
});
