import {
  buildOrdersGrid,
  cardsText,
  decideOrderEdit,
  ORDER_COL,
  type SheetOrder,
} from '../orders-sheet';
import type { Cell } from '../../../utils/google-sheets';

// The All orders tab: which sheet edits become order moves, which are refused
// with a NOTE, and how notes live on. The job's write path is in
// jobs/__tests__/sync-procurement-sheet.unit.spec.ts.

const order = (over: Partial<SheetOrder> = {}): SheetOrder => ({
  id: 'o1',
  status: 'ready_to_ship',
  tracking_number: null,
  customer_id: 'c1',
  name: 'Ali',
  cards: ['Pikachu'],
  created_at: '2026-11-25T01:00:00Z',
  shipped_at: null,
  ...over,
});
const s = (v: string): Cell => ({ userEnteredValue: { stringValue: v } });
/** The row as the sync wrote it for `o`, then edited in the sheet. */
const edited = (
  o: SheetOrder,
  status?: Cell | string,
  tracking?: Cell | string,
): Cell[] => {
  const r = [...buildOrdersGrid([o], [], new Map())[1]];
  const cell = (v: Cell | string) => (typeof v === 'string' ? s(v) : v);
  if (status !== undefined) r[ORDER_COL.STATUS] = cell(status);
  if (tracking !== undefined) r[ORDER_COL.TRACKING] = cell(tracking);
  return r;
};

