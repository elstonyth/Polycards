import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Container, Heading, Table, Text } from '@medusajs/ui';
import type {
  PnlCoinFlipSection,
  PnlCount,
  PnlLuckyDrawSection,
  PnlPair,
} from '../../lib/admin-rest';
import { Hint } from '../../components/Hint';
import { sen, vs } from './pnl-format';

const num = (n: number) => n.toLocaleString('en-US');

/** A count's change, signed like `vs`; '—' when there is no previous window. */
const vsCount = (c: PnlCount) => {
  if (c.previous === null) return '—';
  const d = c.current - c.previous;
  return d > 0 ? `+ ${num(d)}` : d < 0 ? `− ${num(-d)}` : '0';
};

/** A line of money (sen) or of a count (tickets, flips, prizes). */
type Line = {
  label: ReactNode;
  strong?: boolean;
  info?: boolean;
} & ({ pair: PnlPair } | { count: PnlCount });

const Head = ({ cells }: { cells: string[] }) => (
  <Table.Header>
    <Table.Row>
      {cells.map((c, i) => (
        <Table.HeaderCell key={i} className={i === 0 ? '' : 'text-right'}>
          {c}
        </Table.HeaderCell>
      ))}
    </Table.Row>
  </Table.Header>
);

const LinesTable = ({
  ns,
  lines,
}: {
  ns: 'coinFlip' | 'luckyDraw';
  lines: Line[];
}) => {
  const { t } = useTranslation();
  return (
    <div className="overflow-x-auto border-t">
      <Table className="whitespace-nowrap">
        <Head
          cells={[
            t(`pnl.${ns}.line`),
            t(`pnl.${ns}.amount`),
            t(`pnl.${ns}.vsPrevious`),
          ]}
        />
        <Table.Body>
          {lines.map((l, i) => (
            <Table.Row key={i} className={l.strong ? 'bg-ui-bg-subtle' : ''}>
              <Table.Cell
                className={
                  l.strong ? 'font-medium' : l.info ? 'text-ui-fg-subtle' : ''
                }
              >
                {l.label}
              </Table.Cell>
              <Table.Cell
                className={`text-right tabular-nums ${l.strong ? 'font-medium' : ''} ${l.info ? 'text-ui-fg-subtle' : ''}`}
              >
                {'pair' in l ? sen(l.pair.current_sen) : num(l.count.current)}
              </Table.Cell>
              <Table.Cell className="text-ui-fg-subtle text-right tabular-nums">
                {'pair' in l ? vs(l.pair) : vsCount(l.count)}
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
    </div>
  );
};

const Title = ({ title, subtitle }: { title: string; subtitle: string }) => (
  <div className="px-6 py-4">
    <Heading level="h2">{title}</Heading>
    <Text size="small" className="text-ui-fg-subtle mt-1">
      {subtitle}
    </Text>
  </div>
);

const add = (a: PnlCount, b: PnlCount): PnlCount => ({
  current: a.current + b.current,
  previous:
    a.previous === null || b.previous === null ? null : a.previous + b.previous,
});

/** Coin flip (P&L spec §3): cards players lost are revenue, credit paid on
 *  wins is COGS. Card bet value and tickets are information beside them. */
export const CoinFlipCard = ({ data }: { data: PnlCoinFlipSection }) => {
  const { t } = useTranslation();
  return (
    <Container className="pc-settle p-0">
      <Title
        title={t('pnl.coinFlip.title')}
        subtitle={t('pnl.coinFlip.subtitle')}
      />
      <LinesTable
        ns="coinFlip"
        lines={[
          {
            label: t('pnl.coinFlip.revenue'),
            pair: data.revenue,
            strong: true,
          },
          {
            label: t('pnl.coinFlip.betValue'),
            pair: data.bet_value,
            info: true,
          },
          {
            label: t('pnl.coinFlip.ticketsStaked'),
            count: add(data.tickets_lost, data.tickets_won),
            info: true,
          },
          { label: t('pnl.coinFlip.ticketsLost'), count: data.tickets_lost },
          { label: t('pnl.coinFlip.cost'), pair: data.cost, strong: true },
          { label: t('pnl.coinFlip.ticketsWon'), count: data.tickets_won },
          { label: t('pnl.coinFlip.flips'), count: data.flips, info: true },
        ]}
      />
    </Container>
  );
};

/** Lucky Draw (P&L spec §4): capsule sales by capsule are revenue, prizes
 *  given are COGS; tickets handed out and spent are counts. */
export const LuckyDrawCard = ({ data }: { data: PnlLuckyDrawSection }) => {
  const { t } = useTranslation();
  return (
    <Container className="pc-settle p-0">
      <Title
        title={t('pnl.luckyDraw.title')}
        subtitle={t('pnl.luckyDraw.subtitle')}
      />
      <div className="overflow-x-auto border-t">
        <Table className="whitespace-nowrap">
          <Head
            cells={[
              t('pnl.luckyDraw.capsule'),
              t('pnl.luckyDraw.spins'),
              t('pnl.luckyDraw.sales'),
              t('pnl.luckyDraw.vsPrevious'),
            ]}
          />
          <Table.Body>
            {data.capsules.map((c) => (
              <Table.Row key={c.slug}>
                <Table.Cell>
                  <div className="flex flex-col py-1">
                    <span>{c.title}</span>
                    <Text size="xsmall" className="text-ui-fg-subtle">
                      {sen(c.price_sen)}
                    </Text>
                  </div>
                </Table.Cell>
                <Table.Cell className="text-right tabular-nums">
                  {num(c.current.spins)}
                </Table.Cell>
                <Table.Cell className="text-right tabular-nums">
                  <span className="inline-flex items-center gap-1">
                    {sen(c.current.sales_sen)}
                    {c.current.bonus_sen > 0 && (
                      <Hint
                        text={t('pnl.luckyDraw.bonusHint', {
                          amount: sen(c.current.bonus_sen),
                        })}
                      />
                    )}
                  </span>
                </Table.Cell>
                <Table.Cell className="text-ui-fg-subtle text-right tabular-nums">
                  {vs({
                    current_sen: c.current.sales_sen,
                    previous_sen: c.previous?.sales_sen ?? null,
                  })}
                </Table.Cell>
              </Table.Row>
            ))}
            <Table.Row className="bg-ui-bg-subtle">
              <Table.Cell className="font-medium">
                {t('pnl.luckyDraw.salesTotal')}
              </Table.Cell>
              <Table.Cell />
              <Table.Cell className="text-right font-medium tabular-nums">
                {sen(data.revenue.current_sen)}
              </Table.Cell>
              <Table.Cell className="text-ui-fg-subtle text-right tabular-nums">
                {vs(data.revenue)}
              </Table.Cell>
            </Table.Row>
          </Table.Body>
        </Table>
      </div>
      <LinesTable
        ns="luckyDraw"
        lines={[
          {
            label: t('pnl.luckyDraw.creditPrizes', {
              count: data.prize_count.credit.current,
            }),
            pair: data.credit_prizes,
          },
          {
            label: t('pnl.luckyDraw.cardPrizes', {
              count: data.prize_count.card.current,
            }),
            pair: data.card_prizes,
          },
          { label: t('pnl.luckyDraw.cost'), pair: data.cost, strong: true },
        ]}
      />
      <div className="overflow-x-auto border-t">
        <Table className="whitespace-nowrap">
          <Head
            cells={[
              t('pnl.luckyDraw.ticketReason'),
              t('pnl.luckyDraw.ticketsGiven'),
              t('pnl.luckyDraw.vsPrevious'),
              t('pnl.luckyDraw.ticketsSpent'),
              t('pnl.luckyDraw.vsPreviousSpent'),
            ]}
          />
          <Table.Body>
            {data.tickets.map((r) => (
              <Table.Row key={r.reason}>
                <Table.Cell>
                  {t(`pnl.luckyDraw.reason.${r.reason}`, {
                    defaultValue: r.reason,
                  })}
                </Table.Cell>
                <Table.Cell className="text-right tabular-nums">
                  {num(r.given.current)}
                </Table.Cell>
                <Table.Cell className="text-ui-fg-subtle text-right tabular-nums">
                  {vsCount(r.given)}
                </Table.Cell>
                <Table.Cell className="text-right tabular-nums">
                  {num(r.spent.current)}
                </Table.Cell>
                <Table.Cell className="text-ui-fg-subtle text-right tabular-nums">
                  {vsCount(r.spent)}
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      </div>
    </Container>
  );
};
