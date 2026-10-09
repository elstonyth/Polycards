import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import type { ICustomerModuleService } from '@medusajs/framework/types';
import { MedusaError, Modules } from '@medusajs/framework/utils';
// write-excel-file 4 is ESM-only to TypeScript: the type comes in with
// resolution-mode 'import' and the value through await import() in GET (the
// full story is in admin/inventory/export.xlsx/route.ts).
import type { Column } from 'write-excel-file/node' with {
  'resolution-mode': 'import',
};
import { PACKS_MODULE } from '../../../../modules/packs';
import { findBank } from '../../../../modules/packs/banks';
import { resolveFxRate } from '../../../../modules/packs/pricing';
import type PacksModuleService from '../../../../modules/packs/service';
import { ledgerTotalsWhere } from '../../finance/queries';
import { reportCallerOf } from '../../require-report-key';
import { customerFilter, reportDb, scopeFilter } from '../../sql';
import { malaysiaDay } from '../top-pulls/day';
import { loadTopPulls } from '../top-pulls/hits';

// ponytail: a ceiling, not a top N. A day has a handful of these pulls; raise
// it if the sheet ever comes back exactly this long.
const MAX_PULL_ROWS = 200;

// GET /reports/growth/daily-report?day: the staff Excel of the Growth desk's
// 12 a.m. drop (spec 2026-10-04-growth-daily-hits-design.md). DEFAULT-group
// players only, on both sheets (partner and other groups left out; the
// operator's call, 2026-10-09). Sheet "Immortal, Legendary, Mythical": every
// paid pull of a card at one of those tiers that day, most valuable first,
// with each player's full details. Sheet "Withdrawals": every withdrawal
// requested that day, any status, with the bank details and the player's
// details.
//
// It carries phone numbers, emails and full bank account numbers, by the
// operator's choice. So it answers the Growth key only (the 12 a.m. cron's
// pre-run script), and no desk bot has a tool for it. The admin Withdrawals
// page masks account numbers in its list; this file does not.

type Customer = {
  username: string;
  last_name: string;
  phone: string;
  email: string;
  joined: string;
  vip_level: number | null;
  balance_myr: number | null;
  deposited_myr: number | null;
  withdrawn_myr: number | null;
};

type PullRow = Customer & {
  rank: number;
  pulled_at: string;
  card: string;
  grade: string;
  rarity: string;
  pack: string;
  value_myr: number;
};

type WithdrawalRow = Customer & {
  requested_at: string;
  status: string;
  amount_myr: number;
  net_myr: number | null;
  bank: string;
  account_number: string;
  account_holder: string;
  failure_reason: string;
  settled_at: string;
};

const MYT_MS = 8 * 60 * 60 * 1000;
/** '2026-09-20 10:00' in Malaysia time; '' for no time. */
const myt = (at: Date | string | null | undefined): string =>
  at
    ? new Date(new Date(at).getTime() + MYT_MS)
        .toISOString()
        .slice(0, 16)
        .replace('T', ' ')
    : '';

const CUSTOMER_COLUMNS: Column<Customer>[] = [
  { header: 'Username', width: 20, cell: (r) => r.username },
  { header: 'Last name', width: 16, cell: (r) => r.last_name },
  { header: 'Phone', width: 16, cell: (r) => r.phone },
  { header: 'Email', width: 28, cell: (r) => r.email },
  { header: 'Joined (MYT)', width: 17, cell: (r) => r.joined },
  { header: 'VIP level', width: 9, cell: (r) => r.vip_level },
  { header: 'Wallet (RM)', width: 12, cell: (r) => r.balance_myr },
  { header: 'Lifetime deposits (RM)', width: 14, cell: (r) => r.deposited_myr },
  {
    header: 'Lifetime withdrawn (RM)',
    width: 14,
    cell: (r) => r.withdrawn_myr,
  },
];

export const PULL_COLUMNS = [
  { header: 'Rank', width: 6, cell: (r: PullRow) => r.rank },
  { header: 'Pulled at (MYT)', width: 17, cell: (r: PullRow) => r.pulled_at },
  { header: 'Card', width: 34, cell: (r: PullRow) => r.card },
  { header: 'Grade', width: 9, cell: (r: PullRow) => r.grade },
  { header: 'Rarity', width: 11, cell: (r: PullRow) => r.rarity },
  { header: 'Pack', width: 18, cell: (r: PullRow) => r.pack },
  { header: 'Pulled value (RM)', width: 14, cell: (r: PullRow) => r.value_myr },
  ...CUSTOMER_COLUMNS,
] as Column<PullRow>[];

export const WITHDRAWAL_COLUMNS = [
  {
    header: 'Requested at (MYT)',
    width: 17,
    cell: (r: WithdrawalRow) => r.requested_at,
  },
  { header: 'Status', width: 10, cell: (r: WithdrawalRow) => r.status },
  {
    header: 'Amount (RM)',
    width: 12,
    cell: (r: WithdrawalRow) => r.amount_myr,
  },
  { header: 'Net paid (RM)', width: 12, cell: (r: WithdrawalRow) => r.net_myr },
  { header: 'Bank', width: 24, cell: (r: WithdrawalRow) => r.bank },
  // Text, never a number: leading zeros and long numbers must survive.
  {
    header: 'Account number',
    width: 18,
    cell: (r: WithdrawalRow) => r.account_number,
  },
  {
    header: 'Account holder',
    width: 24,
    cell: (r: WithdrawalRow) => r.account_holder,
  },
  {
    header: 'Failure reason',
    width: 28,
    cell: (r: WithdrawalRow) => r.failure_reason,
  },
  {
    header: 'Settled at (MYT)',
    width: 17,
    cell: (r: WithdrawalRow) => r.settled_at,
  },
  ...CUSTOMER_COLUMNS,
] as Column<WithdrawalRow>[];

