import { unzipSync, strFromU8 } from 'fflate';
import { pnlSheets } from '../sheets';
import type { PnlReportBody } from '../report';

const P = (current_sen: number, previous_sen: number | null = null) => ({
  current_sen,
  previous_sen,
});
const C = (current: number, previous: number | null = null) => ({
  current,
  previous,
});
const free = { adjustment: 0, checkin: 2, task: 0, welcome: 0, other: 1 };
const credit = {
  adjustment: P(100, 50),
  checkin: P(0, 0),
  task: P(0, 0),
  weekly_challenge: P(0, 0),
  returned: P(0, 0),
  lucky_draw: P(0, 0),
  other: P(0, 0),
};

// A small report in the route's shape: one pack, last window known.
const report = {
  as_of: '2026-11-15T13:00:00.000Z',
  balance_as_of: '2026-11-15T13:04:00.000Z',
  scope: 'default',
  range: 'month',
  window: { from: '2026-10-31T16:00:00.000Z', to: '2026-11-15T13:00:00.000Z' },
  previous: {
    from: '2026-09-30T16:00:00.000Z',
    to: '2026-10-15T13:00:00.000Z',
  },
  pack_sales: {
    total: P(123456, 100000),
    unattributed: P(0, 0),
    franchises: [
      {
        category: 'pokemon',
        total: P(123456, 100000),
        types: [
          {
            pack_type: 'original',
            total: P(123456, 100000),
            packs: [
              {
                slug: 'chaos-rising',
                title: 'Chaos Rising',
                price_sen: 1500,
                current: {
                  opens: 80,
                  paid_sen: 120000,
                  bonus_sen: 3000,
                  free_qty: free,
                  free_sen: 3456,
                  total_sen: 123456,
                },
                previous: null,
              },
            ],
          },
        ],
      },
    ],
  },
  cogs: {
    total: P(9000, null),
    pulled: P(20000, null),
    purchase: P(0, null),
    estimated_cards: 1,
    franchises: [],
  },
  marketing: {
    total: P(100, 50),
    credit_used: {
      total: P(100, 50),
      by_source: credit,
      returned_back: P(0, 0),
    },
    credit_given: { total: P(100, 50), by_source: credit, removed: P(0, 0) },
    free_cards: {
      total: P(0, 0),
      by_source: {
        checkin: { cards: 3, sold: 1, value: P(0, 0) },
        task: { cards: 0, sold: 0, value: P(0, 0) },
        weekly_challenge: { cards: 0, sold: 0, value: P(0, 0) },
      },
    },
    free_packs: { total: P(0, 0), packs: [] },
    referral: P(0, 0),
    cash_rewards: {
      total: P(0, 0),
      by_source: {
        checkin: P(0, 0),
        task: P(0, 0),
        weekly_challenge: P(0, 0),
        other: P(0, 0),
      },
    },
  },
  coin_flip: {
    revenue: P(0, 0),
    cost: P(0, 0),
    bet_value: P(0, 0),
    flips: C(4, 1),
    tickets_lost: C(0, 0),
    tickets_won: C(0, 0),
  },
  lucky_draw: {
    revenue: P(0, 0),
    capsules: [],
    cost: P(0, 0),
    credit_prizes: P(0, 0),
    card_prizes: P(0, 0),
    prize_count: { credit: C(0, 0), card: C(0, 0) },
    tickets: [{ reason: 'pack_spin', given: C(5, 0), spent: C(0, 0) }],
  },
  shipping: {
    shipping: P(0, 0),
    insurance: P(0, 0),
    total: P(0, 0),
    orders: C(0, 0),
  },
  totals: {
    parts: {
      revenue: { pack_sales: P(123456, 100000) },
      other_revenue: { shipping: P(0, 0) },
      cogs: { packs: P(9000, null) },
      marketing: P(100, 50),
    },
    revenue: P(123456, 100000),
    other_revenue: P(0, 0),
    total_revenue: P(123456, 100000),
    cogs: P(9000, null),
    gross: P(114456, null),
    marketing: P(100, 50),
    net: P(114356, null),
  },
  assets: { total_sen: 0, cards: 0, no_cost_cards: 0 },
  floating: {
    wallet: {
      withdrawable_sen: 0,
      free_credit_sen: 0,
      free_credit_by_source: {
        adjustment: 0,
        checkin: 0,
        task: 0,
        weekly_challenge: 0,
        returned: 0,
        lucky_draw: 0,
        other: 0,
      },
      locked_sen: 0,
      non_withdrawable_sen: 0,
      total_sen: 0,
    },
    cards: {
      vault: { cards: 0, sen: 0 },
      processing: { cards: 0, sen: 0 },
      total_sen: 0,
    },
    total_sen: 0,
  },
} as unknown as PnlReportBody;

