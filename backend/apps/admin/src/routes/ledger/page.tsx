import { Fragment, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Badge,
  Button,
  Container,
  Heading,
  Input,
  Popover,
  Select,
  Table,
  Text,
} from '@medusajs/ui';
import { Calendar } from '@medusajs/icons';
import type { RouteConfig } from '@mercurjs/dashboard-sdk';
import { useLedger } from '../../lib/queries';
import type { LedgerType } from '../../lib/admin-rest';
import { rm } from '../../lib/format';
import { useTableSort } from '../../lib/use-table-sort';
import { Pager } from '../../components/Pager';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';
import { groupByDay } from './day-groups';

export const config: RouteConfig = {
  label: 'pcNav.transactions',
  translationNs: 'translation',
  rank: 2,
  nested: '/payments',
};

// WP (challenge settlement) is written by settleChallengeWinner (plan 060); RF
// (the weekly referral commission payout) by payWeeklySettlement. Every type
// here has a writer, so no option is structurally empty.
const TYPES: LedgerType[] = ['TP', 'SP', 'SE', 'OD', 'AD', 'WP', 'WD', 'RF'];

// One colour per kind of movement, so a long day scans by type at a glance:
// money in green, spending blue, sells and prizes purple, cash out orange.
const TYPE_COLOR: Record<
  LedgerType,
  'green' | 'blue' | 'purple' | 'grey' | 'orange'
> = {
  TP: 'green',
  SP: 'blue',
  SE: 'purple',
  OD: 'grey',
  AD: 'orange',
  WP: 'purple',
  WD: 'orange',
  RF: 'green',
};

// Type, Player, Time, Wallet, Vault; day rows and the payload span them all.
const COLUMN_COUNT = 5;

// EXACTLY the backend's sort allow-list (api/admin/ledger/route.ts). Player
// lives in another module, and the two amounts are nullable deltas, so none of
// those is server-sortable; those headers stay plain.
type SortKey = 'occurred_at' | 'display_id' | 'type';

// 'TP' -> 'ledger.typeTp'; all -> 'ledger.typeAll'. Shared by the filter and
// the Type chip, so one code can never carry two names.
const typeLabelKey = (tp: LedgerType | undefined): string =>
  `ledger.type${tp ? tp[0] + tp[1].toLowerCase() : 'All'}`;

const MYT_MS = 8 * 3_600_000;
// '9:12 PM' in Malaysia time, whatever the viewer's timezone.
const mytTime = (iso: string): string => {
  const d = new Date(Date.parse(iso) + MYT_MS);
  const h = d.getUTCHours();
  const m = String(d.getUTCMinutes()).padStart(2, '0');
  return `${h % 12 || 12}:${m} ${h < 12 ? 'AM' : 'PM'}`;
};
// '2026-10-13' -> '13 Oct 2026' (the key is already a MYT day).
const dayLabel = (day: string): string =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString('en-MY', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });

/** A signed amount for one side of a movement; '—' when it did not move. */
const Delta = ({ value }: { value: number | null }) =>
  value === null || value === 0 ? (
    <span className="text-ui-fg-muted">—</span>
  ) : (
    <span className={value > 0 ? 'text-ui-tag-green-text' : ''}>
      {value > 0 ? '+' : '−'}
      {rm(Math.abs(value))}
    </span>
  );

