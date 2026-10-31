import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Container,
  Heading,
  Input,
  Label,
  StatusBadge,
  Table,
  Text,
} from '@medusajs/ui';
import type { AutomationConfig } from '../../../../../packages/api/src/api/utils/automation-types';
import type { SandboxSnapshot } from '../../../../../packages/api/src/api/utils/automation-sandbox-types';
import { DEFAULT_CONFIG, RunSettings } from './run-settings';
import { configForProfiles } from './rank-target-draft';
import { orderDateTime } from '../../lib/format';

declare const __BACKEND_URL__: string;
const KEY = ['automation-sandbox'];
const credits = (cents: number) =>
  (cents / 100).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
const date = (value: number | null) =>
  value === null ? '—' : orderDateTime(value);

async function requestSandbox(
  action?: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<SandboxSnapshot> {
  const response = await fetch(`${__BACKEND_URL__}/admin/automation/sandbox`, {
    method: action ? 'POST' : 'GET',
    credentials: 'include',
    cache: 'no-store',
    signal,
    ...(action
      ? {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(action),
        }
      : {}),
  });
  const body: unknown = await response.json();
  if (!response.ok)
    throw new Error(
      body &&
        typeof body === 'object' &&
        'message' in body &&
        typeof body.message === 'string'
        ? body.message
        : `Request failed (${response.status}).`,
    );
  return body as SandboxSnapshot;
}

export function SandboxPanel() {
  const cache = useQueryClient();
  const [draft, setDraft] = useState<AutomationConfig | null>(null);
  const [selectedOverride, setSelected] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [count, setCount] = useState(80);
  const [bonus, setBonus] = useState(100);
  const [localError, setLocalError] = useState('');
  const query = useQuery({
    queryKey: KEY,
    queryFn: ({ signal }) => requestSandbox(undefined, signal),
    retry: false,
    refetchInterval: (query) => {
      const state = query.state.data;
      if (state?.status !== 'running') return false;
      return state.nextRunAt && state.nextRunAt - Date.now() > 15000
        ? 10000
        : 2000;
    },
    refetchIntervalInBackground: false,
  });
  const action = useMutation({
    mutationFn: (input: Record<string, unknown>) => requestSandbox(input),
    onMutate: () => {
      setLocalError('');
      return cache.cancelQueries({ queryKey: KEY });
    },
    onSuccess: (snapshot, input) => {
      cache.setQueryData(KEY, snapshot);
      if (['save', 'run', 'create_profiles'].includes(String(input.action))) {
        setDraft(snapshot.config);
        setDirty(false);
        setSelected(
          snapshot.selectedProfileIds.length === 1
            ? snapshot.selectedProfileIds[0]
            : 'all',
        );
      }
    },
    onSettled: () => cache.invalidateQueries({ queryKey: KEY }),
  });
  const snapshot = query.data;
  const selected =
    selectedOverride ??
    (snapshot?.selectedProfileIds.length === 1
      ? snapshot.selectedProfileIds[0]
      : 'all');
  const visibleConfig = draft ?? snapshot?.config ?? DEFAULT_CONFIG;
  const profiles = snapshot?.profiles ?? [];
  const ids = profiles
    .filter((profile) => selected === 'all' || selected === profile.id)
    .map((profile) => profile.id);
  const active =
    snapshot?.status === 'running' || snapshot?.status === 'paused';
  const disabled = !snapshot || active || action.isPending;
  const run = (kind: 'save' | 'run') => {
    if (!snapshot) return;
    const config = configForProfiles(visibleConfig, selected);
    if (visibleConfig.rankTargets?.length && !config.rankTargets?.length) {
      setLocalError(
        'This profile has no leaderboard target. Select all profiles or an account with a target.',
      );
      return;
    }
    action.mutate({ action: kind, config, profileIds: ids });
  };
  const error =
    localError ||
    action.error?.message ||
    query.error?.message ||
    snapshot?.error;
  const current = snapshot?.results.find(
    (result) => result.status === 'waiting' || result.status === 'queued',
  );

  return (
    <div className="space-y-3">
      <Container className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-2">
            <Heading level="h2">Practice runs</Heading>
            <Text size="small" className="max-w-3xl text-ui-fg-subtle">
              Pretend accounts, pretend credit and sample cards. Try settings
              here first: nothing touches real balances, real cards or the
              public leaderboard.
            </Text>
          </div>
          <StatusBadge
            color={
              snapshot?.status === 'running'
                ? 'blue'
                : snapshot?.status === 'failed'
                  ? 'red'
                  : 'grey'
            }
          >
            {snapshot?.status ?? 'Loading'}
          </StatusBadge>
        </div>
        <Text size="small">
          {profiles.length} / 80 pretend accounts · one pack at a time · keeps
          going when you close this page.
        </Text>
        {profiles.length < 80 && (
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-2">
              <Label htmlFor="sandbox-count">New test profiles</Label>
              <Input
                id="sandbox-count"
                type="number"
                min={1}
                max={80 - profiles.length}
                value={Number.isFinite(count) ? count : ''}
                disabled={disabled}
                onChange={(event) =>
                  setCount(
                    event.target.value === ''
                      ? Number.NaN
                      : Number(event.target.value),
                  )
                }
              />
            </div>
            <Button
              variant="secondary"
              disabled={disabled}
              onClick={() =>
                action.mutate({ action: 'create_profiles', count })
              }
            >
              Create test profiles
            </Button>
            <Text size="small" className="text-ui-fg-subtle">
              Each starts with 100 nonredeemable test credits. No passwords or
              browser IDs.
            </Text>
          </div>
        )}
        {error && (
          <Text role="alert" className="text-ui-fg-error">
            {error}
          </Text>
        )}
      </Container>

      <Container className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <Heading level="h2">Run controls</Heading>
            <Text size="small" className="mt-1 text-ui-fg-subtle">
              {dirty
                ? 'Unsaved configuration. Save settings or Start to apply it.'
                : 'Configuration saved. Opening this page never starts a run.'}
            </Text>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              disabled={disabled || !ids.length}
              onClick={() => run('save')}
            >
              Save settings
            </Button>
            {!active && (
              <Button
                disabled={disabled || !ids.length}
                isLoading={
                  action.isPending && action.variables?.action === 'run'
                }
                onClick={() => run('run')}
              >
                Start test
              </Button>
            )}
            {active && (
              <>
                <Button
                  variant="secondary"
                  disabled={action.isPending}
                  onClick={() =>
                    action.mutate({
                      action: snapshot.status === 'paused' ? 'resume' : 'pause',
                    })
                  }
                >
                  {snapshot.status === 'paused' ? 'Resume' : 'Pause'}
                </Button>
                <Button
                  variant="danger"
                  disabled={action.isPending}
                  onClick={() => action.mutate({ action: 'stop' })}
                >
                  Stop
                </Button>
              </>
            )}
            <Button
              variant="transparent"
              disabled={action.isPending || query.isFetching}
              onClick={() => void query.refetch()}
            >
              Refresh
            </Button>
          </div>
        </div>
        <div role="status" aria-live="polite" className="space-y-1">
          <Text>
            {snapshot?.completedCycles ?? 0} cycles settled ·{' '}
            {credits(snapshot?.spentCents ?? 0)} test credits spent
          </Text>
          {current && (
            <Text size="small">
              {current.profileName} ·{' '}
              {current.waitReason || 'Waiting for worker'}
              {current.scheduleLabel ? ` · ${current.scheduleLabel}` : ''}
            </Text>
          )}
          {active && (
            <Text size="small" className="text-ui-fg-subtle">
              Next worker check: {date(snapshot?.nextRunAt ?? null)}. Timing is
              a minimum interval; worker load can delay it.
            </Text>
          )}
          {snapshot?.config.humanizedTestClock && (
            <Text size="small" className="text-ui-fg-subtle">
              Accelerated test clock: {date(snapshot?.clockAt ?? null)}. Only
              simulated waiting is skipped.
            </Text>
          )}
        </div>
        <details className="border-t pt-4">
          <summary className="cursor-pointer text-sm font-medium">
            Test bonus credits
          </summary>
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <div className="space-y-2">
              <Label htmlFor="sandbox-bonus">
                Credits per selected profile
              </Label>
              <Input
                id="sandbox-bonus"
                type="number"
                min={1}
                max={8000}
                step="0.01"
                disabled={disabled}
                value={Number.isFinite(bonus) ? bonus : ''}
                onChange={(event) =>
                  setBonus(
                    event.target.value === ''
                      ? Number.NaN
                      : Number(event.target.value),
                  )
                }
              />
            </div>
            <Button
              variant="secondary"
              disabled={disabled || !ids.length}
              onClick={() =>
                action.mutate({
                  action: 'bonus',
                  amount: bonus,
                  profileIds: ids,
                })
              }
            >
              Add test bonus to {ids.length} profiles
            </Button>
          </div>
          <Text size="small" className="mt-2 text-ui-fg-subtle">
            Bonus is spent first. Simulated sale proceeds return to normal test
            credits. No withdrawals or transfers.
          </Text>
        </details>
      </Container>

      <RunSettings
        config={visibleConfig}
        disabled={disabled || profiles.length === 0}
        profiles={profiles}
        selectedProfile={selected}
        onChange={(config) => {
          setDraft(config);
          setDirty(true);
        }}
        onSelectProfile={(id) => {
          setSelected(id);
          setDirty(true);
        }}
      />

      <Container className="space-y-4">
        <Heading level="h2">Profiles and latest results</Heading>
        <div className="overflow-x-auto">
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.HeaderCell>Test profile</Table.HeaderCell>
                <Table.HeaderCell>Wallet / bonus</Table.HeaderCell>
                <Table.HeaderCell>Pull / sell / balance check</Table.HeaderCell>
                <Table.HeaderCell>Schedule / target</Table.HeaderCell>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {profiles.map((profile) => {
                const result = snapshot?.results.find(
                  (entry) => entry.profileId === profile.id,
                );
                const cycle = result?.cycles.at(-1);
                return (
                  <Table.Row key={profile.id}>
                    <Table.Cell className="min-w-36">
                      {profile.name}
                      <Text size="small" className="text-ui-fg-subtle">
                        {result?.status ?? 'Ready'}
                      </Text>
                    </Table.Cell>
                    <Table.Cell className="min-w-36 tabular-nums">
                      {credits(profile.balanceCents)}
                      <Text size="small" className="text-ui-fg-subtle">
                        Bonus {credits(profile.bonusCents)}
                      </Text>
                    </Table.Cell>
                    <Table.Cell className="min-w-64 whitespace-normal">
                      {result && cycle ? (
                        <>
                          <Text size="small">
                            Cost {credits(cycle.costCents)} · Sale{' '}
                            {credits(cycle.saleCents)}
                          </Text>
                          <Text size="small">
                            {credits(cycle.startingCents)} →{' '}
                            {credits(cycle.endingCents)} · Expected{' '}
                            {credits(cycle.expectedCents)}
                          </Text>
                          <Text
                            size="small"
                            className={
                              cycle.differenceCents ||
                              cycle.bonusDifferenceCents
                                ? 'text-ui-fg-error'
                                : 'text-ui-fg-subtle'
                            }
                          >
                            Total delta {credits(cycle.differenceCents)} · Bonus
                            delta {credits(cycle.bonusDifferenceCents)}
                          </Text>
                          <details className="mt-2 text-xs">
                            <summary className="cursor-pointer">
                              {result.cycles.length} cycle results
                            </summary>
                            <ol className="mt-2 space-y-2">
                              {result.cycles.map((item, index) => (
                                <li key={index}>
                                  #{index + 1} · {date(item.at)} · Cost{' '}
                                  {credits(item.costCents)} · Sale{' '}
                                  {credits(item.saleCents)} · Delta{' '}
                                  {credits(item.differenceCents)} /{' '}
                                  {credits(item.bonusDifferenceCents)}
                                </li>
                              ))}
                            </ol>
                          </details>
                        </>
                      ) : (
                        '—'
                      )}
                      {result?.error && (
                        <Text size="small" className="text-ui-fg-error">
                          {result.error}
                        </Text>
                      )}
                    </Table.Cell>
                    <Table.Cell className="min-w-56 whitespace-normal">
                      <Text size="small">
                        {result?.scheduleLabel || result?.waitReason || '—'}
                      </Text>
                      {result?.rank && (
                        <>
                          <Text size="small">
                            {result.rank.status.state} · Rank{' '}
                            {result.rank.status.currentRank ?? 'Unranked'} /
                            target {result.rank.target.targetRank}
                          </Text>
                          <Text size="small" className="text-ui-fg-subtle">
                            {result.rank.status.reason}
                          </Text>
                        </>
                      )}
                    </Table.Cell>
                  </Table.Row>
                );
              })}
            </Table.Body>
          </Table>
        </div>
      </Container>

      <Container>
        <details>
          <summary className="cursor-pointer text-sm font-medium">
            Test leaderboards
          </summary>
          <Text size="small" className="mt-2 text-ui-fg-subtle">
            Synthetic competitors and test profiles only. Fixture values do not
            represent production odds.
          </Text>
          <div className="mt-4 grid gap-6 lg:grid-cols-2">
            {(['weekly', 'alltime'] as const).map((period) => (
              <div key={period}>
                <Heading level="h3">
                  {period === 'weekly' ? 'This week (Malaysia)' : 'All time'}
                </Heading>
                <Table>
                  <Table.Header>
                    <Table.Row>
                      <Table.HeaderCell>Rank</Table.HeaderCell>
                      <Table.HeaderCell>Profile</Table.HeaderCell>
                      <Table.HeaderCell>Test value</Table.HeaderCell>
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {snapshot?.leaderboards[period].map((entry) => (
                      <Table.Row key={entry.profileId}>
                        <Table.Cell>{entry.rank}</Table.Cell>
                        <Table.Cell>{entry.name}</Table.Cell>
                        <Table.Cell>{credits(entry.valueCents)}</Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table>
              </div>
            ))}
          </div>
        </details>
      </Container>
    </div>
  );
}