export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  // The Excel is the Growth desk's 12 a.m. file. Since 2026-10-06 every desk
  // reads the same customer details through db_query and admin_read, so the
  // others are pointed there rather than at a file meant for that job.
  if (reportCallerOf(req) !== 'growth') {
    res.status(403).json({
      message:
        "The daily Excel is the Growth desk's 12 a.m. file. For the same figures and customer details, use db_query or admin_read.",
    });
    return;
  }
  const window = malaysiaDay(req.query.day);
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const db = reportDb(req);
  const [pulls, { rows: withdrawals }] = await Promise.all([
    loadTopPulls(req, packs, window, MAX_PULL_ROWS, {
      tiers: ['Immortal', 'Legendary', 'Mythical'],
      defaultGroupOnly: true,
    }),
    db.raw<{
      customer_id: string;
      created_at: string;
      settled_at: string | null;
      status: string;
      amount: string;
      net_amount: string | null;
      bank_code: string;
      account_number: string;
      account_holder_name: string;
      failure_reason: string | null;
    }>(
      'SELECT customer_id, created_at, settled_at, status, amount, net_amount, ' +
        '       bank_code, account_number, account_holder_name, failure_reason ' +
        '  FROM gateway_withdrawal g ' +
        ' WHERE g.deleted_at IS NULL AND g.created_at >= ? AND g.created_at < ? ' +
        scopeFilter({ kind: 'default' }, 'g.customer_id').sql +
        ' ORDER BY g.created_at ASC, g.id ASC',
      [window.from.toISOString(), window.to.toISOString()],
    ),
  ]);

  const ids = [
    ...new Set([
      ...pulls.map((p) => p.customer_id),
      ...withdrawals.map((w) => w.customer_id),
    ]),
  ];
  const details = await customerDetails(req, packs, ids);
  const of = (id: string): Customer =>
    details.get(id) ?? {
      username: '(account gone)',
      last_name: '',
      phone: '',
      email: '',
      joined: '',
      vip_level: null,
      balance_myr: null,
      deposited_myr: null,
      withdrawn_myr: null,
    };

  const pullRows: PullRow[] = pulls.map((p) => ({
    ...of(p.customer_id),
    rank: p.rank,
    pulled_at: myt(p.pulled_at),
    card: p.card.name,
    grade: p.card.grade,
    rarity: p.card.rarity,
    pack: p.pack.title ?? p.pack.slug,
    value_myr: p.value_myr,
  }));
  const withdrawalRows: WithdrawalRow[] = withdrawals.map((w) => ({
    ...of(w.customer_id),
    requested_at: myt(w.created_at),
    status: w.status,
    amount_myr: Number(w.amount),
    net_myr: w.net_amount === null ? null : Number(w.net_amount),
    bank: findBank(w.bank_code)?.name ?? w.bank_code,
    account_number: w.account_number,
    account_holder: w.account_holder_name,
    failure_reason: w.failure_reason ?? '',
    settled_at: myt(w.settled_at),
  }));

  // Several sheets take rows of cells: getSheetData turns the typed columns
  // (header + cell per object) into those rows; widths ride separately.
  const { default: writeXlsxFile, getSheetData } =
    await import('write-excel-file/node');
  const widths = (cols: { width?: number }[]) =>
    cols.map(({ width }) => ({ width }));
  const workbook = await writeXlsxFile([
    {
      data: getSheetData(pullRows, PULL_COLUMNS),
      sheet: 'Immortal, Legendary, Mythical',
      columns: widths(PULL_COLUMNS),
      stickyRowsCount: 1,
    },
    {
      data: getSheetData(withdrawalRows, WITHDRAWAL_COLUMNS),
      sheet: 'Withdrawals',
      columns: widths(WITHDRAWAL_COLUMNS),
      stickyRowsCount: 1,
    },
  ]).toBuffer();
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="polycards-daily-${window.day}.xlsx"`,
  );
  res.send(workbook);
}

/** Each player's contact details and account summary, keyed by customer id.
 *  Bounded by the day's Immortal, Legendary and Mythical pulls and its
 *  withdrawals. */
async function customerDetails(
  req: MedusaRequest,
  packs: PacksModuleService,
  ids: string[],
): Promise<Map<string, Customer>> {
  if (!ids.length) return new Map();
  const customers = req.scope.resolve<ICustomerModuleService>(Modules.CUSTOMER);
  const [rows, overview] = await Promise.all([
    customers.listCustomers(
      { id: ids },
      {
        select: [
          'id',
          'first_name',
          'last_name',
          'email',
          'phone',
          'created_at',
        ],
        take: ids.length,
        withDeleted: true,
      },
    ),
    packs.playersOverview(ids, await resolveFxRate(packs)),
  ]);
  const db = reportDb(req);
  const out = new Map<string, Customer>();
  for (const c of rows) {
    // Lifetime ledger, exactly as the Finance player report counts it.
    const lifetime = await ledgerTotalsWhere(
      db,
      customerFilter(c.id, 'ct.customer_id'),
    );
    out.set(c.id, {
      username: c.first_name ?? '',
      last_name: c.last_name ?? '',
      phone: c.phone ?? '',
      email: c.email ?? '',
      joined: myt(c.created_at),
      vip_level: overview.vipLevel.get(c.id) ?? null,
      balance_myr: (overview.wallet.get(c.id)?.balanceCents ?? 0) / 100,
      deposited_myr: lifetime.topups,
      // cashout is a signed ledger sum: negative = paid out.
      withdrawn_myr: Math.round(-lifetime.cashout * 100) / 100,
    });
  }
  return out;
}
