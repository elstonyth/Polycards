import { useTranslation } from 'react-i18next';
import { Container, Heading, Text } from '@medusajs/ui';
import type { PnlCogsFigures, PnlReport } from '../../lib/admin-rest';
import { Hint } from '../../components/Hint';
import { PackTreeTable, type TreeColumn } from './PackTreeTable';
import { CheckMenu } from './ViewMenu';
import { treeMenuOptions, useStoredSet } from './view-prefs';
import { sen } from './pnl-format';

/** COGS by franchise → type → pack (P&L spec §6): buyback paid + supplier
 *  cost of cards shipped. Card value pulled and supplier purchases are
 *  information, not cost. */
export const CogsCard = ({ data }: { data: PnlReport['cogs'] }) => {
  const { t } = useTranslation();
  const [hidden, toggleColumn] = useStoredSet('pnl.columns.cogs');
  const [collapsed, toggleRow] = useStoredSet('pnl.collapsed.cogs');
  const columns: TreeColumn<PnlCogsFigures>[] = [
    {
      id: 'pulls',
      header: t('pnl.cogs.pulls'),
      cell: (f) => f.pulls.toLocaleString('en-US'),
    },
    {
      id: 'pulled',
      header: t('pnl.cogs.pulled'),
      cell: (f) => (
        <span className="text-ui-fg-subtle">{sen(f.pulled_sen)}</span>
      ),
    },
    {
      id: 'buyback',
      header: t('pnl.cogs.buyback'),
      cell: (f) => sen(f.buyback_sen),
    },
    {
      id: 'shipped',
      header: t('pnl.cogs.shipped'),
      cell: (f) => f.shipped_cards.toLocaleString('en-US'),
    },
    {
      id: 'shippedCost',
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
  ];
  const empty = data.franchises.length === 0;

  return (
    <Container className="pc-settle p-0">
      <div className="flex items-start justify-between gap-3 px-6 py-4">
        <div>
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
        {!empty && (
          <CheckMenu
            label={t('pnl.view.columns')}
            options={treeMenuOptions(
              columns,
              t('pnl.cogs.total'),
              t('pnl.packSales.vsPrevious'),
            )}
            hidden={hidden}
            onToggle={toggleColumn}
          />
        )}
      </div>
      {empty ? (
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
          columns={columns}
          hidden={hidden}
          collapsed={collapsed}
          onToggleRow={toggleRow}
        />
      )}
    </Container>
  );
};
