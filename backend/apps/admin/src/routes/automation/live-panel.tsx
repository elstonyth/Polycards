import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Container,
  Heading,
  Input,
  Label,
  Select,
  StatusBadge,
  Switch,
  Table,
  Text,
} from '@medusajs/ui';
import type {
  LiveConfig,
  LivePackWeight,
  LiveRunSummary,
  LiveSnapshot,
  LiveState,
} from '../../../../../packages/api/src/api/utils/automation-live-types';
import { DEFAULT_LIVE_TIMING } from '../../../../../packages/api/src/api/utils/automation-live-types';
import {
  CheckCircleSolid,
  ExclamationCircleSolid,
  Moon,
  PauseSolid,
  PlaySolid,
  StopCircleSolid,
} from '@medusajs/icons';
import { orderDateTime, rm } from '../../lib/format';
import { getLiveAccountActivity } from './live-account-activity';
import type { LiveAccountActivity } from './live-account-activity';
import { LiveRankSettings } from './live-rank-settings';
import { ago } from './tiers';

declare const __BACKEND_URL__: string;
const KEY = ['automation-live'];

// The operator's standing mix (2026-10-19), matched to live packs by slug or
// title. Unmatched packs start at 0%; every rate stays editable.
const SUGGESTED_RATES: [RegExp, number][] = [
  [/30th|celebration/i, 2500],
  [/ascended|\bah\b/i, 2000],
  [/bronze/i, 2500],
  [/silver/i, 1500],
  [/gold/i, 1000],
  [/platinum/i, 250],
  [/diamond/i, 200],
  [/poncho/i, 50],
];

function suggestedMix(packs: LiveSnapshot['packs']): LivePackWeight[] {
  return packs.map((pack) => ({
    packSlug: pack.slug,
    weightBp:
      SUGGESTED_RATES.find(([pattern]) =>
        pattern.test(`${pack.slug} ${pack.title}`),
      )?.[1] ?? 0,
  }));
}

