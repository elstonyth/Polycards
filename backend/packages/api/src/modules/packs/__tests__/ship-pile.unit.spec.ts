import {
  DELIVERY_STATUSES,
  SHIP_PILE_STATUSES,
  SHIP_PILE_UNAUDITED_REFUSAL,
  SHIP_PILE_UNCHECKED_REFUSAL,
  isShipPileCancel,
  isShipPileStatus,
  shipPileCancelRefusal,
  shipPileClearVerdict,
} from '../delivery';

// The ship-pile rule (incident 2026-11-03): an order in
// ready_to_ship or pending_ship may already be packed, so cancelling it must
// make the canceller check the pile, and the packer must hear about it.
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
});

describe('isShipPileCancel', () => {
  it('is a cancel that leaves ready_to_ship or pending_ship', () => {
    expect(isShipPileCancel('ready_to_ship', 'canceled')).toBe(true);
    expect(isShipPileCancel('pending_ship', 'canceled')).toBe(true);
  });

  it('is not a cancel from before the pile', () => {
    expect(isShipPileCancel('requested', 'canceled')).toBe(false);
    expect(isShipPileCancel('processed', 'canceled')).toBe(false);
  });

  it('is not any other move out of the pile', () => {
    for (const to of DELIVERY_STATUSES.filter((s) => s !== 'canceled')) {
      expect(isShipPileCancel('ready_to_ship', to)).toBe(false);
      expect(isShipPileCancel('pending_ship', to)).toBe(false);
    }
  });

  it('reads an audit row with no status as no pile cancel', () => {
    expect(isShipPileCancel(undefined, 'canceled')).toBe(false);
    expect(isShipPileCancel('ready_to_ship', undefined)).toBe(false);
  });
});

describe('shipPileCancelRefusal', () => {
  const checked = { pileChecked: true, audited: true };

  it('lets a checked, audited cancel from the pile through', () => {
    expect(shipPileCancelRefusal('ready_to_ship', 'canceled', checked)).toBe(
      null,
    );
    expect(shipPileCancelRefusal('pending_ship', 'canceled', checked)).toBe(
      null,
    );
  });

  it('refuses a cancel from the pile the canceller did not check', () => {
    for (const from of ['ready_to_ship', 'pending_ship']) {
      expect(
        shipPileCancelRefusal(from, 'canceled', {
          pileChecked: false,
          audited: true,
        }),
      ).toBe(SHIP_PILE_UNCHECKED_REFUSAL);
    }
  });

  it('refuses a cancel from the pile that names no admin, checked or not', () => {
    // A script that skips the audit row leaves the packer's list blind, so
    // "checked" alone is not enough (the 2026-11-03 cancel came from outside
    // the admin screens).
    for (const pileChecked of [true, false]) {
      expect(
        shipPileCancelRefusal('ready_to_ship', 'canceled', {
          pileChecked,
          audited: false,
        }),
      ).toBe(SHIP_PILE_UNAUDITED_REFUSAL);
    }
  });

  it('never asks about the pile before an order reaches it', () => {
    // The customer's own cancel (requested only) carries no audit and no check.
    const bare = { pileChecked: false, audited: false };
    expect(shipPileCancelRefusal('requested', 'canceled', bare)).toBe(null);
    expect(shipPileCancelRefusal('processed', 'canceled', bare)).toBe(null);
    expect(shipPileCancelRefusal('packing', 'canceled', bare)).toBe(null);
  });

  it('never asks about the pile for a move that is not a cancel', () => {
    const bare = { pileChecked: false, audited: false };
    expect(shipPileCancelRefusal('ready_to_ship', 'shipped', bare)).toBe(null);
    expect(shipPileCancelRefusal('ready_to_ship', 'processed', bare)).toBe(
      null,
    );
    expect(shipPileCancelRefusal('pending_ship', 'ready_to_ship', bare)).toBe(
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
  const pileCancel = { status: 'canceled', pileCancel: true, cleared: false };

  it('clears a canceled order that left the pile and is not cleared yet', () => {
    expect(shipPileClearVerdict(pileCancel)).toBe('ok');
  });

  it('is a no-op for one already cleared', () => {
    expect(shipPileClearVerdict({ ...pileCancel, cleared: true })).toBe(
      'already_cleared',
    );
  });

  it('refuses an order that was never cancelled from the pile', () => {
    expect(shipPileClearVerdict({ ...pileCancel, pileCancel: false })).toBe(
      'not_pile_cancel',
    );
  });

  it('refuses an order that is not canceled any more, whatever its history', () => {
    // canceled is terminal today; this pins the rule if that ever changes.
    expect(shipPileClearVerdict({ ...pileCancel, status: 'shipped' })).toBe(
      'not_pile_cancel',
    );
  });

  it('reports an unknown order as not found', () => {
    expect(shipPileClearVerdict(undefined)).toBe('not_found');
  });
});
