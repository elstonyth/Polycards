import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Beaker,
  ChartBar,
  FireSolid,
  PlaySolid,
  Robot,
  Trophy,
  Users,
} from '@medusajs/icons';
import type { Permission, RouteConfig } from '@mercurjs/dashboard-sdk';
import { usePermissions } from '@mercurjs/admin';
import {
  Badge,
  Button,
  Container,
  Heading,
  Input,
  Table,
  Tabs,
  Text,
  Textarea,
} from '@medusajs/ui';
import type {
  AutomationMonitorSnapshot,
  MonitorLeaderboard,
} from '../../../../../packages/api/src/api/utils/automation-monitor-types';
import { rm } from '../../lib/format';
import { SandboxPanel } from './sandbox-panel';
import { LivePanel } from './live-panel';
import { OverviewPanel } from './overview-panel';
import { useAutomationActivity } from './use-automation-activity';
import { ago } from './tiers';

declare const __BACKEND_URL__: string;
// Generated, text-free key art (robot arm lifting a sealed pack).
const HERO_ART = new URL('./assets/hero.webp', import.meta.url).href;

// Top-level, not nested under Players: the automation operator role
// (scripts/create-automation-operator.ts) has no player:read, and a nested
// entry only renders under a visible parent.
export const config: RouteConfig = {
  label: 'pcNav.automation',
  translationNs: 'translation',
  icon: Robot,
  rank: 35,
  permissions: ['automation:read' as Permission],
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

async function saveAccounts(emails: string[]): Promise<void> {
  const response = await fetch(`${__BACKEND_URL__}/admin/automation/accounts`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ emails }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new Error(body?.message ?? `Save failed (${response.status}).`);
  }
}

/** Replace the bot account list with the emails typed here (one per line). */
function AccountListEditor({ current }: { current: string[] }) {
  const cache = useQueryClient();
  const [text, setText] = useState<string | null>(null);
  const value = text ?? current.join('\n');
  const emails = value
    .split(/[\s,;]+/)
    .map((email) => email.trim())
    .filter(Boolean);
  const save = useMutation({
    mutationFn: () => saveAccounts(emails),
    onSuccess: () => {
      setText(null);
      for (const key of [
        'automation-monitor',
        'automation-live',
        'automation-activity',
      ])
        void cache.invalidateQueries({ queryKey: [key] });
    },
  });
  return (
    <Container>
      <Heading level="h2">Edit the account list</Heading>
      <Text size="small" className="text-ui-fg-subtle">
        One email per line, up to 80. These accounts can be used in runs and
        rank on the weekly prize board like any other account. Saving replaces
        the whole list.
      </Text>
      <Textarea
        aria-label="Bot account emails"
        className="mt-3 min-h-40 font-mono text-xs"
        value={value}
        onChange={(event) => setText(event.target.value)}
      />
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button
          size="small"
          disabled={text === null || !emails.length || emails.length > 80}
          isLoading={save.isPending}
          onClick={() => save.mutate()}
        >
          Save list
        </Button>
        {text !== null && (
          <Button
            size="small"
            variant="transparent"
            onClick={() => setText(null)}
          >
            Undo changes
          </Button>
        )}
        <Text size="small" className="text-ui-fg-subtle">
          {emails.length} emails
        </Text>
        {save.isError && (
          <Text role="alert" size="small" className="text-ui-fg-error">
            {save.error.message}
          </Text>
        )}
      </div>
    </Container>
  );
}

const MANUAL_REFRESH = {
  retry: false,
  staleTime: Infinity,
  refetchOnMount: 'always',
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
} as const;

const SUBTITLE: Record<string, string> = {
  overview:
    'See what the bot accounts are opening, what they hit, and how runs went.',
  live: 'Start, watch and stop real pack runs on the bot accounts.',
  sandbox: 'Try settings on pretend accounts. No real money moves.',
  accounts:
    'The bot accounts this page can use, with balances and recent activity.',
  leaderboard: 'The public top 10 right now, for reference.',
};

