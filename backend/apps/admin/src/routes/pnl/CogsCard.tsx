import { useTranslation } from 'react-i18next';
import { Container, Heading, Text } from '@medusajs/ui';
import type { PnlCogsFigures, PnlReport } from '../../lib/admin-rest';
import { Hint } from '../../components/Hint';
import { PackTreeTable } from './PackTreeTable';
import { sen } from './pnl-format';

/** COGS by franchise → type → pack (P&L spec §6): buyback paid + supplier
 *  cost of cards shipped. Card value pulled and supplier purchases are
 *  information, not cost. */
export const CogsCard = ({ data }: { data: PnlReport['cogs'] }) => {
  const { t } = useTranslation();
  return (
    <Container className="pc-settle p-0">
      <div className="px-6 py-4">
        <Heading level="h2">{t('pnl.cogs.title')}</Heading>
        <Text size="small" className="text-ui-fg-subtle mt-1">
          {t('pnl.cogs.subtitle')}
        </Text>
        {data.estimated_cards > 0 && (
          <Text size="small" className="text-ui-fg-subtle mt-1">
            {t('pnl.cogs.estimatedNote', { count: data.estimated_cards })}
          </Text>
        )}
      </div>
      {data.franchises.length === 0 ? (
        <Text size="small" className="text-ui-fg-subtle border-t px-6 py-6">
          {t('pnl.cogs.empty')}
        </Text>
      ) : (
        <PackTreeTable<PnlCogsFigures>
          franchises={data.franchises}
          totalHeader={t('pnl.cogs.total')}
          footer={[
            { label: t('pnl.cogs.grandTotal'), pair: data.total, strong: true },
            { label: t('pnl.cogs.pulledTotal'), pair: data.pulled },
            { label: t('pnl.cogs.purchases'), pair: data.purchase },
          ]}
          columns={[
            {
              header: t('pnl.cogs.pulls'),
              cell: (f) => f.pulls.toLocaleString('en-US'),
            },
            {
              header: t('pnl.cogs.pulled'),
              cell: (f) => (
                <span className="text-ui-fg-subtle">{sen(f.pulled_sen)}</span>
              ),
            },
            { header: t('pnl.cogs.buyback'), cell: (f) => sen(f.buyback_sen) },
            {
              header: t('pnl.cogs.shipped'),
              cell: (f) => f.shipped_cards.toLocaleString('en-US'),
            },
            {
              header: t('pnl.cogs.shippedCost'),
              cell: (f) => (
                <span className="inline-flex items-center gap-1">
                  {sen(f.shipped_cost_sen)}
                  {f.estimated_cards > 0 && (
                    <Hint
                      text={t('pnl.cogs.estimatedHint', {
                        count: f.estimated_cards,
                      })}
                    />
                  )}
                </span>
              ),
            },
          ]}
        />
      )}
    </Container>
  );
};
