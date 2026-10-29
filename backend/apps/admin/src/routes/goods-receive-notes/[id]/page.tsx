import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { StockLineItem } from '../../../components/StockItemSearch';
import {
  Button,
  Container,
  Heading,
  Table,
  Text,
  usePrompt,
} from '@medusajs/ui';
import { ArrowLeft } from '@medusajs/icons';
import {
  useGoodsReceiveNote,
  useReverseGoodsReceiveNote,
} from '../../../lib/queries';
import { httpStatus } from '../../../lib/admin-rest';
import { orderDateTime, rm } from '../../../lib/format';
import { LoadingSkeleton } from '../../../components/LoadingSkeleton';
import { GrnStatusBadge } from '../status-badge';

// ponytail: no config export — reached by a row click, kept out of the sidebar
// (mirrors purchase-invoices/[id]).

const GoodsReceiveNoteDetailPage = () => {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const prompt = usePrompt();
  const { data, isError, error } = useGoodsReceiveNote(id ?? null);
  const reverse = useReverseGoodsReceiveNote();

  // Only a 404 means "no such GRN" — a 500 or an expired session is not.
  const notFound = httpStatus(error) === 404;
  const grn = data?.goods_receive_note;
  // Both actions exist only while the GRN waits for its invoice: a transferred
  // GRN is corrected by reversing its invoice, and a reversal is final.
  const open = grn?.status === 'open';

  // Number(): bigNumber column, may arrive as a numeric string.
  const totalFmv =
    grn?.lines.reduce((s, l) => s + Number(l.fmv_snapshot) * l.qty, 0) ?? 0;
  // Server-folded and signed, same as the list row: a reversal is negative.
  const totalQty = grn?.total_qty ?? 0;

  const confirmReverse = async () => {
    if (!grn) return;
    const confirmed = await prompt({
      title: t('grn.reverseTitle', { no: grn.display_no }),
      description: t('grn.reverseDescription'),
      confirmText: t('grn.reverse'),
      cancelText: t('grn.cancel'),
    });
    if (!confirmed) return;
    try {
      await reverse.mutateAsync(grn.id);
    } catch {
      // onError already toasted the server's message.
    }
  };

  const link = (to: string, label: string) => (
    <Link to={to} className="text-ui-fg-interactive hover:underline">
      {label}
    </Link>
  );

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

          {isError ? (
            <Text className="text-ui-fg-subtle">
              {notFound ? t('grn.notFound') : t('grn.detailLoadError')}
            </Text>
          ) : !grn ? (
            <LoadingSkeleton />
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <Heading level="h2">{grn.display_no}</Heading>
                  <GrnStatusBadge status={grn.status} />
                </div>
                {open ? (
                  <div className="flex items-center gap-2">
                    <Button
                      size="small"
                      variant="secondary"
                      onClick={confirmReverse}
                      isLoading={reverse.isPending}
                      disabled={reverse.isPending}
                    >
                      {t('grn.reverse')}
                    </Button>
                    <Button
                      size="small"
                      disabled={reverse.isPending}
                      onClick={() =>
                        navigate(
                          `/purchase-invoices/new?from_grn=${encodeURIComponent(grn.id)}`,
                        )
                      }
                    >
                      {t('grn.transferTo')}
                    </Button>
                  </div>
                ) : null}
              </div>

              {grn.invoice || grn.reversed_by || grn.reverses ? (
                <Text className="text-ui-fg-subtle mt-1" size="small">
                  {grn.invoice
                    ? link(
                        `/purchase-invoices/${grn.invoice.id}`,
                        t('grn.transferredTo', { no: grn.invoice.display_no }),
                      )
                    : null}
                  {grn.reversed_by
                    ? link(
                        `/goods-receive-notes/${grn.reversed_by.id}`,
                        t('grn.reversedBy', { no: grn.reversed_by.display_no }),
                      )
                    : null}
                  {grn.reverses
                    ? link(
                        `/goods-receive-notes/${grn.reverses.id}`,
                        t('grn.reverses', { no: grn.reverses.display_no }),
                      )
                    : null}
                </Text>
              ) : null}

              <div className="mt-4 grid grid-cols-2 gap-4 md:grid-cols-4">
                {[
                  [t('grn.date'), orderDateTime(grn.date)],
                  [t('grn.col.recorded'), orderDateTime(grn.created_at)],
                  [t('grn.col.supplier'), grn.supplier],
                  [t('grn.col.agent'), grn.agent_email ?? grn.agent_user_id],
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

        {grn ? (
          <>
            <div
              className="overflow-x-auto border-t"
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
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {grn.lines.map((l) => (
                    <Table.Row key={l.id}>
                      <Table.Cell>
                        <StockLineItem handle={l.card_handle} name={l.card_name} />
                      </Table.Cell>
                      <Table.Cell className="text-right tabular-nums whitespace-nowrap">
                        {rm(Number(l.fmv_snapshot))}
                      </Table.Cell>
                      {/* Signed: a reversal GRN's lines are negative. */}
                      <Table.Cell className="text-right tabular-nums">
                        {l.qty}
                      </Table.Cell>
                      <Table.Cell className="text-right tabular-nums whitespace-nowrap">
                        {rm(Number(l.fmv_snapshot) * l.qty)}
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table>
            </div>

            <div className="flex flex-wrap items-center justify-end gap-8 border-t px-6 py-4">
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
                <Text className="font-semibold tabular-nums">
                  {rm(totalFmv)}
                </Text>
              </div>
            </div>
          </>
        ) : null}
      </Container>
    </div>
  );
};

export default GoodsReceiveNoteDetailPage;