const percent = (bp: number) =>
  `${(bp / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;

const STATUS: Record<
  LiveState['status'],
  {
    Icon: typeof Moon;
    label: string;
    color: 'green' | 'orange' | 'red' | 'grey';
  }
> = {
  idle: { Icon: Moon, label: 'Not running', color: 'grey' },
  running: { Icon: PlaySolid, label: 'Running', color: 'green' },
  paused: { Icon: PauseSolid, label: 'Paused', color: 'orange' },
  completed: { Icon: CheckCircleSolid, label: 'Finished', color: 'green' },
  stopped: { Icon: StopCircleSolid, label: 'Stopped', color: 'grey' },
  failed: {
    Icon: ExclamationCircleSolid,
    label: 'Stopped: needs a look',
    color: 'red',
  },
};

const TIMING: Record<NonNullable<LiveConfig['timingMode']>, string> = {
  fixed: 'Same gap every time',
  random: 'Random gap',
  humanized: 'Like a real player',
};

const settledCycle = (cycle: LiveState['cycles'][number]) =>
  !cycle.error &&
  cycle.differenceCents === 0 &&
  cycle.bonusDifferenceCents === 0;

/** The current run as a history row (the server archives it on the next Start). */
function currentRun(state: LiveSnapshot): LiveRunSummary | null {
  if (!state.runId || !state.config) return null;
  const settled = state.cycles.filter(settledCycle);
  return {
    runId: state.runId,
    startedAt: state.startedAt ?? state.cycles[0]?.startedAt ?? null,
    endedAt:
      state.status === 'running' || state.status === 'paused'
        ? null
        : (state.cycles.at(-1)?.finishedAt ?? null),
    status: state.status,
    draws: state.cycles.filter((cycle) => !cycle.skipped).length,
    settled: settled.length,
    failed:
      state.cycles.filter((cycle) => !cycle.skipped).length - settled.length,
    spentCents: state.spentCents,
    soldCents: settled.reduce((sum, cycle) => sum + (cycle.saleCents ?? 0), 0),
    accounts: new Set(state.cycles.map((cycle) => cycle.customerId)).size,
    packSlugs: state.config.packMix?.map((row) => row.packSlug) ?? [
      state.config.packSlug,
    ],
    timingMode: state.config.timingMode ?? DEFAULT_LIVE_TIMING.timingMode,
  };
}

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

function Step({
  n,
  title,
  hint,
  children,
}: {
  n: number;
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex gap-4 border-t pt-5 first:border-t-0 first:pt-0">
      <span
        aria-hidden
        className="bg-ui-bg-interactive text-ui-fg-on-color flex size-7 shrink-0 items-center justify-center rounded-full text-sm font-semibold"
      >
        {n}
      </span>
      <div className="min-w-0 flex-1 space-y-3">
        <div>
          <Text weight="plus">{title}</Text>
          {hint && (
            <Text size="small" className="text-ui-fg-subtle">
              {hint}
            </Text>
          )}
        </div>
        {children}
      </div>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <Text size="xsmall" className="text-ui-fg-subtle">
        {label}
      </Text>
      <Text weight="plus" className="tabular-nums">
        {value}
      </Text>
    </div>
  );
}

export function LivePanel() {
  const cache = useQueryClient();
  const [draft, setDraft] = useState<LiveConfig | null>(null);
  const query = useQuery({
    queryKey: KEY,
    queryFn: ({ signal }) => requestLive(undefined, signal),
    retry: false,
    refetchInterval: (query) => {
      const state = query.state.data;
      if (state?.pending) return 3000;
      if (state?.status !== 'running') return false;
      return state.nextRunAt && state.nextRunAt - Date.now() > 15000
        ? 10000
        : 3000;
    },
  });
  const action = useMutation({
    mutationFn: (input: Record<string, unknown>) => requestLive(input),
    onMutate: () => cache.cancelQueries({ queryKey: KEY }),
    onSuccess: (snapshot) => {
      cache.setQueryData(KEY, snapshot);
      setDraft(null);
    },
    onSettled: () => {
      void cache.invalidateQueries({ queryKey: KEY });
      void cache.invalidateQueries({ queryKey: ['automation-activity'] });
    },
  });
  const state = query.data;
  const config = {
    ...DEFAULT_LIVE_TIMING,
    ...(draft ??
      state?.config ?? {
        packSlug: '',
        customerIds: [],
        intervalSeconds: 5,
        maxCyclesPerAccount: 1,
      }),
  };
  const active =
    state?.status === 'running' ||
    state?.status === 'paused' ||
    !!state?.pending;
  const busy = action.isPending;
  const locked = active || busy || !state;
  const cycleTarget = state?.runId
    ? (state.config?.maxCyclesPerAccount ?? config.maxCyclesPerAccount)
    : config.maxCyclesPerAccount;
  const update = <K extends keyof LiveConfig>(key: K, value: LiveConfig[K]) =>
    setDraft({ ...config, [key]: value });
  const mixTotal =
    config.packMix?.reduce((sum, row) => sum + row.weightBp, 0) ?? 0;
  const packChosen = config.packMix ? mixTotal === 10000 : !!config.packSlug;
  const ready = packChosen && config.customerIds.length > 0;
  const packTitles = new Map(
    state?.packs.map((pack) => [pack.slug, pack.title]),
  );
  const setRate = (slug: string, bp: number) =>
    update(
      'packMix',
      (state?.packs ?? []).map((pack) => ({
        packSlug: pack.slug,
        weightBp:
          pack.slug === slug
            ? bp
            : (config.packMix?.find((row) => row.packSlug === pack.slug)
                ?.weightBp ?? 0),
      })),
    );
  const error = action.error?.message ?? query.error?.message ?? state?.error;
  const cycles = [
    ...(state?.pending ? [state.pending] : []),
    ...[...(state?.cycles ?? [])].reverse(),
  ];
  const names = new Map(
    state?.accounts.map((account) => [account.id, account.name]),
  );
  const schedules = new Map(
    state?.schedules?.map((row) => [row.customerId, row]),
  );
  const activities = new Map(
    state?.accounts.map((account) => [
      account.id,
      getLiveAccountActivity(
        state,
        account.id,
        config.customerIds.includes(account.id),
      ),
    ]),
  );
  const activityCounts = new Map<
    string,
    { color: LiveAccountActivity['color']; count: number }
  >();
  for (const id of config.customerIds) {
    const activity = activities.get(id);
    if (!activity) continue;
    const group = activityCounts.get(activity.label) ?? {
      color: activity.color,
      count: 0,
    };
    group.count++;
    activityCounts.set(activity.label, group);
  }
  const run = state ? currentRun(state) : null;
  const runs = [...(run ? [run] : []), ...(state?.history ?? [])];
  const status = STATUS[state?.status ?? 'idle'];
  const runConfig = state?.config;
  // An account skipped for low balance is done at whatever it reached.
  const planned =
    runConfig && !runConfig.rankTargets?.length
      ? runConfig.customerIds.reduce(
          (sum, id) =>
            sum +
            (state?.cycles.some((c) => c.customerId === id && c.skipped)
              ? state.cycles.filter(
                  (c) => c.customerId === id && settledCycle(c),
                ).length
              : runConfig.maxCyclesPerAccount),
          0,
        )
      : null;
  const soldCents = run?.soldCents ?? 0;
  const describe = (row: LiveRunSummary) =>
    row.packSlugs.length > 1
      ? `Mix of ${row.packSlugs.length} packs`
      : (packTitles.get(row.packSlugs[0]) ?? row.packSlugs[0]);

  return (
    <>
      <Container>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 space-y-1">
            <Text size="small" className="text-ui-fg-subtle">
              Live runs · real money, real packs
            </Text>
            <Heading level="h2" className="flex items-center gap-2">
              <status.Icon
                aria-hidden
                className={
                  status.color === 'green'
                    ? 'text-ui-tag-green-icon'
                    : status.color === 'red'
                      ? 'text-ui-tag-red-icon'
                      : status.color === 'orange'
                        ? 'text-ui-tag-orange-icon'
                        : 'text-ui-fg-muted'
                }
              />
              {state ? status.label : 'Loading…'}
            </Heading>
            {runConfig && state?.runId && (
              <Text size="small" className="text-ui-fg-subtle">
                {runConfig.customerIds.length} accounts ·{' '}
                {runConfig.packMix
                  ? `mix of ${runConfig.packMix.length} packs`
                  : (packTitles.get(runConfig.packSlug) ??
                    runConfig.packSlug)}{' '}
                · {TIMING[runConfig.timingMode ?? 'fixed']}
                {runConfig.timingMode === 'humanized' &&
                (runConfig.humanizedPace ?? 1) > 1
                  ? ` (${runConfig.humanizedPace}× faster)`
                  : ''}
              </Text>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {!active && (
              <Button
                disabled={!state || busy || !ready}
                isLoading={busy && action.variables?.action === 'run'}
                onClick={() => action.mutate({ action: 'run', config })}
              >
                <PlaySolid aria-hidden />
                Start run
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
              isLoading={query.isFetching && !busy}
              onClick={() => void query.refetch()}
            >
              Refresh
            </Button>
          </div>
        </div>

        {state?.runId && (
          <div className="mt-5 space-y-4">
            {planned !== null && (
              <div>
                <div
                  className="bg-ui-bg-component h-2.5 w-full overflow-hidden rounded-full"
                  role="progressbar"
                  aria-label="Packs opened in this run"
                  aria-valuemin={0}
                  aria-valuemax={planned}
                  aria-valuenow={run?.settled ?? 0}
                >
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-pink-500 to-orange-400 transition-[width] duration-700"
                    style={{
                      width: `${Math.min(100, ((run?.settled ?? 0) / Math.max(planned, 1)) * 100)}%`,
                    }}
                  />
                </div>
                <Text size="xsmall" className="text-ui-fg-subtle mt-1">
                  {run?.settled ?? 0} of {planned} packs done
                </Text>
              </div>
            )}
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
              <Stat label="Packs opened" value={String(run?.draws ?? 0)} />
              <Stat label="Spent" value={rm((state?.spentCents ?? 0) / 100)} />
              <Stat label="Sold back for" value={rm(soldCents / 100)} />
              <Stat
                label="Net"
                value={rm((soldCents - (state?.spentCents ?? 0)) / 100)}
              />
              <Stat
                label="Next pack"
                value={
                  state?.pending
                    ? 'Opening now'
                    : state?.status === 'running' && state.nextRunAt
                      ? new Date(state.nextRunAt).toLocaleTimeString()
                      : '—'
                }
              />
            </div>
          </div>
        )}
        {state?.pending && (
          <Text size="small" className="mt-4">
            {names.get(state.pending.customerId) ?? 'An account'} is{' '}
            {state.pending.pullId ? 'selling the card from' : 'opening'}{' '}
            {state.pending.packSlug
              ? (packTitles.get(state.pending.packSlug) ??
                state.pending.packSlug)
              : 'a pack'}
            {state.pending.cardName ? ` (${state.pending.cardName})` : ''}…
          </Text>
        )}
        {error && (
          <Text role="alert" className="text-ui-fg-error mt-4">
            {error}
          </Text>
        )}
        <Text size="xsmall" className="text-ui-fg-muted mt-4">
          Runs keep going when you close this page. Opening the page never
          starts one. These accounts rank on the weekly prize board too.
        </Text>
      </Container>

      <Container>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <Heading level="h2">Set up a run</Heading>
            <Text size="small" className="text-ui-fg-subtle">
              {active
                ? 'Settings are locked while a run is going. Stop it to change them.'
                : 'Pick packs, speed and accounts, then press Start run.'}
            </Text>
          </div>
          <Button
            variant="secondary"
            size="small"
            disabled={locked || !ready}
            onClick={() => action.mutate({ action: 'save', config })}
          >
            Save without starting
          </Button>
        </div>

        <fieldset disabled={locked} className="mt-5 space-y-5">
          <Step
            n={1}
            title="Which packs?"
            hint="Open one pack every time, or let each pack be picked at random by your rates."
          >
            <div className="flex flex-wrap gap-2">
              {(
                [
                  ['single', 'One pack'],
                  ['mix', 'Mix of packs'],
                ] as const
              ).map(([mode, label]) => (
                <Button
                  key={mode}
                  size="small"
                  variant={
                    (config.packMix ? 'mix' : 'single') === mode
                      ? 'primary'
                      : 'secondary'
                  }
                  aria-pressed={(config.packMix ? 'mix' : 'single') === mode}
                  disabled={locked}
                  onClick={() =>
                    update(
                      'packMix',
                      mode === 'mix'
                        ? suggestedMix(state?.packs ?? [])
                        : undefined,
                    )
                  }
                >
                  {label}
                </Button>
              ))}
            </div>
            {!config.packMix ? (
              <div className="max-w-sm space-y-2">
                <Label htmlFor="live-pack">Pack</Label>
                <Select
                  value={config.packSlug || undefined}
                  onValueChange={(value) => update('packSlug', value)}
                  disabled={locked}
                >
                  <Select.Trigger id="live-pack">
                    <Select.Value placeholder="Choose a pack" />
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
            ) : (
              <div className="space-y-3">
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  {state?.packs.map((pack) => {
                    const bp =
                      config.packMix?.find((row) => row.packSlug === pack.slug)
                        ?.weightBp ?? 0;
                    return (
                      <div
                        key={pack.slug}
                        className="space-y-2 rounded-lg border p-3"
                      >
                        <Label htmlFor={`live-rate-${pack.slug}`}>
                          {pack.title}{' '}
                          <span className="text-ui-fg-muted">
                            · {rm(pack.price)}
                          </span>
                        </Label>
                        <div className="flex items-center gap-2">
                          <Input
                            id={`live-rate-${pack.slug}`}
                            type="number"
                            min={0}
                            max={100}
                            step={0.01}
                            value={bp / 100}
                            onChange={(event) =>
                              setRate(
                                pack.slug,
                                Math.round(Number(event.target.value) * 100) ||
                                  0,
                              )
                            }
                          />
                          <Text size="small" className="text-ui-fg-subtle">
                            %
                          </Text>
                        </div>
                        <div
                          aria-hidden
                          className="bg-ui-bg-component h-1.5 overflow-hidden rounded-full"
                        >
                          <div
                            className="h-full bg-pink-500"
                            style={{ width: `${bp / 100}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
                <Text
                  size="small"
                  className={
                    mixTotal === 10000
                      ? 'text-ui-fg-subtle'
                      : 'text-ui-fg-error'
                  }
                >
                  {mixTotal === 10000
                    ? 'Adds up to 100%. If an account can’t afford the pack it rolls, that pack is skipped for that draw.'
                    : `Rates must add up to exactly 100%. Now ${percent(mixTotal)}.`}
                </Text>
              </div>
            )}
          </Step>

          <Step
            n={2}
            title="How fast?"
            hint={
              config.timingMode === 'humanized'
                ? 'Each account lives its own day: short play sessions, breaks, pauses between packs and sleep at night. Speed runs that whole day faster, so the pull, rest, sleep, pull cycle repeats sooner: 5× fits a full day into about 5 hours, 24× into 1 hour. All accounts share one queue, so about 15 packs a minute is the most it will do.'
                : 'Gap between one pack and the next, across all accounts.'
            }
          >
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <div className="space-y-2">
                <Label htmlFor="live-timing">Style</Label>
                <Select
                  value={config.timingMode}
                  onValueChange={(value) =>
                    update(
                      'timingMode',
                      value as NonNullable<LiveConfig['timingMode']>,
                    )
                  }
                  disabled={locked}
                >
                  <Select.Trigger id="live-timing">
                    <Select.Value />
                  </Select.Trigger>
                  <Select.Content>
                    {Object.entries(TIMING).map(([value, label]) => (
                      <Select.Item value={value} key={value}>
                        {label}
                      </Select.Item>
                    ))}
                  </Select.Content>
                </Select>
              </div>
              {config.timingMode === 'fixed' && (
                <div className="space-y-2">
                  <Label htmlFor="live-interval">Seconds between packs</Label>
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
              )}
              {config.timingMode === 'random' &&
                (['randomMinSeconds', 'randomMaxSeconds'] as const).map(
                  (key) => (
                    <div className="space-y-2" key={key}>
                      <Label htmlFor={`live-${key}`}>
                        {key === 'randomMinSeconds'
                          ? 'Shortest gap (seconds)'
                          : 'Longest gap (seconds)'}
                      </Label>
                      <Input
                        id={`live-${key}`}
                        type="number"
                        min={2}
                        max={86400}
                        value={config[key]}
                        onChange={(event) =>
                          update(key, Number(event.target.value))
                        }
                      />
                    </div>
                  ),
                )}
              {config.timingMode === 'humanized' && (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="live-pace">Speed</Label>
                    <Select
                      value={String(config.humanizedPace)}
                      onValueChange={(value) =>
                        update('humanizedPace', Number(value))
                      }
                      disabled={locked}
                    >
                      <Select.Trigger id="live-pace">
                        <Select.Value />
                      </Select.Trigger>
                      <Select.Content>
                        {[1, 2, 3, 5, 10, 24].map((pace) => (
                          <Select.Item value={String(pace)} key={pace}>
                            {pace === 1
                              ? 'Real time (1 day = 24 h)'
                              : `${pace}× (1 day ≈ ${+(24 / pace).toFixed(1)} h)`}
                          </Select.Item>
                        ))}
                      </Select.Content>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="live-region">Where they live</Label>
                    <Select
                      value={config.humanizedRegion}
                      onValueChange={(value) =>
                        update(
                          'humanizedRegion',
                          value as NonNullable<LiveConfig['humanizedRegion']>,
                        )
                      }
                      disabled={locked}
                    >
                      <Select.Trigger id="live-region">
                        <Select.Value />
                      </Select.Trigger>
                      <Select.Content>
                        <Select.Item value="mysg">
                          Malaysia / Singapore
                        </Select.Item>
                        <Select.Item value="global">
                          Around the world
                        </Select.Item>
                      </Select.Content>
                    </Select>
                  </div>
                </>
              )}
            </div>
          </Step>

          <Step
            n={3}
            title="How many packs per account?"
            hint="A round finishes when every account has opened this many, or runs out of balance. With Repeat on, the next round starts by itself until you stop it."
          >
            <div className="flex flex-wrap items-center gap-4">
              <div className="max-w-40">
                <Input
                  id="live-cycles"
                  aria-label="Packs per account"
                  type="number"
                  min={1}
                  max={10}
                  value={config.maxCyclesPerAccount}
                  onChange={(event) =>
                    update('maxCyclesPerAccount', Number(event.target.value))
                  }
                />
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  id="live-repeat"
                  checked={!!config.repeat}
                  disabled={locked}
                  onCheckedChange={(repeat) => update('repeat', repeat)}
                />
                <Label htmlFor="live-repeat">Repeat rounds</Label>
              </div>
            </div>
          </Step>

          <Step
            n={4}
            title={`Which accounts? · ${config.customerIds.length} picked`}
            hint="Add or remove accounts in the Accounts tab."
          >
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                size="small"
                disabled={locked || !state?.accounts.length}
                onClick={() =>
                  update(
                    'customerIds',
                    state?.accounts
                      .filter((account) => account.status === 'active')
                      .map((account) => account.id) ?? [],
                  )
                }
              >
                Pick all active
              </Button>
              <Button
                variant="transparent"
                size="small"
                disabled={locked || !config.customerIds.length}
                onClick={() => update('customerIds', [])}
              >
                Clear
              </Button>
              <div
                role="group"
                aria-label="What the picked accounts are doing"
                className="flex flex-wrap gap-2"
              >
                {[...activityCounts].map(([label, group]) => (
                  <StatusBadge key={label} color={group.color}>
                    {label} · {group.count}
                  </StatusBadge>
                ))}
              </div>
            </div>
            {!state?.accounts.length && (
              <Text className="text-ui-fg-subtle">
                No accounts yet. Add their emails in the Accounts tab.
              </Text>
            )}
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {state?.accounts.map((account) => {
                const activity = activities.get(account.id)!;
                const picked = config.customerIds.includes(account.id);
                return (
                  <label
                    key={account.id}
                    data-account-id={account.id}
                    className={`flex cursor-pointer items-start gap-2 rounded-lg border p-3 text-sm transition-colors ${picked ? 'border-ui-border-interactive bg-ui-bg-highlight' : ''}`}
                  >
                    <input
                      type="checkbox"
                      aria-label={`Pick ${account.name}`}
                      className="mt-1"
                      checked={picked}
                      disabled={locked || account.status !== 'active'}
                      onChange={(event) =>
                        update(
                          'customerIds',
                          event.target.checked
                            ? [...config.customerIds, account.id]
                            : config.customerIds.filter(
                                (id) => id !== account.id,
                              ),
                        )
                      }
                    />
                    <span className="min-w-0 flex-1 space-y-1">
                      <span className="flex flex-wrap items-center justify-between gap-2">
                        <span className="break-words font-medium">
                          {account.name}
                        </span>
                        <StatusBadge color={activity.color}>
                          {activity.label}
                        </StatusBadge>
                      </span>
                      <span className="text-ui-fg-subtle block tabular-nums">
                        {account.balance === null
                          ? 'Balance unavailable'
                          : rm(account.balance)}
                        {account.status !== 'active' && ` · ${account.status}`}
                        {' · '}
                        {activity.settledCycles}/{cycleTarget} packs
                      </span>
                      <span className="block">{activity.reason}</span>
                      {activity.nextCheckAt !== null && (
                        <span className="text-ui-fg-subtle block">
                          Next:{' '}
                          <time
                            dateTime={new Date(
                              activity.nextCheckAt,
                            ).toISOString()}
                          >
                            {orderDateTime(activity.nextCheckAt)}
                          </time>
                        </span>
                      )}
                      {schedules.has(account.id) && (
                        <span className="text-ui-fg-muted block">
                          {schedules.get(account.id)!.humanized.label}
                        </span>
                      )}
                    </span>
                  </label>
                );
              })}
            </div>
          </Step>
        </fieldset>

        <details className="mt-5 border-t pt-5">
          <summary className="cursor-pointer">
            <Text as="span" weight="plus">
              Optional: aim for an all-time leaderboard spot
            </Text>
          </summary>
          <LiveRankSettings
            config={config}
            state={state}
            disabled={locked}
            onChange={setDraft}
          />
        </details>
      </Container>

      <Container className="p-0">
        <div className="px-6 py-4">
          <Heading level="h2">This run’s packs</Heading>
          <Text size="small" className="text-ui-fg-subtle">
            Each pack is paid, its card is sold back, and both balances are
            checked. Newest first.
          </Text>
        </div>
        <div className="max-h-[560px] overflow-auto">
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.HeaderCell>Account</Table.HeaderCell>
                <Table.HeaderCell>Pack → card</Table.HeaderCell>
                <Table.HeaderCell>Paid → sold for</Table.HeaderCell>
                <Table.HeaderCell>Check</Table.HeaderCell>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {cycles.map((cycle) => (
                <Table.Row key={cycle.id}>
                  <Table.Cell>
                    {names.get(cycle.customerId) ?? cycle.customerId}
                    <Text size="xsmall" className="text-ui-fg-muted">
                      {ago(cycle.startedAt)}
                    </Text>
                  </Table.Cell>
                  <Table.Cell>
                    <Text size="small">
                      {cycle.packSlug
                        ? (packTitles.get(cycle.packSlug) ?? cycle.packSlug)
                        : '—'}
                    </Text>
                    <Text size="xsmall" className="text-ui-fg-subtle">
                      {cycle.cardName ??
                        (cycle.skipped || cycle.error ? '—' : 'Opening…')}
                    </Text>
                  </Table.Cell>
                  <Table.Cell className="whitespace-nowrap tabular-nums">
                    {cycle.costCents === undefined
                      ? '—'
                      : rm(cycle.costCents / 100)}{' '}
                    →{' '}
                    {cycle.saleCents === undefined
                      ? '—'
                      : rm(cycle.saleCents / 100)}
                  </Table.Cell>
                  <Table.Cell>
                    {cycle.error ? (
                      <Badge size="2xsmall" color="red" title={cycle.error}>
                        Failed
                      </Badge>
                    ) : cycle.skipped ? (
                      <Badge
                        size="2xsmall"
                        color="orange"
                        title={cycle.skipped}
                      >
                        Skipped: low balance
                      </Badge>
                    ) : !cycle.finishedAt ? (
                      <Badge size="2xsmall" color="blue">
                        In progress
                      </Badge>
                    ) : settledCycle(cycle) ? (
                      <Badge size="2xsmall" color="green">
                        Balanced
                      </Badge>
                    ) : (
                      <Badge
                        size="2xsmall"
                        color="orange"
                        title={`Total off by ${rm((cycle.differenceCents ?? 0) / 100)}, bonus off by ${rm((cycle.bonusDifferenceCents ?? 0) / 100)}`}
                      >
                        Balance mismatch
                      </Badge>
                    )}
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </div>
        {!cycles.length && (
          <Text className="text-ui-fg-subtle px-6 py-6">
            No packs opened in this run yet.
          </Text>
        )}
      </Container>

      <Container className="p-0">
        <div className="px-6 py-4">
          <Heading level="h2">Run history</Heading>
          <Text size="small" className="text-ui-fg-subtle">
            Every run, newest first. A run moves here when the next one starts.
          </Text>
        </div>
        <div className="overflow-x-auto">
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.HeaderCell>Started</Table.HeaderCell>
                <Table.HeaderCell>Result</Table.HeaderCell>
                <Table.HeaderCell>Packs</Table.HeaderCell>
                <Table.HeaderCell>Spent → sold back</Table.HeaderCell>
                <Table.HeaderCell>Setup</Table.HeaderCell>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {runs.map((row) => (
                <Table.Row key={row.runId}>
                  <Table.Cell className="whitespace-nowrap">
                    {row.startedAt
                      ? orderDateTime(row.startedAt)
                      : '—'}
                    {row.endedAt && (
                      <Text size="xsmall" className="text-ui-fg-muted">
                        ended {ago(row.endedAt)}
                      </Text>
                    )}
                  </Table.Cell>
                  <Table.Cell>
                    <StatusBadge color={STATUS[row.status].color}>
                      {STATUS[row.status].label}
                    </StatusBadge>
                  </Table.Cell>
                  <Table.Cell className="tabular-nums">
                    {row.settled}
                    {row.failed > 0 && (
                      <span className="text-ui-fg-error">
                        {' '}
                        · {row.failed} failed
                      </span>
                    )}
                    <Text size="xsmall" className="text-ui-fg-muted">
                      {row.accounts} accounts
                    </Text>
                  </Table.Cell>
                  <Table.Cell className="whitespace-nowrap tabular-nums">
                    {rm(row.spentCents / 100)} → {rm(row.soldCents / 100)}
                  </Table.Cell>
                  <Table.Cell>
                    {describe(row)}
                    <Text size="xsmall" className="text-ui-fg-muted">
                      {TIMING[row.timingMode]}
                    </Text>
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </div>
        {!runs.length && (
          <Text className="text-ui-fg-subtle px-6 py-6">No runs yet.</Text>
        )}
      </Container>
    </>
  );
}
