import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button, Container, Heading, Input, Table, Text } from '@medusajs/ui';
import { Plus } from '@medusajs/icons';
import type { RouteConfig } from '@mercurjs/dashboard-sdk';
import { useGoodsReceiveNotes } from '../../lib/queries';
import { orderDateTime, rm } from '../../lib/format';
import { useTableSort } from '../../lib/use-table-sort';
import { Pager } from '../../components/Pager';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';
import { GrnStatusBadge } from './status-badge';

// Placed ABOVE Purchase invoices (rank 3): cards usually arrive before their
// invoice, so the GRN is the first stock record the operator writes.
export const config: RouteConfig = {
  label: 'pcNav.goodsReceiveNotes',
  translationNs: 'translation',
  rank: 2,
  nested: '/inventory/list',
};

// EXACTLY the backend's SORTABLE allow-list (api/admin/goods-receive-notes/
// route.ts); an unknown key silently falls back to created_at server-side.
type SortKey = 'created_at' | 'date' | 'display_no' | 'supplier';

// The route truncates ?q= at 100 chars.
const MAX_Q = 100;

const GoodsReceiveNotesPage = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const { sort, sortHeader } = useTableSort<SortKey>(
    { key: 'created_at', dir: 'desc' },
    { onChange: () => setPage(0) },
  );

  // 300 ms debounce, same as Purchase invoices: the route folds every listed
  // GRN's lines for the totals.
  useEffect(() => {
    const id = setTimeout(() => setQ(search.trim()), 300);
    return () => clearTimeout(id);
  }, [search]);

  const { data, isError } = useGoodsReceiveNotes(
    page,
    q || undefined,
    sort ? `${sort.key}:${sort.dir}` : 'created_at:desc',
  );

  return (
    <div className="flex flex-col gap-y-3">
      <Container className="p-0">
        <div className="flex flex-wrap items-start justify-between gap-4 px-6 py-4">
          <div>
            <Heading level="h2">{t('grn.title')}</Heading>
            <Text className="text-ui-fg-subtle mt-1" size="small">
              {t('grn.subtitle')}
            </Text>
          </div>
          <div className="flex items-center gap-2">
            <Input
              type="search"
              className="w-72"
              maxLength={MAX_Q}
              placeholder={t('grn.searchPlaceholder')}
              aria-label={t('grn.searchPlaceholder')}
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(0);
              }}
            />
            <Button onClick={() => navigate('/goods-receive-notes/new')}>
              <Plus />
              {t('grn.new')}
            </Button>
          </div>
        </div>

        {isError ? (
          <div className="border-t px-6 py-8">
            <Text className="text-ui-fg-subtle">{t('grn.loadError')}</Text>
          </div>
        ) : !data ? (
          // `!data`, not isLoading — keepPreviousData, see Purchase invoices.
          <div className="border-t px-6 py-8">
            <LoadingSkeleton />
          </div>
        ) : data.goods_receive_notes.length === 0 ? (
          <div className="border-t px-6 py-8">
            <Text className="text-ui-fg-subtle">
              {q ? t('grn.noResults') : t('grn.empty')}
            </Text>
          </div>
        ) : (
          <div
            className="overflow-x-auto"
            tabIndex={0}
            role="region"
            aria-label={t('grn.title')}
          >
            <Table>
              <Table.Header>
                <Table.Row>
                  {sortHeader('display_no', t('grn.col.no'))}
                  {sortHeader('date', t('grn.col.date'))}
                  {sortHeader('created_at', t('grn.col.recorded'))}
                  <Table.HeaderCell>{t('grn.col.agent')}</Table.HeaderCell>
                  {sortHeader('supplier', t('grn.col.supplier'))}
                  <Table.HeaderCell>{t('grn.col.status')}</Table.HeaderCell>
                  <Table.HeaderCell className="text-right">
                    {t('grn.col.qty')}
                  </Table.HeaderCell>
                  <Table.HeaderCell className="text-right">
                    {t('grn.col.totalFmv')}
                  </Table.HeaderCell>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {data.goods_receive_notes.map((g) => (
                  <Table.Row
                    key={g.id}
                    className="cursor-pointer"
                    onClick={() => navigate(`/goods-receive-notes/${g.id}`)}
                  >
                    <Table.Cell>
                      {/* Keyboard route into the detail page; stopPropagation
                          keeps the row handler from navigating twice. */}
                      <button
                        type="button"
                        className="text-ui-fg-interactive whitespace-nowrap hover:underline"
                        onClick={(e) => {
                          e.stopPropagation();
                          navigate(`/goods-receive-notes/${g.id}`);
                        }}
                      >
                        {g.display_no}
                      </button>
                    </Table.Cell>
                    <Table.Cell className="whitespace-nowrap">
                      {orderDateTime(g.date)}
                    </Table.Cell>
                    <Table.Cell className="text-ui-fg-subtle whitespace-nowrap">
                      {orderDateTime(g.created_at)}
                    </Table.Cell>
                    <Table.Cell className="text-ui-fg-subtle break-words">
                      {g.agent_email ?? g.agent_user_id}
                    </Table.Cell>
                    <Table.Cell className="break-words">
                      {g.supplier}
                    </Table.Cell>
                    <Table.Cell className="whitespace-nowrap">
                      <GrnStatusBadge status={g.status} />
                      {/* "Transferred → PI-000xx" (spec §2). */}
                      {g.invoice ? (
                        <span className="text-ui-fg-subtle ml-2 text-xs">
                          → {g.invoice.display_no}
                        </span>
                      ) : null}
                    </Table.Cell>
                    <Table.Cell className="text-right tabular-nums">
                      {g.total_qty}
                    </Table.Cell>
                    {/* Server-folded in integer sen — never re-derived here. */}
                    <Table.Cell className="text-right tabular-nums whitespace-nowrap">
                      {rm(g.total_fmv)}
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          </div>
        )}

        {data ? (
          <Pager
            page={page}
            onPage={setPage}
            pageSize={data.limit}
            count={data.goods_receive_notes.length}
            total={data.total}
          />
        ) : null}
      </Container>
    </div>
  );
};

export default GoodsReceiveNotesPage;