// The Transactions list (POLYCARD-BACK §5.4) — READ-ONLY by spec: no create,
// edit, delete or export affordance anywhere on this page. Layout per spec
// 2026-10-14-admin-finance-pages §7: one filter row, rows grouped by day.
const LedgerPage = () => {
  const { t } = useTranslation();
  const [page, setPage] = useState(0);
  const [type, setType] = useState<LedgerType | undefined>(undefined);
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Sorting resets to page 0 — page 3 of the old order is an arbitrary slice
  // of the new one.
  const { sort, sortHeader } = useTableSort<SortKey>(
    { key: 'occurred_at', dir: 'desc' },
    { onChange: () => setPage(0) },
  );

  // 300 ms debounce (same as the players list) — one keystroke here costs the
  // server a customer-table scan plus a ledger scan.
  useEffect(() => {
    const id = setTimeout(() => setQ(search.trim()), 300);
    return () => clearTimeout(id);
  }, [search]);

  // Blank filters go as undefined, never '': qk.ledger('') and qk.ledger()
  // are DIFFERENT cache keys, so type-then-clear would double-cache every
  // unfiltered page (same trap the players page documents).
  const { data, isError } = useLedger(
    page,
    type,
    q || undefined,
    from || undefined,
    to || undefined,
    sort ? `${sort.key}:${sort.dir}` : 'occurred_at:desc',
  );

  // The date inputs submit plain YYYY-MM-DD and the route reads that as the
  // operator's Asia/Kuala_Lumpur calendar day, so a single-day filter returns
  // that day. Nothing to convert here — see admin-rest.ts listLedger.
  const onFilter = (apply: () => void) => {
    apply();
    setPage(0);
  };

  const toggle = (id: string) => {
    const next = new Set(expanded);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    setExpanded(next);
  };

  // Any active filter — INCLUDING the date range — turns "nothing recorded yet"
  // into "nothing matched". The dates matter most: the ledger is go-forward
  // only (D4, no backfill), so an operator who picks a window from before this
  // shipped legitimately sees zero rows, and "No transactions yet." there would
  // read as data loss.
  const filtered = Boolean(q || type || from || to);
  const dated = Boolean(from || to);

  return (
    <div className="flex flex-col gap-y-3">
      <Container className="p-0">
        <div className="flex flex-wrap items-start justify-between gap-4 px-6 py-4">
          <div>
            <Heading level="h2">{t('ledger.title')}</Heading>
            <Text className="text-ui-fg-subtle mt-1" size="small">
              {t('ledger.subtitle')}
            </Text>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={type ?? 'all'}
              onValueChange={(v) =>
                onFilter(() =>
                  setType(v === 'all' ? undefined : (v as LedgerType)),
                )
              }
            >
              <Select.Trigger
                className="w-40"
                aria-label={t('ledger.typeSelect')}
              >
                <Select.Value />
              </Select.Trigger>
              <Select.Content>
                <Select.Item value="all">{t('ledger.allTypes')}</Select.Item>
                {TYPES.map((tp) => (
                  <Select.Item key={tp} value={tp}>
                    {t(typeLabelKey(tp))}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select>

            <Popover>
              <Popover.Trigger asChild>
                <Button
                  size="base"
                  variant="secondary"
                  aria-label={`${t('ledger.dateFilter')}: ${
                    dated
                      ? t('ledger.dateRange', {
                          from: from || '…',
                          to: to || '…',
                        })
                      : t('ledger.anyDate')
                  }`}
                >
                  <Calendar />
                  {dated
                    ? t('ledger.dateRange', {
                        from: from || '…',
                        to: to || '…',
                      })
                    : t('ledger.anyDate')}
                </Button>
              </Popover.Trigger>
              <Popover.Content className="flex w-64 flex-col gap-3 p-3">
                <div className="flex flex-col gap-1">
                  <Text size="xsmall" className="text-ui-fg-subtle">
                    {t('ledger.from')}
                  </Text>
                  <Input
                    type="date"
                    size="small"
                    aria-label={t('ledger.from')}
                    value={from}
                    onChange={(e) => onFilter(() => setFrom(e.target.value))}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <Text size="xsmall" className="text-ui-fg-subtle">
                    {t('ledger.to')}
                  </Text>
                  <Input
                    type="date"
                    size="small"
                    aria-label={t('ledger.to')}
                    value={to}
                    onChange={(e) => onFilter(() => setTo(e.target.value))}
                  />
                </div>
                {dated ? (
                  <Button
                    size="small"
                    variant="transparent"
                    className="self-end"
                    onClick={() =>
                      onFilter(() => {
                        setFrom('');
                        setTo('');
                      })
                    }
                  >
                    {t('ledger.clearDates')}
                  </Button>
                ) : null}
              </Popover.Content>
            </Popover>

            <Input
              type="search"
              className="w-64"
              placeholder={t('ledger.searchPlaceholder')}
              aria-label={t('ledger.searchPlaceholder')}
              value={search}
              onChange={(e) => onFilter(() => setSearch(e.target.value))}
            />
          </div>
        </div>

        {isError ? (
          <div className="border-t px-6 py-8">
            <Text className="text-ui-fg-subtle">{t('ledger.loadError')}</Text>
          </div>
        ) : !data ? (
          <div className="border-t px-6 py-8">
            <LoadingSkeleton />
          </div>
        ) : data.entries.length === 0 ? (
          <div className="border-t px-6 py-8">
            <Text className="text-ui-fg-subtle">
              {filtered ? t('ledger.noResults') : t('ledger.empty')}
            </Text>
          </div>
        ) : (
          <div
            className="overflow-x-auto"
            tabIndex={0}
            role="region"
            aria-label="Transactions table"
          >
            <Table>
              <Table.Header>
                <Table.Row>
                  {sortHeader('type', t('ledger.colType'))}
                  <Table.HeaderCell>{t('ledger.colPlayer')}</Table.HeaderCell>
                  {sortHeader('occurred_at', t('ledger.colTime'))}
                  <Table.HeaderCell className="text-right">
                    {t('ledger.colWallet')}
                  </Table.HeaderCell>
                  <Table.HeaderCell className="text-right">
                    {t('ledger.colVault')}
                  </Table.HeaderCell>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {groupByDay(data.entries).map((g, gi) => (
                  // Index in the key: a list sorted by type can show the same
                  // day twice (groupByDay never merges them).
                  <Fragment key={`${g.day}-${gi}`}>
                    <Table.Row className="bg-ui-bg-subtle hover:bg-ui-bg-subtle">
                      {/* Plain <td>: Medusa types Table.Cell as
                          HTMLAttributes, which has no colSpan (its runtime
                          <td> forwards it fine). */}
                      <td
                        colSpan={COLUMN_COUNT}
                        className="text-ui-fg-subtle txt-compact-xsmall-plus px-6 py-1.5"
                      >
                        {dayLabel(g.day)}
                      </td>
                    </Table.Row>
                    {g.rows.map((row) => {
                      const open = expanded.has(row.id);
                      return (
                        <Fragment key={row.id}>
                          <Table.Row
                            className="cursor-pointer"
                            onClick={() => toggle(row.id)}
                          >
                            <Table.Cell className="whitespace-nowrap">
                              <Badge
                                size="2xsmall"
                                color={TYPE_COLOR[row.type]}
                              >
                                {t(typeLabelKey(row.type))}
                              </Badge>
                              {/* The ID is the details toggle: a real button,
                                  so keyboard and screen-reader users get the
                                  expander the whole row offers by click.
                                  stopPropagation keeps the row handler from
                                  toggling it straight back. */}
                              <button
                                type="button"
                                aria-expanded={open}
                                aria-label={`${t('ledger.details')} — ${row.display_id}`}
                                className="text-ui-fg-subtle hover:text-ui-fg-base txt-compact-xsmall mt-0.5 block font-mono"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  toggle(row.id);
                                }}
                              >
                                {row.display_id}
                              </button>
                            </Table.Cell>
                            <Table.Cell className="break-words">
                              {/* Falls back to the EMAIL: `name` is nullable
                                  and a nameless row would be unidentifiable. */}
                              {row.customer.name ?? row.customer.email}
                              {row.customer.name ? (
                                <Text
                                  as="span"
                                  size="xsmall"
                                  className="text-ui-fg-subtle block"
                                >
                                  {row.customer.email}
                                </Text>
                              ) : null}
                            </Table.Cell>
                            <Table.Cell className="text-ui-fg-subtle whitespace-nowrap tabular-nums">
                              {mytTime(row.occurred_at)}
                            </Table.Cell>
                            <Table.Cell className="text-right tabular-nums whitespace-nowrap">
                              <Delta value={row.wallet_delta} />
                            </Table.Cell>
                            <Table.Cell className="text-right tabular-nums whitespace-nowrap">
                              <Delta value={row.vault_delta} />
                            </Table.Cell>
                          </Table.Row>
                          {open && (
                            <Table.Row className="bg-ui-bg-subtle">
                              <td colSpan={COLUMN_COUNT} className="px-6 py-2">
                                <pre className="text-ui-fg-subtle text-xs whitespace-pre-wrap">
                                  {JSON.stringify(row.payload, null, 2)}
                                </pre>
                              </td>
                            </Table.Row>
                          )}
                        </Fragment>
                      );
                    })}
                  </Fragment>
                ))}
              </Table.Body>
            </Table>
          </div>
        )}

        {data && (
          <Pager
            page={page}
            onPage={setPage}
            pageSize={data.limit}
            count={data.entries.length}
            total={data.total}
          />
        )}
      </Container>
    </div>
  );
};

export default LedgerPage;
