import {
  DELIVERY_STATUSES,
  SHIP_PILE_EXITS,
  SHIP_PILE_STATUSES,
  SHIP_PILE_UNAUDITED_REFUSAL,
  SHIP_PILE_UNCHECKED_REFUSAL,
  isShipPileExit,
  isShipPileStatus,
  shipPileClearVerdict,
  shipPileExitRefusal,
} from '../delivery';

// The ship-pile rule (incident 2026-11-03): an order in ready_to_ship or
// pending_ship may already be packed, so moving it out of the pile other than
// by shipping must make the admin check the pile, and the packer must hear
// about it.
describe('ship pile statuses', () => {
  it('are exactly ready_to_ship and pending_ship', () => {
    expect([...SHIP_PILE_STATUSES].sort()).toEqual([
      'pending_ship',
      'ready_to_ship',
    ]);
  });

  it.each([
    ['requested', false],
    ['processed', false],
    // The legacy pre-rename token is what processed is now: not packed.
    ['packing', false],
    ['ready_to_ship', true],
    ['pending_ship', true],
    ['shipped', false],
    ['completed', false],
    ['canceled', false],
    ['', false],
  ])('%s in the pile: %s', (status, inPile) => {
    expect(isShipPileStatus(status)).toBe(inPile);
  });

  it('treats a missing status as out of the pile', () => {
    expect(isShipPileStatus(undefined)).toBe(false);
    expect(isShipPileStatus(null)).toBe(false);
  });

  it('leaves the pile without shipping only by a cancel or a step back', () => {
    expect([...SHIP_PILE_EXITS].sort()).toEqual(['canceled', 'processed']);
  });
});

describe('isShipPileExit', () => {
  it('is a cancel, or a step back to processed, from the pile', () => {
    for (const from of ['ready_to_ship', 'pending_ship']) {
      expect(isShipPileExit(from, 'canceled')).toBe(true);
      expect(isShipPileExit(from, 'processed')).toBe(true);
    }
  });

  it('is not a cancel from before the pile', () => {
    expect(isShipPileExit('requested', 'canceled')).toBe(false);
    expect(isShipPileExit('processed', 'canceled')).toBe(false);
  });

  it('is not shipping, nor a move within the pile', () => {
    for (const to of [
      'shipped',
      'ready_to_ship',
      'pending_ship',
      'completed',
    ]) {
      expect(isShipPileExit('ready_to_ship', to)).toBe(false);
      expect(isShipPileExit('pending_ship', to)).toBe(false);
    }
  });

  it('names every status a pile order can reach', () => {
    const reachable = DELIVERY_STATUSES.filter((to) =>
      isShipPileExit('ready_to_ship', to),
    );
    expect(reachable.sort()).toEqual(['canceled', 'processed']);
  });

  it('reads an audit row with no status as no exit', () => {
    expect(isShipPileExit(undefined, 'canceled')).toBe(false);
    expect(isShipPileExit('ready_to_ship', undefined)).toBe(false);
  });
});

describe('shipPileExitRefusal', () => {
  const checked = { pileChecked: true, audited: true };

  it('lets a checked, audited exit from the pile through', () => {
    for (const from of ['ready_to_ship', 'pending_ship']) {
      for (const to of ['canceled', 'processed']) {
        expect(shipPileExitRefusal(from, to, checked)).toBe(null);
      }
    }
  });

  it('refuses an exit from the pile the admin did not check', () => {
    // The step back is guarded too: otherwise step back, then cancel from
    // processed, would skip both guards.
    for (const to of ['canceled', 'processed']) {
      expect(
        shipPileExitRefusal('ready_to_ship', to, {
          pileChecked: false,
          audited: true,
        }),
      ).toBe(SHIP_PILE_UNCHECKED_REFUSAL);
    }
  });

  it('refuses an exit from the pile that names no admin, checked or not', () => {
    // A script that skips the audit row leaves the packer's list blind, so
    // "checked" alone is not enough (the 2026-11-03 cancel came from outside
    // the admin screens).
    for (const pileChecked of [true, false]) {
      expect(
        shipPileExitRefusal('ready_to_ship', 'canceled', {
          pileChecked,
          audited: false,
        }),
      ).toBe(SHIP_PILE_UNAUDITED_REFUSAL);
    }
  });

  it('never asks about the pile before an order reaches it', () => {
    // The customer's own cancel (requested only) carries no audit and no check.
    const bare = { pileChecked: false, audited: false };
    expect(shipPileExitRefusal('requested', 'canceled', bare)).toBe(null);
    expect(shipPileExitRefusal('processed', 'canceled', bare)).toBe(null);
    expect(shipPileExitRefusal('packing', 'canceled', bare)).toBe(null);
    expect(shipPileExitRefusal('requested', 'processed', bare)).toBe(null);
  });

  it('never asks about the pile for shipping or a move within it', () => {
    const bare = { pileChecked: false, audited: false };
    expect(shipPileExitRefusal('ready_to_ship', 'shipped', bare)).toBe(null);
    expect(shipPileExitRefusal('ready_to_ship', 'pending_ship', bare)).toBe(
      null,
    );
    expect(shipPileExitRefusal('pending_ship', 'ready_to_ship', bare)).toBe(
      null,
    );
  });

  it('words its refusals for staff, never the raw status tokens', () => {
    for (const message of [
      SHIP_PILE_UNCHECKED_REFUSAL,
      SHIP_PILE_UNAUDITED_REFUSAL,
    ]) {
      expect(message).toMatch(/may already be packed/);
      expect(message).not.toMatch(/ready_to_ship|pending_ship|contact support/);
    }
  });
});

describe('shipPileClearVerdict', () => {
  it('clears an order whose move out of the pile is still open', () => {
    expect(shipPileClearVerdict({ exited: true, cleared: false })).toBe('ok');
  });

  it('is a no-op for one already cleared', () => {
    expect(shipPileClearVerdict({ exited: true, cleared: true })).toBe(
      'already_cleared',
    );
  });

  it('refuses an order that never left the pile without shipping', () => {
    expect(shipPileClearVerdict({ exited: false, cleared: false })).toBe(
      'not_pile_exit',
    );
  });

  it('reports an unknown order as not found', () => {
    expect(shipPileClearVerdict(undefined)).toBe('not_found');
  });
});