export function AutomationPage() {
  const { t } = useTranslation();
  // Saving the list asks customer:update (api/admin-rbac.ts): the automation
  // operator runs the accounts staff chose but cannot change them.
  const canEditAccounts = usePermissions().hasPermission('customer:update');
  const [tab, setTab] = useState('overview');
  const activity = useAutomationActivity(7);
  const recent = new Map(
    activity.data?.accounts.map((row) => [row.customerId, row]),
  );
  const [period, setPeriod] = useState<'weekly' | 'alltime'>('weekly');
  const [search, setSearch] = useState('');
  const accounts = useQuery({
    queryKey: ['automation-monitor'],
    queryFn: ({ signal }) => readMonitor<AutomationMonitorSnapshot>('', signal),
    enabled: tab === 'accounts',
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
      <Container className="overflow-hidden p-0">
        <div className="relative flex min-h-32 flex-wrap items-start justify-between gap-4 px-6 py-5">
          <img
            src={HERO_ART}
            alt=""
            aria-hidden
            className="pointer-events-none absolute inset-y-0 right-0 h-full w-3/5 object-cover object-[right_32%] opacity-90 [mask-image:linear-gradient(to_right,transparent,black_65%)]"
          />
          <div className="relative space-y-2">
            <Heading level="h1">{t('pcNav.automation')}</Heading>
            <Text size="small" className="text-ui-fg-subtle">
              {SUBTITLE[tab]}
            </Text>
          </div>
          {(tab === 'accounts' || tab === 'leaderboard') && (
            <Button
              variant="secondary"
              className="relative"
              isLoading={query.isFetching}
              onClick={() => void query.refetch()}
            >
              {t('automationMonitor.refresh')}
            </Button>
          )}
        </div>
        <div className="border-t px-6 py-3">
          <Tabs value={tab} onValueChange={setTab}>
            <Tabs.List aria-label={t('pcNav.automation')} className="flex-wrap">
              {(
                [
                  ['overview', ChartBar, 'Overview'],
                  ['live', PlaySolid, 'Live runs'],
                  ['sandbox', Beaker, 'Practice'],
                  ['accounts', Users, t('automationMonitor.accounts')],
                  ['leaderboard', Trophy, t('automationMonitor.leaderboard')],
                ] as const
              ).map(([value, Icon, label]) => (
                <Tabs.Trigger key={value} value={value} className="gap-x-1.5">
                  <Icon aria-hidden />
                  {label}
                </Tabs.Trigger>
              ))}
            </Tabs.List>
          </Tabs>
        </div>
      </Container>

      {(tab === 'accounts' || tab === 'leaderboard') && query.isError && (
        <Container>
          <Text role="alert" className="text-ui-fg-error">
            {t('automationMonitor.loadError')}
          </Text>
        </Container>
      )}

      {tab === 'overview' ? (
        <OverviewPanel />
      ) : tab === 'live' ? (
        <LivePanel />
      ) : tab === 'sandbox' ? (
        <SandboxPanel />
      ) : tab === 'accounts' ? (
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
                    <Table.HeaderCell>Packs (7 days)</Table.HeaderCell>
                    <Table.HeaderCell>Value pulled</Table.HeaderCell>
                    <Table.HeaderCell>Big hits</Table.HeaderCell>
                    <Table.HeaderCell>Last pack</Table.HeaderCell>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {filtered.map((account, index) => {
                    const row = recent.get(account.id);
                    return (
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
                        <Table.Cell className="tabular-nums">
                          {row?.draws ?? 0}
                        </Table.Cell>
                        <Table.Cell className="whitespace-nowrap tabular-nums">
                          {row ? rm(row.valueMyr) : '—'}
                        </Table.Cell>
                        <Table.Cell>
                          {row?.hits ? (
                            <Badge size="2xsmall" color="purple">
                              <FireSolid aria-hidden className="size-3" />
                              {row.hits}
                            </Badge>
                          ) : (
                            <span className="text-ui-fg-muted">—</span>
                          )}
                        </Table.Cell>
                        <Table.Cell className="text-ui-fg-subtle whitespace-nowrap">
                          {row ? ago(row.lastAt) : '—'}
                        </Table.Cell>
                      </Table.Row>
                    );
                  })}
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
          {accounts.data && canEditAccounts && (
            <AccountListEditor
              key={accounts.data.updatedAt}
              current={all.flatMap((account) =>
                account.email ? [account.email] : [],
              )}
            />
          )}
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
