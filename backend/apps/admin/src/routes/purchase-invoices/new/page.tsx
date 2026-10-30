import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Button,
  Container,
  Drawer,
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
  useCreatePurchaseInvoice,
  useGoodsReceiveNote,
  useOpenGoodsReceiveNotes,
  usePurchaseInvoice,
  usePurchaseInvoices,
} from '../../../lib/queries';
import { orderDateTime, rm } from '../../../lib/format';
import {
  draftError,
  invoiceFormLines,
  mytMidnightIso,
  mytToday,
  type DraftLine,
} from '../../../lib/purchase-invoice-form';
import {
  StockItemSearch,
  StockLineItem,
  type StockSearchItem,
} from '../../../components/StockItemSearch';
import { LoadingSkeleton } from '../../../components/LoadingSkeleton';

// ponytail: no config export — a create page belongs behind the list's "New
// invoice" button, not in the sidebar (mirrors [id]/page.tsx).

const NewPurchaseInvoicePage = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [date, setDate] = useState(() => mytToday());
  // null = not typed since the last GRN pick, so the field shows the picked
  // GRN's supplier — derived, not copied in by an effect, which is what lets a
  // ?from_grn= deep link fill it once the GRN loads.
  const [supplier, setSupplier] = useState<string | null>(null);
  const [reversesId, setReversesId] = useState<string | null>(null);
  // Transfer from goods receive note (spec 2026-10-28). `?from_grn=` is the GRN
  // detail page's "Transfer to purchase invoice" button. Unit costs are keyed
  // by GRN line id, so switching GRNs needs no reset: another GRN's lines have
  // other ids.
  const [fromGrnId, setFromGrnId] = useState<string | null>(
    () => searchParams.get('from_grn') || null,
  );
  const [unitCosts, setUnitCosts] = useState<Record<string, string>>({});
  const [pickerOpen, setPickerOpen] = useState(false);
  // Only the PURCHASE lines are state. A reversal's lines are wholly determined
  // by the invoice being reversed, so they are derived below rather than copied
  // into state by an effect — no sync to get wrong, and switching the picker
  // back to "None" restores whatever purchase lines were already staged.
  const [draftLines, setDraftLines] = useState<DraftLine[]>([]);

  const { data: invoicesPage } = usePurchaseInvoices(0);
  const { data: reversalSource } = usePurchaseInvoice(reversesId);
  const { data: grnData, isError: grnError } = useGoodsReceiveNote(fromGrnId);
  const { data: openGrns, isError: openGrnsError } =
    useOpenGoodsReceiveNotes(pickerOpen);
  const create = useCreatePurchaseInvoice();

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

  // Same id guard as the reversal: useGoodsReceiveNote serves the PREVIOUS
  // GRN for a render after a re-pick. Only an OPEN GRN prefills — a
  // transferred or reversed one would only 400 at save, so a stale deep link
  // gets a message instead of lines.
  const grn =
    grnData?.goods_receive_note.id === fromGrnId
      ? grnData.goods_receive_note
      : undefined;
  const grnLines = fromGrnId ? (grn?.status === 'open' ? grn.lines : []) : null;
  const supplierValue = supplier ?? grn?.supplier ?? '';

  // Whichever mode is active owns the body that gets submitted, so a staged
  // purchase line can never ride along on a reversal or a transfer (which the
  // server rejects per-invoice anyway) or the other way round.
  const lines = reversesId
    ? reversalLines
    : invoiceFormLines(draftLines, grnLines, unitCosts);
  // Card, FMV and qty come from another record in both modes.
  const locked = !!reversesId || !!fromGrnId;

  // The server refuses a transfer AND a reversal on one invoice, so picking
  // either mode clears the other.
  const pickGrn = (id: string) => {
    setFromGrnId(id);
    setReversesId(null);
    setSupplier(null);
    setPickerOpen(false);
  };

  // The picked item's handle/name/FMV, never typed text — see StockItemSearch.
  const addLine = (item: StockSearchItem) => {
    setDraftLines((prev) => [
      ...prev,
      {
        card_handle: item.handle,
        card_name: item.name,
        fmv_snapshot: item.fmv?.toFixed(2) ?? '',
        qty: '1',
        unit_cost: item.fmv?.toFixed(2) ?? '',
      },
    ]);
  };

  // Both only reachable in purchase mode — a reversal's rows render as text.
  const updateLine = (i: number, patch: Partial<DraftLine>) =>
    setDraftLines((prev) =>
      prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)),
    );
  // In transfer mode the unit cost is the only editable field, held per GRN
  // line id; otherwise it is an ordinary draft edit.
  const setUnitCost = (i: number, value: string) => {
    const grnLine = grnLines?.[i];
    if (grnLine) {
      setUnitCosts((prev) => ({ ...prev, [grnLine.id]: value }));
    } else {
      updateLine(i, { unit_cost: value });
    }
  };
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
  // Whole numbers only: a half-typed or fractional qty (refused at save) must
  // not show NaN or float dust in the total.
  const totalQty = lines.reduce((s, l) => {
    const n = Number(l.qty);
    return s + (Number.isInteger(n) ? n : 0);
  }, 0);

  const submit = async () => {
    // Refuse rather than round. Silently snapping an operator's money entry to
    // 2dp is precisely the class of drift Tasks 2 and 3 hardened against, and
    // the server would 400 on it regardless — this only makes the message name
    // the row and the field.
    const problem = draftError(date, supplierValue, lines);
    if (problem) {
      toast.error(problem);
      return;
    }
    try {
      const res = await create.mutateAsync({
        // MYT calendar day, not UTC midnight — see mytMidnightIso.
        date: mytMidnightIso(date),
        supplier: supplierValue.trim(),
        reverses_invoice_id: reversesId,
        from_grn_id: reversesId ? null : fromGrnId,
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
      // What this is FOR: create.mutateAsync's rejection. useCreatePurchaseInvoice's
      // onError has ALREADY toasted the server message (over-reversal, no firm FX
      // rate, ...), so toasting again here would double it — the catch exists only
      // to stop that rejection escaping the click handler unhandled.
      //
      // It is NOT exhaustive, and that is the hazard to respect: anything else
      // thrown in this block lands here SILENTLY. mytMidnightIso used to — a
      // cleared date threw RangeError and the operator got no feedback at all —
      // which is why draftError now rejects the date BEFORE the try. Still
      // reachable and NOT hypothetical: a malformed 2xx body makes
      // `res.invoice.id` throw and it is swallowed exactly the same way.
      // Deliberately not fixed here — add a toast if it ever bites.
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
                value={supplierValue}
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
                onValueChange={(v) => {
                  setReversesId(v || null);
                  if (v) setFromGrnId(null);
                }}
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

          <div className="mt-4 flex flex-wrap items-center gap-3">
            {fromGrnId ? (
              <>
                <Text size="small" weight="plus">
                  {t('grn.transfer.from', { no: grn?.display_no ?? '…' })}
                </Text>
                <Button
                  size="small"
                  variant="secondary"
                  onClick={() => setFromGrnId(null)}
                >
                  {t('grn.transfer.clear')}
                </Button>
                <Text className="text-ui-fg-muted w-full" size="small">
                  {grnError
                    ? t('grn.transfer.loadError')
                    : grn && grn.status !== 'open'
                      ? t('grn.transfer.notOpen', {
                          no: grn.display_no,
                          status: t(`grn.status.${grn.status}`),
                        })
                      : t('grn.transfer.hint')}
                </Text>
              </>
            ) : (
              <Button
                size="small"
                variant="secondary"
                onClick={() => setPickerOpen(true)}
              >
                {t('grn.transfer.button')}
              </Button>
            )}
          </div>
        </div>

        <Drawer open={pickerOpen} onOpenChange={setPickerOpen}>
          <Drawer.Content>
            <Drawer.Header>
              <Drawer.Title>{t('grn.transfer.pickerTitle')}</Drawer.Title>
            </Drawer.Header>
            <Drawer.Body className="overflow-y-auto p-0">
              {openGrnsError ? (
                <Text size="small" className="text-ui-fg-error p-6">
                  {t('grn.loadError')}
                </Text>
              ) : !openGrns ? (
                <div className="p-6">
                  <LoadingSkeleton rows={4} />
                </div>
              ) : openGrns.goods_receive_notes.length === 0 ? (
                <Text size="small" className="text-ui-fg-muted p-6">
                  {t('grn.transfer.noneOpen')}
                </Text>
              ) : (
                <div className="divide-y">
                  {openGrns.goods_receive_notes.map((g) => (
                    <button
                      key={g.id}
                      type="button"
                      onClick={() => pickGrn(g.id)}
                      className="hover:bg-ui-bg-base-hover flex w-full items-center gap-3 px-6 py-3 text-left"
                    >
                      <span className="whitespace-nowrap text-sm font-medium">
                        {g.display_no}
                      </span>
                      <span className="text-ui-fg-subtle flex-1 truncate text-sm">
                        {g.supplier}
                      </span>
                      <span className="text-ui-fg-muted whitespace-nowrap text-xs">
                        {orderDateTime(g.date)}
                      </span>
                      <span className="text-ui-fg-subtle whitespace-nowrap text-xs tabular-nums">
                        {t('grn.qtyN', { n: g.total_qty })}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </Drawer.Body>
          </Drawer.Content>
        </Drawer>

        {!locked ? (
          <StockItemSearch id="pi-item-search" onPick={addLine} />
        ) : null}

        {lines.length === 0 ? (
          <div className="border-t px-6 py-8">
            <Text className="text-ui-fg-subtle" size="small">
              {reversesId
                ? 'Loading the invoice being reversed...'
                : fromGrnId
                  ? grnError
                    ? t('grn.transfer.loadError')
                    : grn
                      ? t('grn.transfer.noLines')
                      : t('grn.transfer.loading')
                  : 'No lines yet — search above and pick an item.'}
            </Text>
          </div>
        ) : (
          <div
            className="overflow-x-auto border-t [&_input]:scroll-mb-24"
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
                    <Table.Cell>
                      <StockLineItem handle={l.card_handle} name={l.card_name} />
                    </Table.Cell>
                    <Table.Cell className="text-right">
                      {locked ? (
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
                      {locked ? (
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
                          onChange={(e) => setUnitCost(i, e.target.value)}
                        />
                      )}
                    </Table.Cell>
                    <Table.Cell className="text-right tabular-nums whitespace-nowrap">
                      {rm(Number(l.qty) * Number(l.unit_cost))}
                    </Table.Cell>
                    <Table.Cell className="text-right">
                      {locked ? null : (
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

        {/* Sticky: a long invoice keeps its totals and Save in view. No z-index:
            one would paint it over Radix portals (drawers, selects). */}
        <div className="bg-ui-bg-base sticky bottom-0 flex flex-wrap items-center justify-end gap-8 rounded-b-lg border-t px-6 py-4">
          <div className="text-right">
            <Text className="text-ui-fg-subtle" size="small">
              Total qty
            </Text>
            <Text className="tabular-nums">{totalQty}</Text>
          </div>
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