type CellObj = { value?: unknown; format?: string } | null | undefined;
const valueOf = (c: unknown) =>
  c !== null && typeof c === 'object' ? (c as { value?: unknown }).value : c;

describe('P&L workbook', () => {
  const sheets = pnlSheets(report);
  const sheet = (name: string) => {
    const s = sheets.find((x) => x.sheet === name);
    if (!s) throw new Error(`no sheet ${name}`);
    return s;
  };

  it('has one sheet per section, in the page order', () => {
    expect(sheets.map((s) => s.sheet)).toEqual([
      'Summary',
      'Pack sales',
      'COGS',
      'Marketing',
      'Coin flip',
      'Lucky Draw',
      'Shipping',
      'Balances (now)',
    ]);
  });

  it('writes amounts as RM numbers and leaves a missing previous empty', () => {
    const rows = sheet('Pack sales').data;
    const header = rows[0].map(valueOf);
    const pack = rows[1];
    const at = (h: string) => pack[header.indexOf(h)] as CellObj;
    expect(at('Paid (RM)')).toMatchObject({ value: 1200, format: '#,##0.00' });
    // Tooltip-only figures on the page are columns here.
    expect(valueOf(at('Of which bonus credit (RM)'))).toBe(30);
    expect(valueOf(at('Free packs: check-in'))).toBe(2);
    expect(valueOf(at('Free packs'))).toBe(3);
    expect(valueOf(at('Total (RM)'))).toBe(1234.56);
    expect(at('Previous total (RM)')).toBeNull();
    expect(at('Change (RM)')).toBeNull();
  });

  it('puts every footer total under the total column and no row past the header', () => {
    for (const name of ['Pack sales', 'COGS']) {
      const rows = sheet(name).data;
      const header = rows[0].map(valueOf);
      const totalCol = header.findIndex((h) =>
        /^(Total|COGS) \(RM\)$/.test(String(h)),
      );
      const footer = rows.find((r) => / total$/.test(String(valueOf(r[0]))));
      expect(footer).toBeDefined();
      expect(valueOf(footer?.[totalCol])).not.toBeNull();
      expect(footer?.length).toBe(header.length);
      for (const r of rows) expect(r.length).toBeLessThanOrEqual(header.length);
      expect(sheet(name).columns).toHaveLength(header.length);
    }
  });

  it('keeps the bottom line and its change', () => {
    const rows = sheet('Summary').data;
    const rev = rows.find((r) => valueOf(r[0]) === 'Revenue');
    expect(rev?.slice(1).map(valueOf)).toEqual([1234.56, 1000, 234.56]);
    const net = rows.find((r) => valueOf(r[0]) === 'Net profit');
    expect(net?.slice(1).map(valueOf)).toEqual([1143.56, null, null]);
  });

  it('builds a real .xlsx with every sheet', async () => {
    const { default: writeXlsxFile } = await import('write-excel-file/node');
    const buf = await writeXlsxFile(sheets).toBuffer();
    const parts = unzipSync(new Uint8Array(buf));
    const book = strFromU8(parts['xl/workbook.xml']);
    for (const s of sheets) expect(book).toContain(`name="${s.sheet}"`);
  });
});
