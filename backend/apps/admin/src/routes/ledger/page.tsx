import { Fragment, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Badge,
  Button,
  Container,
  Heading,
  Input,
  Table,
  Text,
} from '@medusajs/ui';
import { ChevronDownMini, ChevronRightMini, Receipt } from '@medusajs/icons';
import type { RouteConfig } from '@mercurjs/dashboard-sdk';
import { useLedger } from '../../lib/queries';
import type { LedgerType } from '../../lib/admin-rest';
import { orderDateTime, rm } from '../../lib/format';
import { useTableSort } from '../../lib/use-table-sort';
import { Pager } from '../../components/Pager';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';

// rank 31 lands between Economy (30) and Weekly Challenge (33), both top-level.
export const config: RouteConfig = {
  label: 'Transactions',
  icon: Receipt,
  rank: 31,
};

// undefined is the "All" tab. WP (challenge settlement) is written by
// settleChallengeWinner (plan 060). RF (referral payout) stays listed but is
// still writerless — Epic 6 (referral payouts) is cancelled, so that filter
// always returns zero rows. It is empty, not broken, so it gets no
// special-case copy.
const TYPES: (LedgerType | undefined)[] = [
  undefined,
  'TP',
  'SP',
  'SE',
  'OD',
  'RF',
  'AD',
  'WP',
  'WD',
];

// Header cells above; the payload expander spans all of them.
const COLUMN_COUNT = 6;

// EXACTLY the backend's sort allow-list (api/admin/ledger/route.ts). Player
// lives in another module and Affect folds two nullable deltas into one cell,
// so neither is server-sortable; those headers stay plain.
type SortKey = 'occurred_at' | 'display_id' | 'type';

// 'TP' -> 'ledger.typeTp'; the All tab -> 'ledger.typeAll'. Shared by the
// filter tabs AND the Type column, so one code can never carry two names.
const typeLabelKey = (tp: LedgerType | undefined): string =>
  `ledger.type${tp ? tp[0] + tp[1].toLowerCase() : 'All'}`;

// One-line summary per row, matching spec §5.4's example ("wallet -RM5,000,
// vault +RM4,000"). The sign is pulled OUT in front of the currency so both
// directions read the same way — `rm(-5000)` alone would render "RM -5,000.00"
// against a "+RM 5,000.00" sibling. A side that is null or zero is dropped, and
// a row that moves neither shows an em-dash rather than an empty cell.
function affectSummary(wallet: number | null, vault: number | null): string {
  const parts: string[] = [];
  const signed = (n: number): string =>
    `${n > 0 ? '+' : '-'}${rm(Math.abs(n))}`;
  if (wallet !== null && wallet !== 0) parts.push(`wallet ${signed(wallet)}`);
  if (vault !== null && vault !== 0) parts.push(`vault ${signed(vault)}`);
  return parts.length ? parts.join(', ') : '—';
}

// The Transactions list (POLYCARD-BACK §5.4) — READ-ONLY by spec: no create,
// edit, delete or export affordance anywhere on this page.
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

  return (
    <div className="flex flex-col gap-y-3">
      <Container className="p-0">
        <div className="flex flex-col gap-4 px-6 py-4">
          <div>
            <Heading level="h2">{t('ledger.title')}</Heading>
            <Text className="text-ui-fg-subtle mt-1" size="small">
              {t('ledger.subtitle')}
            </Text>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* aria-pressed, not variant alone: `primary` vs `secondary` is a
                colour-only cue, so a screen reader had no way to tell which
                type tab was active. Same standard as the payload expander's
                aria-expanded below. */}
            {TYPES.map((tp) => (
              <Button
                key={tp ?? 'all'}
                size="small"
                variant={type === tp ? 'primary' : 'secondary'}
                aria-pressed={type === tp}
                onClick={() => onFilter(() => setType(tp))}
              >
                {t(typeLabelKey(tp))}
              </Button>
            ))}
            <Input
              type="search"
              className="w-72"
              placeholder={t('ledger.searchPlaceholder')}
              aria-label={t('ledger.searchPlaceholder')}
              value={search}
              onChange={(e) => onFilter(() => setSearch(e.target.value))}
            />
            <Input
              type="date"
              className="w-40"
              aria-label={t('ledger.from')}
              value={from}
              onChange={(e) => onFilter(() => setFrom(e.target.value))}
            />
            <Input
              type="date"
              className="w-40"
              aria-label={t('ledger.to')}
              value={to}
              onChange={(e) => onFilter(() => setTo(e.target.value))}
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
                  {sortHeader('display_id', t('ledger.colId'))}
                  {sortHeader('type', t('ledger.colType'))}
                  <Table.HeaderCell>{t('ledger.colPlayer')}</Table.HeaderCell>
                  {sortHeader('occurred_at', t('ledger.colWhen'))}
                  <Table.HeaderCell>{t('ledger.colAffect')}</Table.HeaderCell>
                  <Table.HeaderCell>{t('ledger.colDetails')}</Table.HeaderCell>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {data.entries.map((row) => {
                  const open = expanded.has(row.id);
                  return (
                    // A mapped array needs the KEY ON THE FRAGMENT ITSELF — the
                    // `<>` shorthand cannot carry props, hence the explicit
                    // <Fragment key={...}>.
                    <Fragment key={row.id}>
                      <Table.Row
                        className="cursor-pointer"
                        onClick={() => toggle(row.id)}
                      >
                        <Table.Cell className="font-mono whitespace-nowrap">
                          {row.display_id}
                        </Table.Cell>
                        <Table.Cell>
                          {/* The TRANSLATED label, not the raw 'TP' code: the
                              page ships no legend, and the filter tab for the
                              same value already says "Top-up". Nothing is lost
                              — display_id is TYPE+YY+Q#+serial, so the code is
                              still on the row, one cell to the left. */}
                          <Badge size="2xsmall">
                            {t(typeLabelKey(row.type))}
                          </Badge>
                        </Table.Cell>
                        <Table.Cell className="break-words">
                          {/* Falls back to the EMAIL, not an em-dash: `name` is
                              nullable and a nameless row would otherwise be
                              unidentifiable. Same rule as the players table. */}
                          {row.customer.name ?? row.customer.email}
                        </Table.Cell>
                        <Table.Cell className="text-ui-fg-subtle whitespace-nowrap">
                          {orderDateTime(row.occurred_at)}
                        </Table.Cell>
                        <Table.Cell className="tabular-nums whitespace-nowrap">
                          {affectSummary(row.wallet_delta, row.vault_delta)}
                        </Table.Cell>
                        {/* Real button so the expander is reachable by keyboard
                            too; stopPropagation keeps the row handler from
                            firing a second toggle straight back. */}
                        <Table.Cell onClick={(e) => e.stopPropagation()}>
                          <button
                            type="button"
                            className="text-ui-fg-interactive"
                            aria-expanded={open}
                            aria-label={`${t('ledger.colDetails')} — ${row.display_id}`}
                            onClick={() => toggle(row.id)}
                          >
                            {open ? <ChevronDownMini /> : <ChevronRightMini />}
                          </button>
                        </Table.Cell>
                      </Table.Row>
                      {open && (
                        <Table.Row className="bg-ui-bg-subtle">
                          {/* Plain <td>: Medusa types Table.Cell as
                              HTMLAttributes, which has no colSpan (its runtime
                              <td> forwards it fine), so the spanning cell can't
                              use the component. Same workaround as the packs
                              table's odds expander. */}
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
