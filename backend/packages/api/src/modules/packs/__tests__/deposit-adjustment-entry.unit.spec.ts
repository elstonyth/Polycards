import type { FakeFacet, GatewayDeposits } from '../facets';
import { fakeGateway } from '../fake-gateway';
import { setActiveGateway } from '../gateway';
import { GatewayError } from '../gateway-types';
import { linkAdjustmentEntry } from '../deposit-adjustment-entry';
import { rowFx, toLedgerAmount } from '../payment-fx';

// A short payment credited by hand for what arrived. The gateway keeps the
// order FAILED and books the arrived sum as its own manual entry; linking
// that entry to the row is what lets the hourly audit check the credit.
const ORIGINAL = { ...process.env };

beforeEach(() => {
  fakeGateway.reset();
  setActiveGateway('fake');
  process.env.GATEWAY_ENABLED = 'true';
  process.env.PAYMENT_GATEWAY = 'fake';
});

afterAll(() => {
  process.env = ORIGINAL;
  setActiveGateway(null);
});

const shortRow = {
  id: 'gpd_1',
  customer_id: 'cus_1',
  merchant_transaction_id: 'PC-1',
  gateway_transaction_id: 'D-ORDER-1',
  amount_requested: '64.56',
  amount_settled: '56.49',
  status: 'settled',
  gateway: 'fake',
  gateway_adjustment_ref: null,
  audit_note: 'gateway says FAILED, and the row was credited …',
};

const entryPaid = {
  state: 'success' as const,
  amount: 56.49,
  netAmount: 55.92,
  statusId: 6,
  transactionId: 'D-ENTRY-1',
};

const orderFailed = { state: 'failed' as const, amount: 0 };

/** The gateway answers the row's own order (PC-1) and the entry apart. */
const answer = (entry: object | Error, order: object | Error = orderFailed) =>
  fakeGateway.script({
    getDepositDetail: (() => {
      const pick =
        fakeGateway.calls.depositDetails.at(-1) === 'PC-1' ? order : entry;
      if (pick instanceof Error) throw pick;
      return pick;
    }) as never,
  });

function harness(
  row: Record<string, unknown> | null = shortRow,
  taken: Record<string, unknown>[] = [],
) {
  const packs = {
    listGatewayDeposits: jest.fn(async (f: Record<string, unknown>) => {
      if (f.id) return row && f.id === row.id ? [row] : [];
      // Another row already carrying the reference, in any of its columns.
      return taken.filter((t) =>
        Object.entries(f).every(([k, v]) => t[k] === v),
      );
    }),
    updateGatewayDeposits: jest.fn(async () => ({})),
    createAdminActionAudits: jest.fn(async () => []),
  } satisfies FakeFacet<
    Pick<
      GatewayDeposits,
      | 'listGatewayDeposits'
      | 'updateGatewayDeposits'
      | 'createAdminActionAudits'
    >
  >;
  const scope = { resolve: () => packs } as never;
  const link = (ref = 'MD20261108102020', reason = 'Checked back office') =>
    linkAdjustmentEntry(scope, {
      depositId: 'gpd_1',
      ref,
      adminId: 'usr_admin_1',
      reason,
    });
  return { packs, link };
}

