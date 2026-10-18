import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Container, Heading, Table, Text } from '@medusajs/ui';
import type {
  LeadersReport,
  PeriodLeader,
  StatsRange,
} from '../../lib/admin-rest';
import { useLeaders } from '../../lib/queries';
import { rm } from '../../lib/format';

// Top players per period above the Players list (2026-10-15): who topped up
// the most, made the biggest single top-up, withdrew the most and drew the
// most packs. GET /admin/stats/leaders with scope=default, so only real
// customers are ever named, whatever the list's group filter says. "Week" is
// the Dashboard's rolling 7 days.
const PERIODS: [StatsRange, string][] = [
  ['today', 'players.leaders.today'],
  ['7d', 'players.leaders.week'],
  ['month', 'players.leaders.month'],
];

type Kind = keyof LeadersReport['leaders'];

const KINDS: [Kind, string][] = [
  ['topped_up', 'players.leaders.toppedUp'],
  ['biggest_topup', 'players.leaders.biggestTopup'],
  ['withdrawn', 'players.leaders.withdrawn'],
  ['draws', 'players.leaders.draws'],
];

function LeaderCell({ kind, leader }: { kind: Kind; leader: PeriodLeader }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const amount = rm(leader.amount);
  const detail =
    kind === 'draws'
      ? t('players.leaders.packs', { count: leader.count })
      : kind === 'biggest_topup'
        ? amount
        : t(
            kind === 'withdrawn'
              ? 'players.leaders.payouts'
              : 'players.leaders.topups',
            { amount, count: leader.count },
          );
  return (
    <div className="flex min-w-0 max-w-[14rem] flex-col">
      <button
        type="button"
        className="text-ui-fg-interactive truncate text-left hover:underline"
        title={leader.email ?? leader.customer_id}
        onClick={() => navigate(`/customers/${leader.customer_id}`)}
      >
        {leader.name ?? leader.email ?? leader.customer_id}
      </button>
      <Text as="span" size="xsmall" className="text-ui-fg-subtle tabular-nums">
        {detail}
      </Text>
    </div>
  );
}

function PeriodRow({ range, label }: { range: StatsRange; label: string }) {
  const { t } = useTranslation();
  const { data, isError } = useLeaders(range, 'default');
  return (
    <Table.Row>
      <Table.Cell className="txt-compact-small-plus whitespace-nowrap">
        {t(label)}
      </Table.Cell>
      {KINDS.map(([kind]) => {
        const leader = data?.leaders[kind];
        return (
          <Table.Cell key={kind}>
            {leader ? (
              <LeaderCell kind={kind} leader={leader} />
            ) : (
              <span className="text-ui-fg-muted">
                {data ? '—' : isError ? t('players.leaders.loadError') : '…'}
              </span>
            )}
          </Table.Cell>
        );
      })}
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
              {KINDS.map(([kind, label]) => (
                <Table.HeaderCell key={kind}>{t(label)}</Table.HeaderCell>
              ))}
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
