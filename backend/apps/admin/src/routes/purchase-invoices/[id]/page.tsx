import { useNavigate, useParams } from 'react-router-dom';
import { Badge, Container, Heading, Table, Text } from '@medusajs/ui';
import { ArrowLeft } from '@medusajs/icons';
import { usePurchaseInvoice } from '../../../lib/queries';
import { orderDateTime, rm } from '../../../lib/format';
import { LoadingSkeleton } from '../../../components/LoadingSkeleton';

// ponytail: no config export — keeps the route out of sidebar nav (mirrors
// customers/[id] and packs/[slug]).

const PurchaseInvoiceDetailPage = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data, isError } = usePurchaseInvoice(id ?? null);

  const inv = data?.invoice;

  // Re-derived here because the DETAIL route returns lines only — the list
  // route is the one that folds totals server-side, and this page never sees
  // that response. Number() because these are Medusa bigNumber columns, which
  // money.ts documents as arriving "BigNumber | numeric string | number"; a
  // string would make `s + l.line_total` concatenate rather than add.
  //
  // Plain float accumulation is exact enough ONLY because validate.ts caps
  // unit_cost/fmv_snapshot at 2 decimals and forbids mixed-sign lines on one
  // invoice: every line_total is a whole number of sen up to float dust, there
  // is no intra-invoice cancellation, and rm() rounds at 2dp. Widen that cap
  // and this fold has to move to integer sen the way route.ts:155 already did.
  const subtotal =
    inv?.lines.reduce((s, l) => s + Number(l.line_total), 0) ?? 0;
  const totalFmv =
    inv?.lines.reduce((s, l) => s + Number(l.fmv_snapshot) * l.qty, 0) ?? 0;

  return (
    <div className="flex flex-col gap-y-3">
      <Container className="p-0">
        <div className="px-6 py-4">
          <button
            type="button"
            onClick={() => navigate('/purchase-invoices')}
            className="text-ui-fg-subtle hover:text-ui-fg-base mb-2 flex items-center gap-1 text-sm"
          >
            <ArrowLeft className="h-4 w-4" />
            Purchase invoices
          </button>

          {isError ? (
            <Text className="text-ui-fg-subtle">
              Purchase invoice not found.
            </Text>
          ) : !inv ? (
            <LoadingSkeleton />
          ) : (
            <>
              <div className="flex items-center gap-2">
                <Heading level="h2">{inv.display_no}</Heading>
                {inv.reverses_invoice_id ? (
                  <Badge size="2xsmall" color="orange">
                    Reversal
                  </Badge>
                ) : null}
              </div>
              {inv.reverses_invoice_id ? (
                <Text className="text-ui-fg-subtle mt-1" size="small">
                  {/* The id, not the display_no: the detail response carries
                      only the raw fk, and one extra fetch to prettify a value
                      the operator can paste into search is not worth it. */}
                  Reverses invoice {inv.reverses_invoice_id}
                </Text>
              ) : null}

              <div className="mt-4 grid grid-cols-2 gap-4 md:grid-cols-4">
                {/* agent_user_id, not an email: unlike the list route, GET
                    /:id does not join the user module. */}
                {[
                  ['Invoice date', orderDateTime(inv.date)],
                  ['Recorded', orderDateTime(inv.created_at)],
                  ['Supplier', inv.supplier],
                  ['Agent', inv.agent_user_id],
                ].map(([label, value]) => (
                  <div key={label}>
                    <Text size="small" className="text-ui-fg-subtle">
                      {label}
                    </Text>
                    <Text size="small" className="break-words">
                      {value}
                    </Text>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        {inv ? (
          <>
            <div
              className="overflow-x-auto border-t"
              tabIndex={0}
              role="region"
              aria-label="Invoice lines"
            >
              <Table>
                <Table.Header>
                  <Table.Row>
                    <Table.HeaderCell>Item</Table.HeaderCell>
                    <Table.HeaderCell className="text-right">
                      FMV
                    </Table.HeaderCell>
                    <Table.HeaderCell className="text-right">
                      Qty
                    </Table.HeaderCell>
                    <Table.HeaderCell className="text-right">
                      Unit cost
                    </Table.HeaderCell>
                    <Table.HeaderCell className="text-right">
                      Line total
                    </Table.HeaderCell>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {inv.lines.map((l) => (
                    <Table.Row key={l.id}>
                      <Table.Cell className="break-words">
                        {l.card_name}
                        <span className="text-ui-fg-muted ml-2 text-xs">
                          {l.card_handle}
                        </span>
                      </Table.Cell>
                      <Table.Cell className="text-right tabular-nums whitespace-nowrap">
                        {rm(Number(l.fmv_snapshot))}
                      </Table.Cell>
                      <Table.Cell className="text-right tabular-nums">
                        {l.qty}
                      </Table.Cell>
                      <Table.Cell className="text-right tabular-nums whitespace-nowrap">
                        {rm(Number(l.unit_cost))}
                      </Table.Cell>
                      <Table.Cell className="text-right tabular-nums whitespace-nowrap">
                        {rm(Number(l.line_total))}
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table>
            </div>

            <div className="flex justify-end gap-8 border-t px-6 py-4">
              <div className="text-right">
                <Text className="text-ui-fg-subtle" size="small">
                  Total FMV
                </Text>
                <Text className="tabular-nums">{rm(totalFmv)}</Text>
              </div>
              <div className="text-right">
                <Text className="text-ui-fg-subtle" size="small">
                  Subtotal
                </Text>
                <Text className="font-semibold tabular-nums">
                  {rm(subtotal)}
                </Text>
              </div>
            </div>
          </>
        ) : null}
      </Container>
    </div>
  );
};

export default PurchaseInvoiceDetailPage;
