import { useTranslation } from 'react-i18next';
import { Container, Heading, Text } from '@medusajs/ui';
import type { PnlPackFigures, PnlReport } from '../../lib/admin-rest';
import { Hint } from '../../components/Hint';
import { PackTreeTable, type FooterRow } from './PackTreeTable';
import { sen } from './pnl-format';

const freeCount = (q: Record<string, number>) =>
  Object.values(q).reduce((n, v) => n + v, 0);

/** Pack sales by franchise → type → pack (P&L spec §1). */
export const PackSalesCard = ({ data }: { data: PnlReport['pack_sales'] }) => {
  const { t } = useTranslation();
  const footer: FooterRow[] = [
    ...(data.unattributed.current_sen !== 0
      ? [{ label: t('pnl.packSales.unattributed'), pair: data.unattributed }]
      : []),
    { label: t('pnl.packSales.grandTotal'), pair: data.total, strong: true },
  ];

  return (
    <Container className="pc-settle p-0">
      <div className="px-6 py-4">
        <Heading level="h2">{t('pnl.packSales.title')}</Heading>
        <Text size="small" className="text-ui-fg-subtle mt-1">
          {t('pnl.packSales.subtitle')}
        </Text>
      </div>
      {data.franchises.length === 0 && data.unattributed.current_sen === 0 ? (
        <Text size="small" className="text-ui-fg-subtle border-t px-6 py-6">
          {t('pnl.packSales.empty')}
        </Text>
      ) : (
        <PackTreeTable<PnlPackFigures>
          franchises={data.franchises}
          totalHeader={t('pnl.packSales.total')}
          footer={footer}
          columns={[
            {
              header: t('pnl.packSales.opens'),
              cell: (f) => f.opens.toLocaleString('en-US'),
            },
            {
              header: t('pnl.packSales.paid'),
              cell: (f) => (
                <span className="inline-flex items-center gap-1">
                  {sen(f.paid_sen)}
                  {f.bonus_sen !== 0 && (
                    <Hint
                      text={t('pnl.packSales.bonusHint', {
                        amount: sen(f.bonus_sen),
                      })}
                    />
                  )}
                </span>
              ),
            },
            {
              header: t('pnl.packSales.freeQty'),
              cell: (f) => (
                <span className="inline-flex items-center gap-1">
                  {freeCount(f.free_qty).toLocaleString('en-US')}
                  {freeCount(f.free_qty) !== 0 && (
                    <Hint text={t('pnl.packSales.freeHint', f.free_qty)} />
                  )}
                </span>
              ),
            },
            {
              header: t('pnl.packSales.freeValue'),
              cell: (f) => sen(f.free_sen),
            },
          ]}
        />
      )}
    </Container>
  );
};
