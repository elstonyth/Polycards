// write-excel-file 4 is ESM-only under this package's Node16 resolution: the
// TYPES come in with an explicit resolution-mode (see
// ../../inventory/export.xlsx/route.ts for the full story).
import type { Cell, Row, SheetData } from 'write-excel-file/node' with {
  'resolution-mode': 'import',
};
import { FREE_SOURCES, type Pair } from '../../../../modules/packs/pnl';
import type { Count } from '../../../../modules/packs/pnl-games';
import {
  CARD_SOURCES,
  CASH_REWARD_SOURCES,
  CREDIT_SOURCES,
} from '../../../../modules/packs/pnl-marketing';
import { BONUS_SOURCES } from '../../../../modules/packs/pnl-balance';
import type { PnlReport } from './types';

export type PnlSheet = {
  sheet: string;
  data: SheetData;
  columns: { width: number }[];
};

// Amounts are RM numbers (sen / 100) with a 2-decimal format, so Excel can sum
// them; a missing previous window is an empty cell, never 0.
const MONEY = '#,##0.00';
const money = (sen: number | null, bold = false): Cell =>
  sen === null
    ? null
    : {
        value: sen / 100,
        type: Number,
        format: MONEY,
        ...(bold ? { fontWeight: 'bold' as const } : {}),
      };
const num = (n: number | null): Cell =>
  n === null ? null : { value: n, type: Number, format: '#,##0' };
const text = (s: string, bold = false): Cell => ({
  value: s,
  type: String,
  ...(bold ? { fontWeight: 'bold' as const } : {}),
});
const head = (cells: string[]): Row => cells.map((c) => text(c, true));

const pairCells = (p: Pair, bold = false): Cell[] => [
  money(p.current_sen, bold),
  money(p.previous_sen),
  money(p.previous_sen === null ? null : p.current_sen - p.previous_sen),
];
const countCells = (c: Count): Cell[] => [
  num(c.current),
  num(c.previous),
  num(c.previous === null ? null : c.current - c.previous),
];

const words = (s: string | null, none: string) =>
  s === null
    ? none
    : s.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

