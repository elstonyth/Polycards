import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Container, Heading, Table, Text } from '@medusajs/ui';
import type { StatsRange } from '../../lib/admin-rest';
import { useStats } from '../../lib/queries';
import { rm } from '../../lib/format';

// Real customers per period above the Players list (2026-10-15): who topped up
// the most, and the money in and out. GET /admin/stats with scope=default, so
// the figures are the Dashboard's own (settled gateway payments) and never
// follow the list's group filter. "Week" is the Dashboard's rolling 7 days.
const PERIODS: [StatsRange, string][] = [
  ['today', 'players.leaders.today'],
  ['7d', 'players.leaders.week'],
  ['month', 'players.leaders.month'],
];

function PeriodRow({ range, label }: { range: StatsRange; label: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data, isError } = useStats(range, '', '', 'default');
  const s = data?.current.stats;
  const top = data?.current.top_topup;
  const net = s
    ? Math.round((s.topup_amount - s.withdrawal_amount) * 100) / 100
    : 0;
  const pending = (
    <span className="text-ui-fg-muted">
      {isError ? t('players.leaders.loadError') : '…'}
    </span>
  );
  const money = (amount: number, count: number) => (
    <>
      {rm(amount)} <span className="text-ui-fg-muted text-xs">({count})</span>
    </>
  );

  return (
    <Table.Row>
      <Table.Cell className="txt-compact-small-plus whitespace-nowrap">
        {t(label)}
      </Table.Cell>
      <Table.Cell>
        {!s ? (
          pending
        ) : top ? (
          <div className="flex min-w-0 max-w-[14rem] flex-col">
            <button
              type="button"
              className="text-ui-fg-interactive truncate text-left hover:underline"
              title={top.email ?? top.customer_id}
              onClick={() => navigate(`/customers/${top.customer_id}`)}
            >
              {top.name ?? top.email ?? top.customer_id}
            </button>
            <Text as="span" size="xsmall" className="text-ui-fg-subtle">
              {t('players.leaders.toppedUp', {
                amount: rm(top.amount),
                count: top.count,
              })}
            </Text>
          </div>
        ) : (
          <span className="text-ui-fg-muted">—</span>
        )}
      </Table.Cell>
      <Table.Cell className="text-right tabular-nums whitespace-nowrap">
        {s ? money(s.topup_amount, s.topup_count) : pending}
      </Table.Cell>
      <Table.Cell className="text-right tabular-nums whitespace-nowrap">
        {s ? money(s.withdrawal_amount, s.withdrawal_count) : pending}
      </Table.Cell>
      <Table.Cell
        className={`text-right tabular-nums whitespace-nowrap ${
          net < 0 ? 'text-ui-fg-error' : ''
        }`}
      >
        {s ? rm(net) : pending}
      </Table.Cell>
      <Table.Cell className="text-right tabular-nums">
        {s ? s.signups : pending}
      </Table.Cell>
      <Table.Cell className="text-right tabular-nums">
        {s ? s.topup_customers : pending}
      </Table.Cell>
    </Table.Row>
  );
}

export function PeriodLeaders() {
  const { t } = useTranslation();
  return (
    <Container className="p-0">
      <div className="px-6 py-4">
        <Heading level="h2">{t('players.leaders.title')}</Heading>
        <Text className="text-ui-fg-subtle mt-1" size="small">
          {t('players.leaders.subtitle')}
        </Text>
      </div>
      <div
        className="overflow-x-auto"
        tabIndex={0}
        role="region"
        aria-label={t('players.leaders.title')}
      >
        <Table>
          <Table.Header>
            <Table.Row>
              <Table.HeaderCell>{t('players.leaders.period')}</Table.HeaderCell>
              <Table.HeaderCell>{t('players.leaders.top')}</Table.HeaderCell>
              <Table.HeaderCell className="text-right">
                {t('players.leaders.topups')}
              </Table.HeaderCell>
              <Table.HeaderCell className="text-right">
                {t('players.leaders.withdrawals')}
              </Table.HeaderCell>
              <Table.HeaderCell className="text-right">
                {t('players.leaders.net')}
              </Table.HeaderCell>
              <Table.HeaderCell className="text-right">
                {t('players.leaders.newPlayers')}
              </Table.HeaderCell>
              <Table.HeaderCell className="text-right">
                {t('players.leaders.payingPlayers')}
              </Table.HeaderCell>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {PERIODS.map(([range, label]) => (
              <PeriodRow key={range} range={range} label={label} />
            ))}
          </Table.Body>
        </Table>
      </div>
    </Container>
  );
}
