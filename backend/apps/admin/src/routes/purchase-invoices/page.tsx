import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Container, Heading, Input, Table, Text } from '@medusajs/ui';
import { Plus, Receipt } from '@medusajs/icons';
import type { RouteConfig } from '@mercurjs/dashboard-sdk';
import { usePurchaseInvoices } from '../../lib/queries';
import { orderDateTime, rm } from '../../lib/format';
import { useTableSort } from '../../lib/use-table-sort';
import { Pager } from '../../components/Pager';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';

// rank 2 puts this under Inventory, right after "Add from PriceCharting" (1).
export const config: RouteConfig = {
  label: 'Purchase Invoices',
  icon: Receipt,
  nested: '/inventory',
  rank: 2,
};

// EXACTLY the backend's SORTABLE allow-list (api/admin/purchase-invoices/
// route.ts). Anything outside it is ignored server-side and falls back to
// created_at rather than 400-ing, so a drift here degrades silently — keep the
// two lists identical.
type SortKey = 'created_at' | 'date' | 'display_no' | 'supplier';

// The route truncates ?q= at 100 chars. Matching the input's maxLength keeps
// the operator from typing a filter the server will never see.
const MAX_Q = 100;

const PurchaseInvoicesPage = () => {
  const navigate = useNavigate();
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  // Sorting resets to page 0: the operator is re-ordering the whole result
  // set, so staying on page 3 of the old order would show an arbitrary slice.
  const { sort, sortHeader } = useTableSort<SortKey>(
    { key: 'created_at', dir: 'desc' },
    { onChange: () => setPage(0) },
  );

  // 300 ms debounce, same as the Players list — this endpoint pages over EVERY
  // matching invoice's lines to fold the money totals, so a request per
  // keystroke is a real cost, not just chatter.
  useEffect(() => {
    const id = setTimeout(() => setQ(search.trim()), 300);
    return () => clearTimeout(id);
  }, [search]);

  // Blank filter passed as undefined, never '' — listPurchaseInvoices omits it
  // from the URL either way, but qk.purchaseInvoices(page, '') and
  // (page, undefined) are DIFFERENT cache keys, so type-then-clear would
  // double-cache every unfiltered page.
  const { data, isError } = usePurchaseInvoices(
    page,
    q || undefined,
    sort ? `${sort.key}:${sort.dir}` : 'created_at:desc',
  );

  return (
    <div className="flex flex-col gap-y-3">
      <Container className="p-0">
        <div className="flex flex-wrap items-start justify-between gap-4 px-6 py-4">
          <div>
            <Heading level="h2">Purchase Invoices</Heading>
            <Text className="text-ui-fg-subtle mt-1" size="small">
              Receiving records. Cost here feeds the Inventory cost column
              (weighted average across every line for a card).
            </Text>
          </div>
          <div className="flex items-center gap-2">
            <Input
              type="search"
              className="w-72"
              maxLength={MAX_Q}
              placeholder="Search invoice no or supplier"
              aria-label="Search invoice no or supplier"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(0);
              }}
            />
            <Button onClick={() => navigate('/purchase-invoices/new')}>
              <Plus />
              New invoice
            </Button>
          </div>
        </div>

        {isError ? (
          <div className="border-t px-6 py-8">
            <Text className="text-ui-fg-subtle">
              Failed to load purchase invoices.
            </Text>
          </div>
        ) : !data ? (
          // Guarded on `!data`, not isLoading: with keepPreviousData the query
          // is never "loading" once a page is in hand, so isLoading would blank
          // the table on the very first fetch only and then stop working.
          <div className="border-t px-6 py-8">
            <LoadingSkeleton />
          </div>
        ) : data.invoices.length === 0 ? (
          <div className="border-t px-6 py-8">
            <Text className="text-ui-fg-subtle">
              {q ? 'No invoices match that search.' : 'No purchase invoices yet.'}
            </Text>
          </div>
        ) : (
          <div
            className="overflow-x-auto"
            tabIndex={0}
            role="region"
            aria-label="Purchase invoices table"
          >
            <Table>
              <Table.Header>
                <Table.Row>
                  {sortHeader('display_no', 'Invoice no')}
                  {sortHeader('date', 'Date')}
                  {sortHeader('created_at', 'Recorded')}
                  <Table.HeaderCell>Agent</Table.HeaderCell>
                  {sortHeader('supplier', 'Supplier')}
                  <Table.HeaderCell className="text-right">
                    Qty
                  </Table.HeaderCell>
                  <Table.HeaderCell className="text-right">
                    Subtotal
                  </Table.HeaderCell>
                  <Table.HeaderCell className="text-right">
                    Total FMV
                  </Table.HeaderCell>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {data.invoices.map((inv) => (
                  <Table.Row
                    key={inv.id}
                    className="cursor-pointer"
                    onClick={() => navigate(`/purchase-invoices/${inv.id}`)}
                  >
                    <Table.Cell>
                      {/* Keyboard route into the detail page; stopPropagation
                          keeps the row handler from navigating a second time. */}
                      <button
                        type="button"
                        className="text-ui-fg-interactive whitespace-nowrap hover:underline"
                        onClick={(e) => {
                          e.stopPropagation();
                          navigate(`/purchase-invoices/${inv.id}`);
                        }}
                      >
                        {inv.display_no}
                      </button>
                      {inv.reverses_invoice_id ? (
                        <span className="text-ui-fg-muted ml-2 text-xs">
                          reversal
                        </span>
                      ) : null}
                    </Table.Cell>
                    <Table.Cell className="whitespace-nowrap">
                      {orderDateTime(inv.date)}
                    </Table.Cell>
                    <Table.Cell className="text-ui-fg-subtle whitespace-nowrap">
                      {orderDateTime(inv.created_at)}
                    </Table.Cell>
                    {/* Falls back to the actor id only when the admin account
                        behind it is gone — the route joins the email. */}
                    <Table.Cell className="text-ui-fg-subtle break-words">
                      {inv.agent_email ?? inv.agent_user_id}
                    </Table.Cell>
                    <Table.Cell className="break-words">
                      {inv.supplier}
                    </Table.Cell>
                    <Table.Cell className="text-right tabular-nums">
                      {inv.total_qty}
                    </Table.Cell>
                    {/* Server-folded in integer sen — never re-derived here. */}
                    <Table.Cell className="text-right tabular-nums whitespace-nowrap">
                      {rm(inv.subtotal)}
                    </Table.Cell>
                    <Table.Cell className="text-right tabular-nums whitespace-nowrap">
                      {rm(inv.total_fmv)}
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
            count={data.invoices.length}
            total={data.total}
          />
        ) : null}
      </Container>
    </div>
  );
};

export default PurchaseInvoicesPage;
