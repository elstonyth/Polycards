import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import type { RouteConfig } from '@mercurjs/dashboard-sdk';
import {
  Button,
  Container,
  Heading,
  Input,
  StatusBadge,
  Table,
  Tabs,
  Text,
} from '@medusajs/ui';
import type {
  AutomationMonitorSnapshot,
  MonitorLeaderboard,
} from '../../../../../packages/api/src/api/utils/automation-monitor-types';
import { rm } from '../../lib/format';

declare const __BACKEND_URL__: string;

export const config: RouteConfig = {
  label: 'pcNav.automation',
  translationNs: 'translation',
  rank: 3,
  nested: '/players',
};

async function readMonitor<T>(path: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(`${__BACKEND_URL__}/admin/automation${path}`, {
    credentials: 'include',
    cache: 'no-store',
    signal,
  });
  if (!response.ok) throw new Error(String(response.status));
  return response.json() as Promise<T>;
}

const MANUAL_REFRESH = {
  retry: false,
  staleTime: Infinity,
  refetchOnMount: 'always',
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
} as const;

export function AutomationPage() {
  const { t } = useTranslation();
  const [tab, setTab] = useState('accounts');
  const [period, setPeriod] = useState<'weekly' | 'alltime'>('weekly');
  const [search, setSearch] = useState('');
  const accounts = useQuery({
    queryKey: ['automation-monitor'],
    queryFn: ({ signal }) => readMonitor<AutomationMonitorSnapshot>('', signal),
    ...MANUAL_REFRESH,
  });
  const leaderboard = useQuery({
    queryKey: ['automation-monitor-leaderboard', period],
    queryFn: ({ signal }) =>
      readMonitor<MonitorLeaderboard>(`/leaderboard?period=${period}`, signal),
    enabled: tab === 'leaderboard',
    ...MANUAL_REFRESH,
  });
  const query = tab === 'accounts' ? accounts : leaderboard;
  const all = accounts.data?.accounts ?? [];
  const filtered = all.filter((account) =>
    `${account.name ?? ''} ${account.email ?? ''}`
      .toLowerCase()
      .includes(search.trim().toLowerCase()),
  );
  const available = all.filter((account) => account.balance !== null);
  const total =
    available.reduce(
      (sum, account) => sum + Math.round(account.balance! * 100),
      0,
    ) / 100;

  return (
    <div className="flex flex-col gap-y-3">
      <Container className="p-0">
        <div className="flex flex-wrap items-start justify-between gap-4 px-6 py-4">
          <div className="space-y-2">
            <Heading level="h1">{t('pcNav.automation')}</Heading>
            <Text size="small" className="text-ui-fg-subtle">
              {t('automationMonitor.subtitle')}
            </Text>
            <div className="flex gap-2">
              <StatusBadge color="blue">
                {t('automationMonitor.readOnly')}
              </StatusBadge>
              <StatusBadge color="grey">
                {t('automationMonitor.notRunning')}
              </StatusBadge>
            </div>
          </div>
          <Button
            variant="secondary"
            isLoading={query.isFetching}
            onClick={() => void query.refetch()}
          >
            {t('automationMonitor.refresh')}
          </Button>
        </div>
        <div className="border-t px-6 py-3">
          <Tabs value={tab} onValueChange={setTab}>
            <Tabs.List aria-label={t('pcNav.automation')}>
              <Tabs.Trigger value="accounts">
                {t('automationMonitor.accounts')}
              </Tabs.Trigger>
              <Tabs.Trigger value="leaderboard">
                {t('automationMonitor.leaderboard')}
              </Tabs.Trigger>
            </Tabs.List>
          </Tabs>
        </div>
      </Container>

      {query.isError && (
        <Container>
          <Text role="alert" className="text-ui-fg-error">
            {t('automationMonitor.loadError')}
          </Text>
        </Container>
      )}

      {tab === 'accounts' ? (
        <>
          <Container className="grid gap-4 sm:grid-cols-3">
            <div>
              <Text size="small" className="text-ui-fg-subtle">
                {t('automationMonitor.loaded')}
              </Text>
              <Heading>{accounts.data ? all.length : '—'}</Heading>
            </div>
            <div>
              <Text size="small" className="text-ui-fg-subtle">
                {t('automationMonitor.totalBalance')}
              </Text>
              <Heading>{accounts.data ? rm(total) : '—'}</Heading>
            </div>
            <div>
              <Text size="small" className="text-ui-fg-subtle">
                {t('automationMonitor.updated')}
              </Text>
              <Text>
                {accounts.data
                  ? new Date(accounts.data.updatedAt).toLocaleString()
                  : '—'}
              </Text>
            </div>
          </Container>
          <Container className="p-0">
            <div className="space-y-2 px-6 py-4">
              <Input
                aria-label={t('automationMonitor.search')}
                placeholder={t('automationMonitor.search')}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              {available.length < all.length && (
                <Text role="status" className="text-ui-fg-error">
                  {t('automationMonitor.unavailable', {
                    count: all.length - available.length,
                  })}
                </Text>
              )}
              <Text size="small" className="text-ui-fg-subtle">
                {t('automationMonitor.manualRefresh')}
              </Text>
            </div>
            <div className="overflow-x-auto">
              <Table>
                <Table.Header>
                  <Table.Row>
                    <Table.HeaderCell>#</Table.HeaderCell>
                    <Table.HeaderCell>
                      {t('automationMonitor.account')}
                    </Table.HeaderCell>
                    <Table.HeaderCell>
                      {t('automationMonitor.email')}
                    </Table.HeaderCell>
                    <Table.HeaderCell>
                      {t('automationMonitor.balance')}
                    </Table.HeaderCell>
                    <Table.HeaderCell>
                      {t('automationMonitor.status')}
                    </Table.HeaderCell>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {filtered.map((account, index) => (
                    <Table.Row key={account.id}>
                      <Table.Cell>{index + 1}</Table.Cell>
                      <Table.Cell>{account.name || '—'}</Table.Cell>
                      <Table.Cell>{account.email || '—'}</Table.Cell>
                      <Table.Cell className="whitespace-nowrap tabular-nums">
                        {account.balance === null ? '—' : rm(account.balance)}
                      </Table.Cell>
                      <Table.Cell>
                        {t(`automationMonitor.states.${account.status}`)}
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table>
            </div>
            {!filtered.length && (
              <Text className="px-6 py-8 text-ui-fg-subtle">
                {t(
                  accounts.isPending
                    ? 'automationMonitor.loading'
                    : 'automationMonitor.noAccounts',
                )}
              </Text>
            )}
          </Container>
        </>
      ) : (
        <Container className="p-0">
          <div className="space-y-2 px-6 py-4">
            <Tabs
              value={period}
              onValueChange={(value) =>
                setPeriod(value as 'weekly' | 'alltime')
              }
            >
              <Tabs.List aria-label={t('automationMonitor.period')}>
                <Tabs.Trigger value="weekly">
                  {t('automationMonitor.weekly')}
                </Tabs.Trigger>
                <Tabs.Trigger value="alltime">
                  {t('automationMonitor.alltime')}
                </Tabs.Trigger>
              </Tabs.List>
            </Tabs>
            <Text size="small" className="text-ui-fg-subtle">
              {t('automationMonitor.boardNote')}
            </Text>
          </div>
          <div className="overflow-x-auto">
            <Table>
              <Table.Header>
                <Table.Row>
                  <Table.HeaderCell>
                    {t('automationMonitor.rank')}
                  </Table.HeaderCell>
                  <Table.HeaderCell>
                    {t('automationMonitor.account')}
                  </Table.HeaderCell>
                  <Table.HeaderCell>
                    {t('automationMonitor.pulledValue')}
                  </Table.HeaderCell>
                  <Table.HeaderCell>
                    {t('automationMonitor.pulls')}
                  </Table.HeaderCell>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {leaderboard.data?.entries.map((entry) => (
                  <Table.Row key={entry.rank}>
                    <Table.Cell>{entry.rank}</Table.Cell>
                    <Table.Cell>{entry.name}</Table.Cell>
                    <Table.Cell className="whitespace-nowrap tabular-nums">
                      {rm(entry.volume)}
                    </Table.Cell>
                    <Table.Cell>{entry.pulls}</Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          </div>
          {!leaderboard.data?.entries.length && (
            <Text className="px-6 py-8 text-ui-fg-subtle">
              {t(
                leaderboard.isPending
                  ? 'automationMonitor.loading'
                  : 'automationMonitor.noEntries',
              )}
            </Text>
          )}
        </Container>
      )}
    </div>
  );
}

export default AutomationPage;