const myt = (d: Date | string) =>
  new Date(d).toLocaleString('en-GB', {
    timeZone: 'Asia/Kuala_Lumpur',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
const windowText = (w: { from: Date | string; to: Date | string } | null) =>
  w ? `${myt(w.from)} to ${myt(w.to)} (MYT)` : 'All time';

const widths = (...w: number[]) => w.map((width) => ({ width }));

// The page's words (admin en.json), so the file reads like the screen.
const FRANCHISE: Record<string, string> = {
  pokemon: 'Pokémon',
  'one-piece': 'One Piece',
};
const FREE_LABEL: Record<(typeof FREE_SOURCES)[number], string> = {
  adjustment: 'admin gifts',
  checkin: 'check-in',
  task: 'tasks',
  welcome: 'welcome',
  other: 'other',
};
const TICKET_REASON: Record<string, string> = {
  pack_spin: 'Capsule spins',
  task_claim: 'Tasks',
  coin_flip: 'Coin flip',
  admin_grant: 'Admin grants',
  refund: 'Refunds',
  entry: 'Entered in draws',
};

/** A pack tree as flat pack rows (franchise and type as columns, so Excel
 *  filters and pivots work) plus the section's footer lines. */
function treeRows<F extends { total_sen: number }>(
  franchises: {
    category: string | null;
    types: {
      pack_type: string | null;
      packs: {
        slug: string;
        title: string;
        price_sen: number;
        current: F;
        previous: F | null;
      }[];
    }[];
  }[],
  figures: (f: F) => Cell[],
): Row[] {
  return franchises.flatMap((f) =>
    f.types.flatMap((t) =>
      t.packs.map((p): Row => [
        text(
          f.category === null
            ? 'Other'
            : (FRANCHISE[f.category] ?? words(f.category, 'Other')),
        ),
        text(words(t.pack_type, 'Other')),
        text(p.title),
        text(p.slug),
        money(p.price_sen),
        ...figures(p.current),
        ...pairCells({
          current_sen: p.current.total_sen,
          previous_sen: p.previous?.total_sen ?? null,
        }),
      ]),
    ),
  );
}

const PACK_HEAD = ['Franchise', 'Type', 'Pack', 'Slug', 'Price (RM)'];
const PAIR_HEAD = (what: string) => [
  `${what} (RM)`,
  `Previous ${what.toLowerCase()} (RM)`,
  'Change (RM)',
];
const LINE_HEAD = head(['Line', ...PAIR_HEAD('Amount')]);
const line = (label: string, p: Pair, bold = false): Row => [
  text(label, bold),
  ...pairCells(p, bold),
];
/** A footer line under a pack table: label in the first cell, amounts under
 *  the total columns. */
const footer = (gap: number, label: string, p: Pair, bold = false): Row => [
  text(label, bold),
  ...Array.from({ length: gap }, () => null),
  ...pairCells(p, bold),
];

/** The whole P&L report as workbook sheets, in the page's order. Every figure
 *  the page puts in a tooltip (bonus share, free packs by source, estimated
 *  cards) is a column here. */
export function pnlSheets(r: PnlReport): PnlSheet[] {
  const sheets: PnlSheet[] = [];

  const t = r.totals;
  const part = (group: string, key: string) =>
    ({
      'revenue.pack_sales': 'Pack sales',
      'revenue.coin_flip': 'Coin flip',
      'revenue.lucky_draw': 'Lucky Draw capsules',
      'other_revenue.shipping': 'Shipping',
      'cogs.packs': 'Pack cards (buyback + supplier cost)',
      'cogs.coin_flip': 'Coin flip paid out',
      'cogs.lucky_draw': 'Lucky Draw prizes',
    })[`${group}.${key}`] ?? key;
  const parts = (g: 'revenue' | 'other_revenue' | 'cogs') =>
    Object.entries(t.parts[g]).map(([k, p]) => line(`  ${part(g, k)}`, p));
  sheets.push({
    sheet: 'Summary',
    columns: widths(40, 18, 22, 18),
    data: [
      [text('P&L report', true)],
      [text('Period'), text(windowText(r.window))],
      [text('Compared with'), text(r.previous ? windowText(r.previous) : '—')],
      [
        text('Customers'),
        text(r.scope === 'all' ? 'All groups' : 'Real customers'),
      ],
      [text('Figures worked out'), text(`${myt(r.as_of)} (MYT)`)],
      [],
      LINE_HEAD,
      ...parts('revenue'),
      line('Revenue', t.revenue, true),
      ...parts('other_revenue'),
      line('Other revenue', t.other_revenue, true),
      line('Total revenue', t.total_revenue, true),
      ...parts('cogs'),
      line('COGS', t.cogs, true),
      line('Gross profit', t.gross, true),
      line('Marketing', t.marketing, true),
      line('Net profit', t.net, true),
    ],
  });

  const ps = r.pack_sales;
  const freeHead = FREE_SOURCES.map((s) => `Free packs: ${FREE_LABEL[s]}`);
  const psGap = PACK_HEAD.length + 5 + freeHead.length - 1;
  sheets.push({
    sheet: 'Pack sales',
    columns: widths(
      14,
      12,
      26,
      18,
      12,
      12,
      16,
      16,
      ...freeHead.map(() => 12),
      12,
      16,
      16,
      22,
      14,
    ),
    data: [
      head([
        ...PACK_HEAD,
        'Paid opens',
        'Paid (RM)',
        'Of which bonus credit (RM)',
        ...freeHead,
        'Free packs',
        'Free value (RM)',
        ...PAIR_HEAD('Total'),
      ]),
      ...treeRows(ps.franchises, (f) => [
        num(f.opens),
        money(f.paid_sen),
        money(f.bonus_sen),
        ...FREE_SOURCES.map((s) => num(f.free_qty[s])),
        num(FREE_SOURCES.reduce((n, s) => n + f.free_qty[s], 0)),
        money(f.free_sen),
      ]),
      ...(ps.unattributed.current_sen !== 0 ||
      (ps.unattributed.previous_sen ?? 0) !== 0
        ? [footer(psGap, 'Charges with no pack', ps.unattributed)]
        : []),
      footer(psGap, 'Pack sales total', ps.total, true),
    ],
  });

  const cg = r.cogs;
  const cgGap = PACK_HEAD.length + 6 - 1;
  sheets.push({
    sheet: 'COGS',
    columns: widths(14, 12, 26, 18, 12, 12, 18, 16, 14, 16, 16, 16, 18, 16),
    data: [
      head([
        ...PACK_HEAD,
        'Cards pulled',
        'Card value pulled (RM)',
        'Buyback paid (RM)',
        'Cards shipped',
        'Supplier cost (RM)',
        'Costed at market value',
        ...PAIR_HEAD('COGS'),
      ]),
      ...treeRows(cg.franchises, (f) => [
        num(f.pulls),
        money(f.pulled_sen),
        money(f.buyback_sen),
        num(f.shipped_cards),
        money(f.shipped_cost_sen),
        num(f.estimated_cards),
      ]),
      footer(cgGap, 'COGS total', cg.total, true),
      footer(cgGap, 'Card value pulled (information)', cg.pulled),
      footer(
        cgGap,
        'Supplier purchases in the period (information)',
        cg.purchase,
      ),
    ],
  });

  const mk = r.marketing;
  const credit = {
    adjustment: 'Admin gifts',
    checkin: 'Check-in',
    task: 'Tasks',
    weekly_challenge: 'Weekly challenge',
    returned: 'Spent again after a refund',
    lucky_draw: 'Lucky Draw prizes (in Lucky Draw cost, not here)',
    other: 'Other promotions',
  } as const;
  const mkLine = (
    label: string,
    p: Pair,
    qty: Cell = null,
    detail = '',
    bold = false,
  ): Row => [text(label, bold), qty, text(detail), ...pairCells(p, bold)];
  sheets.push({
    sheet: 'Marketing',
    columns: widths(52, 10, 40, 18, 22, 16),
    data: [
      head(['Item', 'Qty', 'Detail', ...PAIR_HEAD('Amount')]),
      mkLine('Free credit used', mk.credit_used.total, null, '', true),
      ...CREDIT_SOURCES.map((s) =>
        mkLine(`  ${credit[s]}`, mk.credit_used.by_source[s]),
      ),
      mkLine(
        '  Came back by a refund or reversal (taken off the total)',
        mk.credit_used.returned_back,
      ),
      mkLine(
        "Free cards (sold back = amount paid, the rest = 90% of today's value)",
        mk.free_cards.total,
        null,
        '',
        true,
      ),
      ...CARD_SOURCES.map((s) => {
        const c = mk.free_cards.by_source[s];
        return mkLine(
          `  ${credit[s]}`,
          c.value,
          num(c.cards),
          `${c.sold} sold back`,
        );
      }),
      mkLine('Free packs', mk.free_packs.total, null, '', true),
      ...mk.free_packs.packs.map((p) =>
        mkLine(
          `  ${p.title} (${p.slug})`,
          p.value,
          num(FREE_SOURCES.reduce((n, s) => n + p.qty[s], 0)),
          FREE_SOURCES.filter((s) => p.qty[s] > 0)
            .map((s) => `${FREE_LABEL[s]} ${p.qty[s]}`)
            .join(', '),
        ),
      ),
      mkLine('Referral commission', mk.referral, null, '', true),
      mkLine(
        'Rewards paid as cash (before free credit started, 11 Oct)',
        mk.cash_rewards.total,
        null,
        '',
        true,
      ),
      ...CASH_REWARD_SOURCES.map((s) =>
        mkLine(
          `  ${s === 'other' ? 'Other rewards' : credit[s]}`,
          mk.cash_rewards.by_source[s],
        ),
      ),
      mkLine('Marketing total', mk.total, null, '', true),
      [],
      mkLine(
        'Free credit given (information, not in the total)',
        mk.credit_given.total,
        null,
        '',
        true,
      ),
      ...CREDIT_SOURCES.map((s) =>
        mkLine(`  ${credit[s]}`, mk.credit_given.by_source[s]),
      ),
      mkLine('  Removed by admin', mk.credit_given.removed),
    ],
  });

  const cf = r.coin_flip;
  const countLine = (label: string, c: Count): Row => [
    text(label),
    ...countCells(c),
  ];
  sheets.push({
    sheet: 'Coin flip',
    columns: widths(44, 18, 22, 16),
    data: [
      LINE_HEAD,
      line('Cards lost by players (revenue)', cf.revenue, true),
      line('Card bet value, won + lost (information)', cf.bet_value),
      line('Credit paid on wins (COGS)', cf.cost, true),
      [],
      head(['Count', 'Current', 'Previous', 'Change']),
      countLine('Tickets lost by players', cf.tickets_lost),
      countLine('Tickets paid out on wins', cf.tickets_won),
      countLine('Flips settled', cf.flips),
    ],
  });

  const ld = r.lucky_draw;
  sheets.push({
    sheet: 'Lucky Draw',
    columns: widths(32, 18, 12, 10, 16, 22, 18, 16),
    data: [
      head([
        'Capsule',
        'Slug',
        'Price (RM)',
        'Spins',
        'Sales (RM)',
        'Of which bonus credit (RM)',
        'Previous sales (RM)',
        'Change (RM)',
      ]),
      ...ld.capsules.map((c): Row => [
        text(c.title),
        text(c.slug),
        money(c.price_sen),
        num(c.current.spins),
        money(c.current.sales_sen),
        money(c.current.bonus_sen),
        money(c.previous?.sales_sen ?? null),
        money(c.previous ? c.current.sales_sen - c.previous.sales_sen : null),
      ]),
      [
        text('Capsule sales total', true),
        null,
        null,
        null,
        money(ld.revenue.current_sen, true),
        null,
        money(ld.revenue.previous_sen),
        money(
          ld.revenue.previous_sen === null
            ? null
            : ld.revenue.current_sen - ld.revenue.previous_sen,
        ),
      ],
      [],
      LINE_HEAD,
      line(
        `Credit prizes (${ld.prize_count.credit.current})`,
        ld.credit_prizes,
      ),
      line(`Card prizes (${ld.prize_count.card.current})`, ld.card_prizes),
      line('Prizes given (COGS)', ld.cost, true),
      [],
      head([
        'Tickets',
        'Given',
        'Previous given',
        'Change',
        'Spent',
        'Previous spent',
        'Change',
      ]),
      ...ld.tickets.map((x): Row => [
        text(TICKET_REASON[x.reason] ?? words(x.reason, 'Other')),
        ...countCells(x.given),
        ...countCells(x.spent),
      ]),
    ],
  });

  const sh = r.shipping;
  sheets.push({
    sheet: 'Shipping',
    columns: widths(32, 18, 22, 16),
    data: [
      LINE_HEAD,
      line('Delivery charge', sh.shipping),
      line('Insurance', sh.insurance),
      line('Shipping total', sh.total, true),
      [],
      head(['Count', 'Current', 'Previous', 'Change']),
      countLine('Orders', sh.orders),
    ],
  });

  const a = r.assets;
  const fl = r.floating;
  const bal = (
    label: string,
    sen: number,
    cards: number | null = null,
    bold = false,
  ): Row => [text(label, bold), money(sen, bold), num(cards)];
  const bonus = {
    adjustment: 'Admin adjustments',
    checkin: 'Check-in',
    task: 'Tasks',
    weekly_challenge: 'Weekly challenge',
    returned: 'Came back by a refund or reversal',
    lucky_draw: 'Lucky Draw prizes',
    other: 'Other promotions',
  } as const;
  sheets.push({
    sheet: 'Balances (now)',
    columns: widths(56, 18, 10),
    data: [
      [text(`As of ${myt(r.balance_as_of)} (MYT); the period does not apply`)],
      [],
      head(['Line', 'Amount (RM)', 'Cards']),
      bal('Unsold stock (assets)', a.total_sen, a.cards, true),
      ...(a.no_cost_cards > 0
        ? [
            [
              text('  of which have no supplier cost yet'),
              null,
              num(a.no_cost_cards),
            ],
          ]
        : []),
      [],
      bal('  Withdrawable now', fl.wallet.withdrawable_sen),
      bal('  Free credit not used yet', fl.wallet.free_credit_sen),
      ...BONUS_SOURCES.map((s) =>
        bal(`    ${bonus[s]}`, fl.wallet.free_credit_by_source[s]),
      ),
      bal(
        '  Locked cash (still to play through, frozen, or never topped up)',
        fl.wallet.locked_sen,
      ),
      bal('Customer wallets', fl.wallet.total_sen, null, true),
      bal('  Cards in vaults', fl.cards.vault.sen, fl.cards.vault.cards),
      bal(
        '  Cards in orders being processed',
        fl.cards.processing.sen,
        fl.cards.processing.cards,
      ),
      bal('Customer cards', fl.cards.total_sen, null, true),
      bal('Customer floating money', fl.total_sen, null, true),
    ],
  });

  return sheets;
}
