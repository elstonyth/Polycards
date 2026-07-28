import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Button,
  Container,
  Heading,
  Input,
  Label,
  Select,
  Table,
  Text,
  toast,
} from '@medusajs/ui';
import { ArrowLeft, Trash } from '@medusajs/icons';
import {
  useCards,
  useCreatePurchaseInvoice,
  useEligibleProducts,
  useFxRate,
  usePurchaseInvoice,
  usePurchaseInvoices,
} from '../../../lib/queries';
import { rm, usdToMyr } from '../../../lib/format';
import {
  draftError,
  mytMidnightIso,
  mytToday,
  type DraftLine,
} from '../../../lib/purchase-invoice-form';

// ponytail: no config export — a create page belongs behind the list's "New
// invoice" button, not in the sidebar (mirrors [id]/page.tsx).

const NewPurchaseInvoicePage = () => {
  const navigate = useNavigate();
  const [date, setDate] = useState(() => mytToday());
  const [supplier, setSupplier] = useState('');
  const [reversesId, setReversesId] = useState<string | null>(null);
  // Only the PURCHASE lines are state. A reversal's lines are wholly determined
  // by the invoice being reversed, so they are derived below rather than copied
  // into state by an effect — no sync to get wrong, and switching the picker
  // back to "None" restores whatever purchase lines were already staged.
  const [draftLines, setDraftLines] = useState<DraftLine[]>([]);
  const [filter, setFilter] = useState('');

  const { data: cards } = useCards();
  // `true` is REQUIRED — useEligibleProducts takes the enabled flag positionally
  // and there is no default; the picker is always on here, unlike the register
  // modal that gates it on being open.
  const { data: eligible } = useEligibleProducts(true);
  const { data: fxData } = useFxRate();
  const { data: invoicesPage } = usePurchaseInvoices(0);
  const { data: reversalSource } = usePurchaseInvoice(reversesId);
  const create = useCreatePurchaseInvoice();

  // Merged item-search source: registered gacha Cards plus catalog products not
  // yet promoted to a Card. Both lists are already fetched by existing hooks —
  // no new backend code.
  //
  // fmv_snapshot is MYR (purchase-invoice-line.ts), and BOTH sources are USD:
  // AdminCard.market_value is raw USD, so cards use the already-resolved
  // priceBreakdown.marketMyr; EligibleProduct.fmv is raw USD too
  // (admin/gacha/eligible-products emits `num(meta.fmv)` unconverted), so it
  // needs the same conversion — via usdToMyr, which is the mirror of the
  // backend displayMarketPrice the card side already went through, so the two
  // halves of this list are priced identically rather than merely similarly.
  //
  // No hardcoded FX fallback: before the rate loads, usdToMyr(x, 0) is 0, and a
  // silent RM 0.00 prefill on a money record is worse than a row that is not
  // offered yet. Cards are unaffected — their MYR is already server-resolved.
  const fx = fxData?.effective ?? 0;
  const searchable = useMemo(() => {
    const fromCards = (cards ?? []).map((c) => ({
      handle: c.handle,
      name: c.name,
      fmv: c.priceBreakdown.marketMyr,
      kind: 'Card' as const,
    }));
    const cardHandles = new Set(fromCards.map((c) => c.handle));
    const fromEligible =
      fx > 0
        ? (eligible ?? [])
            .filter((p) => !cardHandles.has(p.handle))
            .map((p) => ({
              handle: p.handle,
              name: p.title,
              fmv: usdToMyr(p.fmv ?? 0, fx),
              kind: 'Product' as const,
            }))
        : [];
    return [...fromCards, ...fromEligible];
  }, [cards, eligible, fx]);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return searchable.slice(0, 50);
    return searchable
      .filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          s.handle.toLowerCase().includes(q),
      )
      .slice(0, 50);
  }, [searchable, filter]);

  // Only NON-reversing invoices are offerable. api/.../validate.ts requires
  // every line of a reversing invoice to be negative-qty, and the service
  // refuses reversing a reversal outright — negating an already-negative source
  // line yields a positive qty, so offering one here would only ever 400.
  //
  // ponytail: the picker sees the 50 most recent invoices (one unpaged page,
  // created_at desc). An older invoice is not reversible from this dropdown;
  // add a search box here if that ever bites.
  const reversible = (invoicesPage?.invoices ?? []).filter(
    (inv) => !inv.reverses_invoice_id,
  );

  // The id guard matters: usePurchaseInvoice keeps serving the PREVIOUS
  // invoice's data for a render after the picker changes, and mirroring the
  // wrong invoice's lines is a wrong money record.
  //
  // Number() on the money fields because the detail route spreads ORM rows and
  // money.ts documents bigNumber columns as arriving "BigNumber | numeric string
  // | number"; a string would concatenate in the footer folds below.
  //
  // ponytail: mirrors the FULL original quantity. A partially reversed invoice
  // therefore exceeds its remaining budget and the server refuses it (the
  // reversal budget in service.ts is the authority) — the mutation's onError
  // toast says so. Partial-reversal editing is deliberately not built.
  const reversalLines: DraftLine[] = useMemo(() => {
    if (!reversesId || reversalSource?.invoice.id !== reversesId) return [];
    return reversalSource.invoice.lines.map((l) => ({
      card_handle: l.card_handle,
      card_name: l.card_name,
      fmv_snapshot: String(Number(l.fmv_snapshot)),
      qty: String(-l.qty),
      unit_cost: String(Number(l.unit_cost)),
    }));
  }, [reversesId, reversalSource]);

  // Whichever mode is active owns the body that gets submitted, so a staged
  // purchase line can never ride along on a reversal (which the server rejects
  // per-invoice anyway) or the other way round.
  const lines = reversesId ? reversalLines : draftLines;

  const addLine = (item: { handle: string; name: string; fmv: number }) => {
    // Handle/name/FMV come from the MATCHED item, never from the typed text —
    // card_handle is what the weighted-average cost and the reversal match key
    // off, so a free-typed handle would silently create a second cost bucket.
    setDraftLines((prev) => [
      ...prev,
      {
        card_handle: item.handle,
        card_name: item.name,
        fmv_snapshot: item.fmv.toFixed(2),
        qty: '1',
        unit_cost: item.fmv.toFixed(2),
      },
    ]);
    setFilter('');
  };

  // Both only reachable in purchase mode — a reversal's rows render as text.
  const updateLine = (i: number, patch: Partial<DraftLine>) =>
    setDraftLines((prev) =>
      prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)),
    );
  const removeLine = (i: number) =>
    setDraftLines((prev) => prev.filter((_, idx) => idx !== i));

  // Plain float folds, for exactly the reason the detail page documents: the
  // server caps unit_cost/fmv_snapshot at 2 decimals and forbids mixed-sign
  // lines on one invoice, so every product is a whole number of sen up to float
  // dust with no intra-invoice cancellation, and rm() rounds at 2dp. These are a
  // PREVIEW anyway — the stored numbers are the server's.
  const subtotal = lines.reduce(
    (s, l) => s + Number(l.qty) * Number(l.unit_cost),
    0,
  );
  const totalFmv = lines.reduce(
    (s, l) => s + Number(l.fmv_snapshot) * Number(l.qty),
    0,
  );

  const submit = async () => {
    // Refuse rather than round. Silently snapping an operator's money entry to
    // 2dp is precisely the class of drift Tasks 2 and 3 hardened against, and
    // the server would 400 on it regardless — this only makes the message name
    // the row and the field.
    const problem = draftError(supplier, lines);
    if (problem) {
      toast.error(problem);
      return;
    }
    try {
      const res = await create.mutateAsync({
        // MYT calendar day, not UTC midnight — see mytMidnightIso.
        date: mytMidnightIso(date),
        supplier: supplier.trim(),
        reverses_invoice_id: reversesId,
        lines: lines.map((l) => ({
          card_handle: l.card_handle,
          card_name: l.card_name,
          fmv_snapshot: Number(l.fmv_snapshot),
          qty: Number(l.qty),
          unit_cost: Number(l.unit_cost),
        })),
      });
      navigate(`/purchase-invoices/${res.invoice.id}`);
    } catch {
      // useCreatePurchaseInvoice's onError already toasted the server message
      // (over-reversal, no firm FX rate, ...). This catch only stops the
      // rejection escaping the click handler unhandled — do NOT toast again.
    }
  };

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
          <Heading level="h2">New purchase invoice</Heading>
          <Text className="text-ui-fg-subtle mt-1" size="small">
            Money here is MYR, at most 2 decimals. Recording a receipt raises
            stock and feeds the weighted-average cost for every card on it.
          </Text>

          <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-3">
            <div className="flex flex-col gap-y-2">
              <Label size="small" weight="plus" htmlFor="pi-date">
                Invoice date
              </Label>
              <Input
                id="pi-date"
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
              <Text className="text-ui-fg-muted" size="small">
                Recorded as this Malaysia (MYT) calendar day.
              </Text>
            </div>
            <div className="flex flex-col gap-y-2">
              <Label size="small" weight="plus" htmlFor="pi-supplier">
                Supplier
              </Label>
              <Input
                id="pi-supplier"
                value={supplier}
                maxLength={256}
                placeholder="Who the cards were bought from"
                onChange={(e) => setSupplier(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-y-2">
              <Label size="small" weight="plus">
                Reverses invoice
              </Label>
              <Select
                value={reversesId ?? ''}
                onValueChange={(v) => setReversesId(v || null)}
              >
                <Select.Trigger>
                  <Select.Value placeholder="None — this is a purchase" />
                </Select.Trigger>
                <Select.Content>
                  {reversible.map((inv) => (
                    <Select.Item key={inv.id} value={inv.id}>
                      {inv.display_no} — {inv.supplier}
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select>
              {reversesId ? (
                <Text className="text-ui-fg-muted" size="small">
                  Lines are mirrored from that invoice as negatives and cannot
                  be edited.
                </Text>
              ) : null}
            </div>
          </div>
        </div>

        {!reversesId ? (
          <div className="flex flex-col gap-y-2 border-t px-6 py-4">
            <Label size="small" weight="plus" htmlFor="pi-item-search">
              Add item
            </Label>
            <Input
              id="pi-item-search"
              type="search"
              className="max-w-md"
              placeholder="Search registered cards and catalog products"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            <div className="max-h-64 max-w-md divide-y overflow-y-auto rounded-lg border">
              {visible.map((s) => (
                <button
                  key={`${s.kind}-${s.handle}`}
                  type="button"
                  onClick={() => addLine(s)}
                  className="hover:bg-ui-bg-base-hover flex w-full items-center gap-3 px-4 py-2 text-left"
                >
                  <span className="flex-1 truncate text-sm font-medium">
                    {s.name}
                  </span>
                  <span className="text-ui-fg-muted truncate text-xs">
                    {s.handle}
                  </span>
                  <span className="text-ui-fg-subtle whitespace-nowrap text-xs tabular-nums">
                    {rm(s.fmv)}
                  </span>
                </button>
              ))}
              {visible.length === 0 ? (
                <div className="text-ui-fg-subtle px-4 py-3 text-sm">
                  {searchable.length === 0
                    ? 'No cards or catalog products to add.'
                    : 'No item matches that search.'}
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        {lines.length === 0 ? (
          <div className="border-t px-6 py-8">
            <Text className="text-ui-fg-subtle" size="small">
              {reversesId
                ? 'Loading the invoice being reversed...'
                : 'No lines yet — search above and pick an item.'}
            </Text>
          </div>
        ) : (
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
                    FMV (snapshot)
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
                  <Table.HeaderCell />
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {lines.map((l, i) => (
                  <Table.Row key={`${l.card_handle}-${i}`}>
                    <Table.Cell className="break-words">
                      {l.card_name}
                      <span className="text-ui-fg-muted ml-2 text-xs">
                        {l.card_handle}
                      </span>
                    </Table.Cell>
                    <Table.Cell className="text-right">
                      {reversesId ? (
                        <span className="tabular-nums">
                          {rm(Number(l.fmv_snapshot))}
                        </span>
                      ) : (
                        <Input
                          type="number"
                          // step 0.01 shapes the spinner; it does NOT stop a typed
                          // 1.005 — draftError is what refuses that.
                          step="0.01"
                          min="0"
                          className="w-28 text-right"
                          aria-label={`Line ${i + 1} FMV`}
                          value={l.fmv_snapshot}
                          onChange={(e) =>
                            updateLine(i, { fmv_snapshot: e.target.value })
                          }
                        />
                      )}
                    </Table.Cell>
                    <Table.Cell className="text-right">
                      {reversesId ? (
                        <span className="tabular-nums">{l.qty}</span>
                      ) : (
                        <Input
                          type="number"
                          step="1"
                          className="w-20 text-right"
                          aria-label={`Line ${i + 1} quantity`}
                          value={l.qty}
                          onChange={(e) =>
                            updateLine(i, { qty: e.target.value })
                          }
                        />
                      )}
                    </Table.Cell>
                    <Table.Cell className="text-right">
                      {reversesId ? (
                        <span className="tabular-nums">
                          {rm(Number(l.unit_cost))}
                        </span>
                      ) : (
                        <Input
                          type="number"
                          step="0.01"
                          min="0"
                          className="w-28 text-right"
                          aria-label={`Line ${i + 1} unit cost`}
                          value={l.unit_cost}
                          onChange={(e) =>
                            updateLine(i, { unit_cost: e.target.value })
                          }
                        />
                      )}
                    </Table.Cell>
                    <Table.Cell className="text-right tabular-nums whitespace-nowrap">
                      {rm(Number(l.qty) * Number(l.unit_cost))}
                    </Table.Cell>
                    <Table.Cell className="text-right">
                      {reversesId ? null : (
                        <Button
                          variant="transparent"
                          size="small"
                          aria-label={`Remove line ${i + 1}`}
                          onClick={() => removeLine(i)}
                        >
                          <Trash />
                        </Button>
                      )}
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-end gap-8 border-t px-6 py-4">
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
            <Text className="font-semibold tabular-nums">{rm(subtotal)}</Text>
          </div>
          <Button
            onClick={submit}
            isLoading={create.isPending}
            disabled={create.isPending || lines.length === 0}
          >
            Save invoice
          </Button>
        </div>
      </Container>
    </div>
  );
};

export default NewPurchaseInvoicePage;
