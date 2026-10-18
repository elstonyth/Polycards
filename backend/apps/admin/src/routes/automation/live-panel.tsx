import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Container,
  Heading,
  Input,
  Label,
  Select,
  StatusBadge,
  Table,
  Text,
} from '@medusajs/ui';
import type {
  LiveConfig,
  LiveSnapshot,
} from '../../../../../packages/api/src/api/utils/automation-live-types';
import { rm } from '../../lib/format';

declare const __BACKEND_URL__: string;
const KEY = ['automation-live'];

async function requestLive(
  input?: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<LiveSnapshot> {
  const response = await fetch(`${__BACKEND_URL__}/admin/automation/live`, {
    method: input ? 'POST' : 'GET',
    credentials: 'include',
    cache: 'no-store',
    signal,
    ...(input
      ? {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
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
        : `Live request failed (${response.status}).`,
    );
  return body as LiveSnapshot;
}

export function LivePanel() {
  const cache = useQueryClient();
  const [draft, setDraft] = useState<LiveConfig | null>(null);
  const query = useQuery({
    queryKey: KEY,
    queryFn: ({ signal }) => requestLive(undefined, signal),
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.status === 'running' || query.state.data?.pending
        ? 3000
        : false,
  });
  const action = useMutation({
    mutationFn: (input: Record<string, unknown>) => requestLive(input),
    onMutate: () => cache.cancelQueries({ queryKey: KEY }),
    onSuccess: (snapshot) => {
      cache.setQueryData(KEY, snapshot);
      setDraft(null);
    },
    onSettled: () => cache.invalidateQueries({ queryKey: KEY }),
  });
  const state = query.data;
  const config = draft ??
    state?.config ?? {
      packSlug: '',
      customerIds: [],
      intervalSeconds: 5,
      maxCyclesPerAccount: 1,
    };
  const active =
    state?.status === 'running' ||
    state?.status === 'paused' ||
    !!state?.pending;
  const busy = action.isPending;
  const update = <K extends keyof LiveConfig>(key: K, value: LiveConfig[K]) =>
    setDraft({ ...config, [key]: value });
  const error = action.error?.message ?? query.error?.message ?? state?.error;
  const cycles = [
    ...(state?.cycles ?? []),
    ...(state?.pending ? [state.pending] : []),
  ];
  const names = new Map(
    state?.accounts.map((account) => [account.id, account.name]),
  );
  return (
    <>
      <Container>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-2">
            <Heading level="h2">Live workspace</Heading>
            <Text size="small" className="text-ui-fg-subtle">
              Production customer balances, real pack draws and buyback
              settlements. Pulls follow normal leaderboard and reward rules.
            </Text>
            <Text size="small">
              Runs continue in the cloud when this browser is closed. Opening
              this page never starts a run.
            </Text>
          </div>
          <StatusBadge
            color={
              state?.status === 'running'
                ? 'green'
                : state?.status === 'failed'
                  ? 'red'
                  : 'grey'
            }
          >
            {state?.status ?? 'loading'}
          </StatusBadge>
        </div>
      </Container>
      <Container>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-2">
            <Heading level="h2">Live run controls</Heading>
            <Text size="small">
              {state?.cycles.filter(
                (cycle) =>
                  !cycle.error &&
                  cycle.differenceCents === 0 &&
                  cycle.bonusDifferenceCents === 0,
              ).length ?? 0}{' '}
              cycles settled · {rm((state?.spentCents ?? 0) / 100)} spent
            </Text>
            <Text size="small" className="text-ui-fg-subtle">
              Each cycle charges the selected pack, sells its returned card and
              verifies total and bonus balances. Stop lets any current
              settlement finish.
            </Text>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              disabled={
                !state ||
                active ||
                busy ||
                !config.packSlug ||
                !config.customerIds.length
              }
              onClick={() => action.mutate({ action: 'save', config })}
            >
              Save settings
            </Button>
            {!active && (
              <Button
                disabled={
                  !state ||
                  busy ||
                  !config.packSlug ||
                  !config.customerIds.length
                }
                onClick={() => action.mutate({ action: 'run', config })}
              >
                Start live run
              </Button>
            )}
            {state?.status === 'running' && (
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => action.mutate({ action: 'pause' })}
              >
                Pause
              </Button>
            )}
            {state?.status === 'paused' && (
              <Button
                disabled={busy || !!state.pending}
                onClick={() => action.mutate({ action: 'resume' })}
              >
                Resume
              </Button>
            )}
            {active && (
              <Button
                variant="danger"
                disabled={busy || state?.status === 'stopped'}
                onClick={() => action.mutate({ action: 'stop' })}
              >
                Stop
              </Button>
            )}
            <Button
              variant="transparent"
              disabled={busy}
              onClick={() => void query.refetch()}
            >
              Refresh
            </Button>
          </div>
        </div>
        {error && (
          <Text role="alert" className="mt-4 text-ui-fg-error">
            {error}
          </Text>
        )}
        {state?.pending && (
          <Text className="mt-4" size="small">
            Settling cycle {state.pending.id}
            {state.pending.pullId ? ` · Pull ${state.pending.pullId}` : ''}
          </Text>
        )}
      </Container>
      <Container>
        <Heading level="h2">Live configuration</Heading>
        <fieldset
          disabled={active || busy || !state}
          className="mt-4 grid gap-4 sm:grid-cols-3"
        >
          <div className="space-y-2">
            <Label htmlFor="live-pack">Paid pack</Label>
            <Select
              value={config.packSlug || undefined}
              onValueChange={(value) => update('packSlug', value)}
              disabled={active || busy}
            >
              <Select.Trigger id="live-pack">
                <Select.Value placeholder="Choose a live pack" />
              </Select.Trigger>
              <Select.Content>
                {state?.packs.map((pack) => (
                  <Select.Item value={pack.slug} key={pack.slug}>
                    {pack.title} · {rm(pack.price)}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="live-interval">Interval (seconds)</Label>
            <Input
              id="live-interval"
              type="number"
              min={2}
              max={86400}
              value={config.intervalSeconds}
              onChange={(event) =>
                update('intervalSeconds', Number(event.target.value))
              }
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="live-cycles">Cycles per account</Label>
            <Input
              id="live-cycles"
              type="number"
              min={1}
              max={10}
              value={config.maxCyclesPerAccount}
              onChange={(event) =>
                update('maxCyclesPerAccount', Number(event.target.value))
              }
            />
          </div>
        </fieldset>
        <Text size="small" className="mt-3 text-ui-fg-subtle">
          No total spend cap. Runs finish the selected cycles while account
          balances cover each draw. Each draw appears in the storefront’s recent
          pulls feed, including cards sold back.
        </Text>
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
          <Heading level="h3">
            Customer accounts · {config.customerIds.length} selected
          </Heading>
          <Button
            variant="secondary"
            disabled={active || busy || !state?.accounts.length}
            onClick={() =>
              update(
                'customerIds',
                state?.accounts
                  .filter((account) => account.status === 'active')
                  .map((account) => account.id) ?? [],
              )
            }
          >
            Select all active accounts
          </Button>
        </div>
        {!state?.accounts.length && (
          <Text className="mt-3 text-ui-fg-subtle">
            Add existing customer emails in the Accounts tab to make them
            available here.
          </Text>
        )}
        <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {state?.accounts.map((account) => (
            <label
              key={account.id}
              className="flex items-start gap-2 rounded-md border p-3 text-sm"
            >
              <input
                type="checkbox"
                className="mt-1"
                checked={config.customerIds.includes(account.id)}
                disabled={active || busy || account.status !== 'active'}
                onChange={(event) =>
                  update(
                    'customerIds',
                    event.target.checked
                      ? [...config.customerIds, account.id]
                      : config.customerIds.filter((id) => id !== account.id),
                  )
                }
              />
              <span>
                {account.name}
                <span className="block text-ui-fg-subtle">
                  {account.balance === null
                    ? 'Unavailable'
                    : rm(account.balance)}{' '}
                  · {account.status}
                </span>
              </span>
            </label>
          ))}
        </div>
      </Container>
      <Container className="p-0">
        <div className="px-6 py-4">
          <Heading level="h2">Live draws and settlements</Heading>
        </div>
        <div className="overflow-x-auto">
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.HeaderCell>Account / pull</Table.HeaderCell>
                <Table.HeaderCell>Draw / sale</Table.HeaderCell>
                <Table.HeaderCell>Balance verification</Table.HeaderCell>
                <Table.HeaderCell>Status</Table.HeaderCell>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {cycles.map((cycle) => (
                <Table.Row key={cycle.id}>
                  <Table.Cell>
                    {names.get(cycle.customerId) ?? cycle.customerId}
                    <Text size="small" className="text-ui-fg-subtle">
                      {cycle.cardName ?? cycle.id}
                      {cycle.pullId && (
                        <>
                          <br />
                          {cycle.pullId}
                        </>
                      )}
                    </Text>
                  </Table.Cell>
                  <Table.Cell>
                    {cycle.costCents === undefined
                      ? '—'
                      : rm(cycle.costCents / 100)}{' '}
                    /{' '}
                    {cycle.saleCents === undefined
                      ? '—'
                      : rm(cycle.saleCents / 100)}
                  </Table.Cell>
                  <Table.Cell>
                    {cycle.endingCents === undefined ? (
                      'Pending'
                    ) : (
                      <>
                        <Text size="small">
                          {rm(cycle.startingCents! / 100)} →{' '}
                          {rm(cycle.endingCents / 100)} · Expected{' '}
                          {rm(cycle.expectedCents! / 100)}
                        </Text>
                        <Text size="small">
                          Total delta {rm(cycle.differenceCents! / 100)} · Bonus
                          delta {rm(cycle.bonusDifferenceCents! / 100)}
                        </Text>
                      </>
                    )}
                  </Table.Cell>
                  <Table.Cell>
                    {cycle.error ??
                      (!cycle.finishedAt
                        ? 'Settling'
                        : cycle.differenceCents === 0 &&
                            cycle.bonusDifferenceCents === 0
                          ? 'Settled'
                          : 'Review balance mismatch')}
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </div>
        {!cycles.length && (
          <Text className="px-6 py-6 text-ui-fg-subtle">
            No live run has been started.
          </Text>
        )}
      </Container>
    </>
  );
}