describe('linkAdjustmentEntry', () => {
  it('links an entry the gateway reports paid for what the row credited', async () => {
    answer(entryPaid);
    const h = harness();
    await expect(h.link()).resolves.toEqual({
      linked: true,
      ref: 'MD20261108102020',
      entryId: 'D-ENTRY-1',
    });
    // It asked the gateway about the ENTRY, not the order.
    expect(fakeGateway.calls.depositDetails).toEqual([
      'PC-1',
      'MD20261108102020',
    ]);
    expect(h.packs.updateGatewayDeposits).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'gpd_1',
        gateway_adjustment_ref: 'MD20261108102020',
        audit_note: null,
      }),
    );
  });

  it('records who linked it, why, and what the gateway said', async () => {
    answer(entryPaid);
    const h = harness();
    await h.link();
    expect(h.packs.createAdminActionAudits).toHaveBeenCalledWith([
      expect.objectContaining({
        admin_id: 'usr_admin_1',
        entity_type: 'gateway_deposit',
        entity_id: 'gpd_1',
        action: 'edit',
        before: { gateway_adjustment_ref: null },
        after: expect.objectContaining({
          gateway_adjustment_ref: 'MD20261108102020',
          gateway_entry_id: 'D-ENTRY-1',
          entry_amount: 56.49,
        }),
        reason: 'Checked back office',
      }),
    ]);
  });

  it('trims the reference it was given', async () => {
    answer(entryPaid);
    const h = harness();
    await h.link('  MD20261108102020 ');
    expect(fakeGateway.calls.depositDetails).toEqual([
      'PC-1',
      'MD20261108102020',
    ]);
  });

  describe('refuses, writing nothing', () => {
    const nothing = (h: ReturnType<typeof harness>) => {
      expect(h.packs.updateGatewayDeposits).not.toHaveBeenCalled();
      expect(h.packs.createAdminActionAudits).not.toHaveBeenCalled();
    };

    it.each(['', 'has space', 'x'.repeat(65), 'MD<script>'])(
      'a malformed reference %p',
      async (ref) => {
        const h = harness();
        await expect(h.link(ref)).rejects.toThrow(/reference/i);
        nothing(h);
        expect(fakeGateway.calls.depositDetails).toEqual([]);
      },
    );

    it('an unknown deposit', async () => {
      const h = harness(null);
      await expect(h.link()).rejects.toThrow(/No such deposit/);
      nothing(h);
    });

    it.each(['pending', 'failed', 'expired'])('a %s row', async (status) => {
      const h = harness({ ...shortRow, status });
      await expect(h.link()).rejects.toThrow(/only a settled deposit/i);
      nothing(h);
    });

    it('a row already linked', async () => {
      const h = harness({ ...shortRow, gateway_adjustment_ref: 'MD-OLD' });
      await expect(h.link()).rejects.toThrow(/already linked/i);
      nothing(h);
    });

    // The order itself is not an entry for what arrived.
    it.each(['PC-1', 'D-ORDER-1'])(
      "the row's own reference %s",
      async (ref) => {
        const h = harness();
        await expect(h.link(ref)).rejects.toThrow(/this deposit's own/i);
        nothing(h);
      },
    );

    // One entry backs one credit. A customer order (or an entry already used)
    // attached here would hide a credit nothing paid for.
    it.each([
      ['merchant_transaction_id'],
      ['gateway_transaction_id'],
      ['gateway_adjustment_ref'],
    ])('a reference another row holds as %s', async (column) => {
      const h = harness(shortRow, [
        { id: 'gpd_other', [column]: 'MD20261108102020' },
      ]);
      await expect(h.link()).rejects.toThrow(/another deposit/i);
      nothing(h);
      expect(fakeGateway.calls.depositDetails).toEqual([]);
    });

    it.each(['pending', 'failed'] as const)(
      'an entry the gateway reports %s',
      async (state) => {
        answer({ ...entryPaid, state });
        const h = harness();
        await expect(h.link()).rejects.toThrow(/not paid/i);
        nothing(h);
      },
    );

    it('an entry paid for a different sum', async () => {
      answer({ ...entryPaid, amount: 50 });
      const h = harness();
      await expect(h.link()).rejects.toThrow(/RM 50\.00.*RM 56\.49/);
      nothing(h);
    });

    it('an entry the gateway has no record of', async () => {
      answer(
        new GatewayError('Not found', [], 400, false, { result: 'not-found' }),
      );
      const h = harness();
      await expect(h.link()).rejects.toThrow(/no entry with that reference/i);
      nothing(h);
    });

    it('when the gateway cannot be asked', async () => {
      answer(new GatewayError('forbidden', [], 403));
      const h = harness();
      await expect(h.link()).rejects.toThrow(/could not be asked/i);
      nothing(h);
    });

    // The entry answers one finding only: the order kept FAILED. A link on
    // any other row would clear a finding the entry says nothing about
    // (security review, 2026-11-18).
    it.each([
      ['success', { state: 'success', amount: 56.49 }],
      ['pending', { state: 'pending', amount: 0 }],
    ])('when the order itself is %s', async (state, order) => {
      answer(entryPaid, order);
      const h = harness();
      await expect(h.link()).rejects.toThrow(
        new RegExp(`own order as ${state}, not failed`),
      );
      nothing(h);
      expect(fakeGateway.calls.depositDetails).toEqual(['PC-1']);
    });

    it.each([
      [
        'not found',
        new GatewayError('Not found', [], 400, false, { result: 'not-found' }),
      ],
      ['unanswered', new GatewayError('their outage', [], 500)],
    ])('when the order itself is %s', async (_label, error) => {
      answer(entryPaid, error);
      const h = harness();
      await expect(h.link()).rejects.toThrow(/could not confirm/i);
      nothing(h);
      expect(fakeGateway.calls.depositDetails).toEqual(['PC-1']);
    });

    it('a gateway that is not configured', async () => {
      const h = harness({ ...shortRow, gateway: 'globepay' });
      await expect(h.link()).rejects.toThrow(/not configured/i);
      nothing(h);
    });

    it('a reason that is missing or too long', async () => {
      const h = harness();
      await expect(h.link('MD20261108102020', ' ')).rejects.toThrow(/reason/i);
      await expect(h.link('MD20261108102020', 'x'.repeat(501))).rejects.toThrow(
        /reason/i,
      );
      nothing(h);
    });
  });
});

// The four real rows (2026-10-26 to 11-08). Each entry's USDT, through the
// row's own lock, must land on the RM credited by hand, or linking them would
// refuse and the audit would keep reporting a gap.
describe('the four short USDT top-ups convert to what was credited', () => {
  it.each([
    ['D2026102614491575', '405.85', '100', 98.5, 399.76],
    ['D2026110414640759', '201.88', '50', 48.8, 197.03],
    ['D2026110414642755', '80.76', '20', 18.8, 75.91],
    ['D2026110814697582', '64.56', '16', 14, 56.49],
  ])('%s', (_order, asked, usdt, arrived, credited) => {
    const fx = rowFx({
      amount_requested: asked,
      gateway_amount: usdt,
      currency: 'USDT',
    });
    expect(toLedgerAmount(fx, arrived)).toBe(credited);
  });
});