describe('orders sheet: decideOrderEdit', () => {
  it('ignores a row nobody edited', () => {
    const o = order();
    expect(decideOrderEdit(edited(o), o)).toBeNull();
  });

  it("makes the shipping desk's moves", () => {
    const o = order();
    expect(decideOrderEdit(edited(o, 'Pending to ship'), o)).toEqual({
      input: { status: 'pending_ship' },
    });
    expect(decideOrderEdit(edited(o, ' shipped ', 'NV1'), o)).toEqual({
      input: { status: 'shipped', tracking_number: 'NV1' },
    });
    const pending = order({ status: 'pending_ship' });
    expect(decideOrderEdit(edited(pending, 'Ready to ship'), pending)).toEqual({
      input: { status: 'ready_to_ship' },
    });
  });

  it('leaves every other move to the admin', () => {
    const cases: [Partial<SheetOrder>, string][] = [
      [{ status: 'requested' }, 'Processed'], // closes the customer's cancel window
      [{ status: 'processed' }, 'Ready to ship'], // skips oldest-first allocation
      [{ status: 'shipped', tracking_number: 'NV1' }, 'Completed'], // final
      [{ status: 'ready_to_ship' }, 'Processed'], // out of the ship pile
      [{ status: 'requested' }, 'Shipped'],
    ];
    for (const [over, to] of cases) {
      const o = order(over);
      expect(decideOrderEdit(edited(o, to, 'NV1'), o)).toEqual({
        note: expect.stringMatching(/in admin/),
      });
    }
    const requested = order({ status: 'requested' });
    expect(decideOrderEdit(edited(requested, 'Canceled'), requested)).toEqual({
      note: expect.stringMatching(/Cancel in admin/),
    });
  });

  it('saves a tracking number typed on its own while the parcel is in the pile', () => {
    const o = order();
    expect(decideOrderEdit(edited(o, undefined, 'JT99'), o)).toEqual({
      input: { tracking_number: 'JT99' },
    });
  });

  it('refuses Shipped without a tracking number', () => {
    const o = order();
    expect(decideOrderEdit(edited(o, 'Shipped'), o)).toEqual({
      note: expect.stringMatching(/tracking number/),
    });
  });

  it('never clears tracking, nor changes it after shipping, from the sheet', () => {
    const o = order({ tracking_number: 'NV1' });
    expect(decideOrderEdit(edited(o, undefined, {}), o)).toEqual({
      note: expect.stringMatching(/Clear the tracking number in admin/),
    });
    for (const status of ['shipped', 'completed', 'canceled']) {
      const done = order({ status, tracking_number: 'NV1' });
      expect(decideOrderEdit(edited(done, undefined, 'NV2'), done)).toEqual({
        note: expect.stringMatching(/in admin/),
      });
    }
  });

  it('takes tracking only as typed text, and only plain characters', () => {
    const o = order();
    // A digits-only number Sheets turned into a number lost its leading zeros.
    expect(
      decideOrderEdit(
        edited(o, undefined, { userEnteredValue: { numberValue: 12345 } }),
        o,
      ),
    ).toEqual({ note: expect.stringMatching(/type it as text/) });
    expect(
      decideOrderEdit(
        edited(o, undefined, { userEnteredValue: { formulaValue: '=A1' } }),
        o,
      ),
    ).toEqual({ note: expect.stringMatching(/type it as text/) });
    for (const bad of ['=HYPERLINK("x")', '-12', 'NV\u0000', 'x'.repeat(65)]) {
      expect(decideOrderEdit(edited(o, undefined, bad), o)).toEqual({
        note: expect.stringMatching(/Tracking not saved/),
      });
    }
    expect(decideOrderEdit(edited(o, undefined, '0012345'), o)).toEqual({
      input: { tracking_number: '0012345' },
    });
  });

  it('refuses a word that is not a status', () => {
    const o = order();
    expect(decideOrderEdit(edited(o, 'Lost'), o)).toEqual({
      note: 'Pick a status from the list.',
    });
  });

  it('lets the admin side win when the order moved since the sheet was written', () => {
    const row = edited(order(), 'Pending to ship');
    expect(decideOrderEdit(row, order({ status: 'canceled' }))).toEqual({
      note: expect.stringMatching(/admin/),
    });
  });

  it('stays quiet when the order already is what the row asks (its own edit, saved before a failed write)', () => {
    const row = edited(order(), 'Shipped', 'NV1');
    expect(
      decideOrderEdit(
        row,
        order({ status: 'shipped', tracking_number: 'NV1' }),
      ),
    ).toBeNull();
  });

  it('ignores a row whose hidden cells belong to another order (sorted away)', () => {
    const row = edited(order({ id: 'o2' }), 'Pending to ship');
    row[ORDER_COL.ORDER] = s('o1');
    expect(decideOrderEdit(row, order())).toBeNull();
  });

  it('does not treat spaces around a stored tracking number as an edit', () => {
    const o = order({ tracking_number: ' NV1 ' });
    expect(decideOrderEdit(edited(o), o)).toBeNull();
  });
});

describe('orders sheet: buildOrdersGrid notes', () => {
  it("writes this pass's note, keeps an old one while the status holds, and drops it once the order moves", () => {
    const o = order();
    const withNote = buildOrdersGrid(
      [o],
      [],
      new Map([['o1', 'Cancel in admin']]),
    );
    expect(withNote[1][ORDER_COL.NOTE]).toEqual(s('Cancel in admin'));

    expect(
      buildOrdersGrid([o], withNote, new Map())[1][ORDER_COL.NOTE],
    ).toEqual(s('Cancel in admin'));
    expect(
      buildOrdersGrid([order({ status: 'shipped' })], withNote, new Map())[1][
        ORDER_COL.NOTE
      ],
    ).toEqual({});
    expect(
      buildOrdersGrid([o], withNote, new Map([['o1', '']]))[1][ORDER_COL.NOTE],
    ).toEqual({});
  });

  it('shows legacy statuses in today words', () => {
    const grid = buildOrdersGrid([order({ status: 'packing' })], [], new Map());
    expect(grid[1][ORDER_COL.STATUS]).toEqual(s('Processed'));
  });

  it('counts repeated cards once', () => {
    expect(cardsText(['Mew', 'Pikachu', 'Mew'])).toBe('Mew ×2, Pikachu');
  });
});
