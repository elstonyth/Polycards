import { useTranslation } from 'react-i18next';
import { Container, Heading, Table, Text } from '@medusajs/ui';
import type {
  PnlPair,
  PnlShippingSection,
  PnlTotalsSection,
} from '../../lib/admin-rest';
import { sen, vs } from './pnl-format';

type Line = { label: string; pair: PnlPair; kind?: 'sub' | 'total' | 'result' };

const Lines = ({ lines }: { lines: Line[] }) => {
  const { t } = useTranslation();
  return (
    <div className="overflow-x-auto border-t">
      <Table className="whitespace-nowrap">
        <Table.Header>
          <Table.Row>
            <Table.HeaderCell>{t('pnl.totals.line')}</Table.HeaderCell>
            <Table.HeaderCell className="text-right">
              {t('pnl.totals.amount')}
            </Table.HeaderCell>
            <Table.HeaderCell className="text-right">
              {t('pnl.packSales.vsPrevious')}
            </Table.HeaderCell>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {lines.map((l) => (
            <Table.Row
              key={l.label}
              className={l.kind === 'sub' ? '' : 'bg-ui-bg-subtle'}
            >
              <Table.Cell
                className={
                  l.kind === 'sub' ? 'text-ui-fg-subtle' : 'font-medium'
                }
              >
                {/* Indent inside the cell: Table.Cell's own padding wins over pl-*. */}
                <span className={l.kind === 'sub' ? 'pl-4' : ''}>
                  {l.label}
                </span>
              </Table.Cell>
              <Table.Cell
                className={`text-right tabular-nums ${
                  l.kind === 'result'
                    ? l.pair.current_sen < 0
                      ? 'text-ui-fg-error font-medium'
                      : 'font-medium'
                    : l.kind === 'sub'
                      ? ''
                      : 'font-medium'
                }`}
              >
                {sen(l.pair.current_sen)}
              </Table.Cell>
              <Table.Cell className="text-ui-fg-subtle text-right tabular-nums">
                {vs(l.pair)}
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
    </div>
  );
};

/** Shipping, other revenue (P&L spec §5): charge and insurance. */
export const ShippingCard = ({ data }: { data: PnlShippingSection }) => {
  const { t } = useTranslation();
  return (
    <Container className="pc-settle p-0">
      <div className="px-6 py-4">
        <Heading level="h2">{t('pnl.shipping.title')}</Heading>
        <Text size="small" className="text-ui-fg-subtle mt-1">
          {t('pnl.shipping.subtitle', { count: data.orders.current })}
        </Text>
      </div>
      <Lines
        lines={[
          { label: t('pnl.shipping.charge'), pair: data.shipping, kind: 'sub' },
          {
            label: t('pnl.shipping.insurance'),
            pair: data.insurance,
            kind: 'sub',
          },
          { label: t('pnl.shipping.total'), pair: data.total, kind: 'total' },
        ]}
      />
    </Container>
  );
};

/** The bottom line (P&L spec §8): revenue → gross → net. */
export const TotalsCard = ({ data }: { data: PnlTotalsSection }) => {
  const { t } = useTranslation();
  const part = (group: string, key: string, pair: PnlPair): Line => ({
    label: t(`pnl.totals.parts.${group}.${key}`, { defaultValue: key }),
    pair,
    kind: 'sub',
  });
  const group = (g: 'revenue' | 'other_revenue' | 'cogs') =>
    Object.entries(data.parts[g]).map(([k, p]) => part(g, k, p));
  return (
    <Container className="pc-settle p-0">
      <div className="px-6 py-4">
        <Heading level="h2">{t('pnl.totals.title')}</Heading>
        <Text size="small" className="text-ui-fg-subtle mt-1">
          {t('pnl.totals.subtitle')}
        </Text>
      </div>
      <Lines
        lines={[
          ...group('revenue'),
          { label: t('pnl.totals.revenue'), pair: data.revenue, kind: 'total' },
          ...group('other_revenue'),
          {
            label: t('pnl.totals.otherRevenue'),
            pair: data.other_revenue,
            kind: 'total',
          },
          {
            label: t('pnl.totals.totalRevenue'),
            pair: data.total_revenue,
            kind: 'total',
          },
          ...group('cogs'),
          { label: t('pnl.totals.cogs'), pair: data.cogs, kind: 'total' },
          { label: t('pnl.totals.gross'), pair: data.gross, kind: 'result' },
          {
            label: t('pnl.totals.marketing'),
            pair: data.marketing,
            kind: 'total',
          },
          { label: t('pnl.totals.net'), pair: data.net, kind: 'result' },
        ]}
      />
    </Container>
  );
};
