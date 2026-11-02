import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Button,
  Container,
  Heading,
  Input,
  Label,
  Table,
  Text,
  toast,
} from '@medusajs/ui';
import { ArrowLeft, Trash } from '@medusajs/icons';
import { useCreateGoodsReceiveNote } from '../../../lib/queries';
import { rm } from '../../../lib/format';
import {
  grnDraftError,
  mytMidnightIso,
  mytToday,
  type GrnDraftLine,
} from '../../../lib/purchase-invoice-form';
import {
  StockItemSearch,
  StockLineItem,
  type StockSearchItem,
} from '../../../components/StockItemSearch';

// ponytail: no config export — reached from the list's "New GRN" button, not
// the sidebar (mirrors purchase-invoices/new).

// The New purchase invoice form minus the money: a GRN records card, FMV and
// qty only — the cost arrives later with the invoice it is transferred into.
const NewGoodsReceiveNotePage = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [date, setDate] = useState(() => mytToday());
  const [supplier, setSupplier] = useState('');
  const [lines, setLines] = useState<GrnDraftLine[]>([]);
  const create = useCreateGoodsReceiveNote();

  // The picked item's handle/name/FMV, never typed text — see StockItemSearch.
  const addLine = (item: StockSearchItem) =>
    setLines((prev) => [
      ...prev,
      {
        card_handle: item.handle,
        card_name: item.name,
        fmv_snapshot: item.fmv?.toFixed(2) ?? '',
        qty: '1',
      },
    ]);
  const updateLine = (i: number, patch: Partial<GrnDraftLine>) =>
    setLines((prev) =>
      prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)),
    );
  const removeLine = (i: number) =>
    setLines((prev) => prev.filter((_, idx) => idx !== i));

  // Preview only, same float-fold argument as the invoice form: FMV is capped
  // at 2dp and qty is a positive integer, and rm() rounds at 2dp.
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
    // Refuse rather than round — see draftError. Checked BEFORE the try, so
    // mytMidnightIso never throws inside it.
    const problem = grnDraftError(date, supplier, lines);
    if (problem) {
      toast.error(problem);
      return;
    }
    try {
      const res = await create.mutateAsync({
        date: mytMidnightIso(date),
        supplier: supplier.trim(),
        lines: lines.map((l) => ({
          card_handle: l.card_handle,
          card_name: l.card_name,
          fmv_snapshot: Number(l.fmv_snapshot),
          qty: Number(l.qty),
        })),
      });
      navigate(`/goods-receive-notes/${res.goods_receive_note.id}`);
    } catch {
      // The mutation's onError has already toasted the server message; this
      // only stops the rejection escaping the click handler.
    }
  };

  return (
    <div className="flex flex-col gap-y-3">
      <Container className="p-0">
        <div className="px-6 py-4">
          <button
            type="button"
            onClick={() => navigate('/goods-receive-notes')}
            className="text-ui-fg-subtle hover:text-ui-fg-base mb-2 flex items-center gap-1 text-sm"
          >
            <ArrowLeft className="h-4 w-4" />
            {t('grn.back')}
          </button>
          <Heading level="h2">{t('grn.newTitle')}</Heading>
          <Text className="text-ui-fg-subtle mt-1" size="small">
            {t('grn.newSubtitle')}
          </Text>

          <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-3">
            <div className="flex flex-col gap-y-2">
              <Label size="small" weight="plus" htmlFor="grn-date">
                {t('grn.date')}
              </Label>
              <Input
                id="grn-date"
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
              <Text className="text-ui-fg-muted" size="small">
                {t('grn.dateHint')}
              </Text>
            </div>
            <div className="flex flex-col gap-y-2">
              <Label size="small" weight="plus" htmlFor="grn-supplier">
                {t('grn.col.supplier')}
              </Label>
              <Input
                id="grn-supplier"
                value={supplier}
                maxLength={256}
                placeholder={t('grn.supplierPlaceholder')}
                onChange={(e) => setSupplier(e.target.value)}
              />
            </div>
          </div>
        </div>

        <StockItemSearch id="grn-item-search" onPick={addLine} />

        {lines.length === 0 ? (
          <div className="border-t px-6 py-8">
            <Text className="text-ui-fg-subtle" size="small">
              {t('grn.noLines')}
            </Text>
          </div>
        ) : (
          <div
            className="overflow-x-auto border-t [&_input]:scroll-mb-24"
            tabIndex={0}
            role="region"
            aria-label={t('grn.linesLabel')}
          >
            <Table>
              <Table.Header>
                <Table.Row>
                  <Table.HeaderCell>{t('grn.col.item')}</Table.HeaderCell>
                  <Table.HeaderCell className="text-right">
                    {t('grn.col.fmv')}
                  </Table.HeaderCell>
                  <Table.HeaderCell className="text-right">
                    {t('grn.col.qty')}
                  </Table.HeaderCell>
                  <Table.HeaderCell className="text-right">
                    {t('grn.col.lineFmv')}
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
                      <Input
                        type="number"
                        // Shapes the spinner only; grnDraftError refuses 3dp.
                        step="0.01"
                        min="0"
                        className="w-28 text-right"
                        aria-label={t('grn.lineFmv', { n: i + 1 })}
                        value={l.fmv_snapshot}
                        onChange={(e) =>
                          updateLine(i, { fmv_snapshot: e.target.value })
                        }
                      />
                    </Table.Cell>
                    <Table.Cell className="text-right">
                      <Input
                        type="number"
                        step="1"
                        min="1"
                        className="w-20 text-right"
                        aria-label={t('grn.lineQty', { n: i + 1 })}
                        value={l.qty}
                        onChange={(e) => updateLine(i, { qty: e.target.value })}
                      />
                    </Table.Cell>
                    <Table.Cell className="text-right tabular-nums whitespace-nowrap">
                      {rm(Number(l.fmv_snapshot) * Number(l.qty))}
                    </Table.Cell>
                    <Table.Cell className="text-right">
                      <Button
                        variant="transparent"
                        size="small"
                        aria-label={t('grn.removeLine', { n: i + 1 })}
                        onClick={() => removeLine(i)}
                      >
                        <Trash />
                      </Button>
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          </div>
        )}

        {/* Sticky: a long receipt keeps its totals and Save in view. No z-index:
            one would paint it over Radix portals (drawers, selects). */}
        <div className="bg-ui-bg-base sticky bottom-0 flex flex-wrap items-center justify-end gap-8 rounded-b-lg border-t px-6 py-4">
          <div className="text-right">
            <Text className="text-ui-fg-subtle" size="small">
              {t('grn.col.totalQty')}
            </Text>
            <Text className="tabular-nums">{totalQty}</Text>
          </div>
          <div className="text-right">
            <Text className="text-ui-fg-subtle" size="small">
              {t('grn.col.totalFmv')}
            </Text>
            <Text className="font-semibold tabular-nums">{rm(totalFmv)}</Text>
          </div>
          <Button
            onClick={submit}
            isLoading={create.isPending}
            disabled={create.isPending || lines.length === 0}
          >
            {t('grn.save')}
          </Button>
        </div>
      </Container>
    </div>
  );
};

export default NewGoodsReceiveNotePage;
