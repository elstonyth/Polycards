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
  Tabs,
  toast,
} from '@medusajs/ui';
import { CurrencyDollar } from '@medusajs/icons';
import type { Permission, RouteConfig } from '@mercurjs/dashboard-sdk';
import { usePermissions } from '@mercurjs/admin';
import {
  getCoinFlipSettings,
  listCoinFlips,
  saveCoinFlipSettings,
  httpStatus,
} from '../../lib/admin-rest';
import {
  coinFlipDraft,
  effectiveCoinRates,
  parseCoinFlipDraft,
  type CoinFlipSettings,
  type CoinHistoryFilters,
} from '../../lib/coin-flips';
import { StickySaveBar } from '../../components/StickySaveBar';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';
import { Pager } from '../../components/Pager';
import { orderDateTime, rm } from '../../lib/format';

export const config: RouteConfig = {
  label: 'pcNav.coinFlip',
  translationNs: 'translation',
  icon: CurrencyDollar,
  rank: 32,
  permissions: ['coin_flip:read' as Permission],
};
export const handle = {
  permissions: 'coin_flip:read',
  redirectTo: '/overview',
};
const settingsKey = ['coin-flip-settings'];

function Settings({
  saved: latest,
  reload,
  active,
  canEdit,
}: {
  saved: CoinFlipSettings;
  reload: () => void;
  active: boolean;
  canEdit: boolean;
}) {
  // Background refreshes must not replace an operator's editing baseline.
  const [saved, setSaved] = useState(latest);
  const [draft, setDraft] = useState(() => coinFlipDraft(saved));
  const [reason, setReason] = useState('');
  const [conflict, setConflict] = useState(false);
  const stale = conflict || latest.revision !== saved.revision;
  const cache = useQueryClient();
  const dirty = JSON.stringify(draft) !== JSON.stringify(coinFlipDraft(saved));
  let validation = '';
  let parsed: ReturnType<typeof parseCoinFlipDraft> | null = null;
  try {
    parsed = parseCoinFlipDraft(draft);
  } catch (error) {
    validation = error instanceof Error ? error.message : 'Check settings.';
  }
  const effective = parsed ? effectiveCoinRates(parsed) : [];
  const mismatch =
    parsed?.published_win_percent != null &&
    effective.some(
      (rate) => rate != null && rate !== parsed.published_win_percent,
    );
  const mutation = useMutation({
    mutationFn: saveCoinFlipSettings,
    onSuccess: (settings) => {
      setSaved(settings);
      setDraft(coinFlipDraft(settings));
      setReason('');
      cache.setQueryData(settingsKey, settings);
      toast.success('Coin flip settings saved');
    },
    onError: (error) => {
      if (httpStatus(error) === 409) setConflict(true);
      toast.error(
        error instanceof Error ? error.message : 'Could not save settings',
      );
    },
  });
  function save() {
    if (!canEdit || !active || !parsed || !reason.trim() || stale) return;
    mutation.mutate({
      ...parsed,
      expected_revision: saved.revision,
      reason: reason.trim(),
    });
  }
  const fields = [
    [
      'published_win_percent',
      'Published win odds (%)',
      'Published reference rate saved with each flip.',
    ],
    [
      'win_percent',
      'Actual odds · Set 1 (%)',
      'Base rate. Required before enabling.',
    ],
    [
      'win_percent_2',
      'Actual odds · Set 2 (%)',
      'Blank inherits Set 1. Zero means a 0% win chance.',
    ],
    [
      'win_percent_3',
      'Actual odds · Set 3 (%)',
      'Blank inherits Set 2, then Set 1. Zero remains zero.',
    ],
  ] as const;
  return (
    <Container className="p-0">
      <div className="space-y-6 px-6 py-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Heading level="h2">Settings</Heading>
          <StatusBadge color={saved.enabled ? 'green' : 'grey'}>
            {saved.enabled ? 'Live' : 'Paused'} · revision {saved.revision}
          </StatusBadge>
        </div>
        <Text className="text-ui-fg-subtle" size="small">
          Uses each player’s effective pack group and odds set. These rates
          apply only to coin flips. Saved changes invalidate outstanding quotes.
        </Text>
        <label className="flex items-center gap-3 text-sm">
          <input
            type="checkbox"
            checked={draft.enabled}
            disabled={!canEdit || mutation.isPending}
            onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
            className="h-4 w-4"
          />
          Enable coin flips
        </label>
        <div className="grid gap-5 md:grid-cols-2">
          {fields.map(([field, label, help]) => (
            <div key={field}>
              <Label htmlFor={`coin-${field}`}>{label}</Label>
              <Input
                id={`coin-${field}`}
                inputMode="decimal"
                value={draft[field]}
                disabled={!canEdit || mutation.isPending}
                onChange={(e) =>
                  setDraft({ ...draft, [field]: e.target.value })
                }
                className="mt-2"
              />
              <Text size="small" className="text-ui-fg-subtle mt-1">
                {help}
              </Text>
            </div>
          ))}
        </div>
        <div className="rounded-lg border p-4">
          <Text size="small">
            Effective actual odds:{' '}
            {effective.length
              ? effective
                  .map(
                    (rate, i) =>
                      `Set ${i + 1}: ${rate == null ? 'unconfigured' : `${rate}%`}`,
                  )
                  .join(' · ')
              : 'Check inputs'}
          </Text>
          {mismatch && (
            <Text size="small" className="mt-2 text-ui-fg-error">
              The published reference differs from one or more effective actual
              rates. Actual rates determine coin-flip outcomes.
            </Text>
          )}
        </div>
        <Text size="small" className="text-ui-fg-subtle">
          One toss settles all selected cards. A win keeps them and pays 100% of
          their combined confirmed MYR value as normal Credit. A loss forfeits
          every selected card without restocking it. Bonus and gift cards are
          included; existing withdrawal eligibility is required.
        </Text>
        {stale && (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-3 text-sm text-ui-fg-error"
          >
            Another admin changed these settings. Reload before editing again.
            <Button variant="secondary" onClick={reload}>
              Discard draft & reload
            </Button>
          </div>
        )}
      </div>
      {canEdit && (
        <StickySaveBar
          dirty={dirty}
          saving={mutation.isPending}
          canSave={active && !!parsed && reason.trim().length >= 1 && !stale}
          message={
            validation ||
            (!reason.trim() && dirty ? 'Audit reason required' : undefined)
          }
          onSave={save}
          onDiscard={() => {
            setDraft(coinFlipDraft(saved));
            setReason('');
          }}
        >
          <div className="min-w-52 flex-1">
            <Label htmlFor="coin-reason">Audit reason</Label>
            <Input
              id="coin-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={500}
              placeholder="Why are these settings changing?"
              className="mt-1"
            />
          </div>
        </StickySaveBar>
      )}
    </Container>
  );
}

function History() {
  const empty: CoinHistoryFilters = {
    page: 0,
    status: '',
    customer: '',
    from: '',
    to: '',
  };
  const [draft, setDraft] = useState(empty);
  const [filters, setFilters] = useState(empty);
  const query = useQuery({
    queryKey: ['coin-flip-history', filters],
    queryFn: () => listCoinFlips(filters),
  });
  return (
    <Container className="p-0">
      <div className="px-6 py-5">
        <Heading level="h2">Completed flips</Heading>
        <Text size="small" className="text-ui-fg-subtle mt-1">
          Immutable receipts. Forfeited cards remain held separately; their
          valuation is not cash income.
        </Text>
        <form
          className="mt-4 flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            setFilters({ ...draft, page: 0 });
          }}
        >
          <div>
            <Label htmlFor="coin-outcome">Outcome</Label>
            <select
              id="coin-outcome"
              value={draft.status}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  status: e.target.value as CoinHistoryFilters['status'],
                })
              }
              className="mt-1 block h-8 rounded border bg-ui-bg-field px-2 text-sm"
            >
              <option value="">All</option>
              <option value="won">Won</option>
              <option value="lost">Lost / forfeited</option>
            </select>
          </div>
          <div>
            <Label htmlFor="coin-customer">Customer ID</Label>
            <Input
              id="coin-customer"
              value={draft.customer}
              onChange={(e) => setDraft({ ...draft, customer: e.target.value })}
              className="mt-1"
            />
          </div>
          <div>
            <Label htmlFor="coin-source">Funding source</Label>
            <select
              id="coin-source"
              value={draft.source ?? ''}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  source: e.target.value as CoinHistoryFilters['source'],
                })
              }
              className="mt-1 block h-8 rounded border bg-ui-bg-field px-2 text-sm"
            >
              <option value="">All</option>
              <option value="pack">Pack</option>
              <option value="bonus">Bonus</option>
              <option value="gift">Gift</option>
              <option value="reward">Reward</option>
              <option value="free">Free</option>
              <option value="mixed">Mixed cards</option>
              <option value="tickets">Tickets only</option>
            </select>
          </div>
          <div>
            <Label htmlFor="coin-from">From (MYT)</Label>
            <Input
              id="coin-from"
              type="date"
              value={draft.from}
              onChange={(e) => setDraft({ ...draft, from: e.target.value })}
              className="mt-1"
            />
          </div>
          <div>
            <Label htmlFor="coin-to">Through (MYT)</Label>
            <Input
              id="coin-to"
              type="date"
              value={draft.to}
              onChange={(e) => setDraft({ ...draft, to: e.target.value })}
              className="mt-1"
            />
          </div>
          <Button type="submit" variant="secondary">
            Apply
          </Button>
        </form>
      </div>
      {query.isError ? (
        <div role="alert" className="px-6 pb-5 text-sm text-ui-fg-error">
          {query.error instanceof Error
            ? query.error.message
            : 'Could not load history.'}
          <Button
            variant="secondary"
            onClick={() => void query.refetch()}
            className="ml-3"
          >
            Retry
          </Button>
        </div>
      ) : !query.data ? (
        <div className="p-6">
          <LoadingSkeleton />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 border-y px-6 py-4 md:grid-cols-4">
            {[
              ['Wins', query.data.totals.wins],
              ['Losses', query.data.totals.losses],
              ['Credit paid', rm(query.data.totals.payouts)],
              ['Forfeited value', rm(query.data.totals.forfeited_value)],
            ].map(([label, value]) => (
              <div key={label}>
                <Text size="small" className="text-ui-fg-subtle">
                  {label}
                </Text>
                <Heading level="h2">{value}</Heading>
              </div>
            ))}
          </div>
          <div className="overflow-x-auto">
            <Table>
              <Table.Header>
                <Table.Row>
                  {[
                    'Settled (MYT)',
                    'Card / player',
                    'Outcome',
                    'Value',
                    'Receipt',
                  ].map((label) => (
                    <Table.HeaderCell key={label}>{label}</Table.HeaderCell>
                  ))}
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {query.data.rounds.map((round) => (
                  <Table.Row key={round.id}>
                    <Table.Cell>{orderDateTime(round.settled_at)}</Table.Cell>
                    <Table.Cell>
                      <Text size="small">
                        {[
                          round.cards.length > 1
                            ? `${round.cards.length} cards · ${round.card?.name} + ${round.cards.length - 1} more`
                            : round.card?.name,
                          round.tickets > 0 &&
                            `${round.tickets} Lucky Draw tickets`,
                        ]
                          .filter(Boolean)
                          .join(' + ')}
                      </Text>
                      <Text size="small" className="text-ui-fg-subtle">
                        {round.customer_id}
                      </Text>
                    </Table.Cell>
                    <Table.Cell>
                      <StatusBadge
                        color={round.status === 'won' ? 'green' : 'red'}
                      >
                        {round.cards.length === 0
                          ? round.status === 'won'
                            ? 'Won · tickets added'
                            : 'Lost · tickets removed'
                          : round.status === 'won'
                            ? 'Won · cards kept'
                            : 'Lost · forfeited'}
                      </StatusBadge>
                    </Table.Cell>
                    <Table.Cell>
                      {[
                        round.cards.length > 0 && rm(round.stake_amount),
                        round.tickets > 0 && `${round.tickets} tickets`,
                      ]
                        .filter(Boolean)
                        .join(' + ')}
                      <Text size="small" className="text-ui-fg-subtle">
                        {round.cards.length > 0
                          ? `Paid ${rm(round.win_amount)}`
                          : 'No Credit'}
                      </Text>
                    </Table.Cell>
                    <Table.Cell>
                      <details>
                        <summary className="cursor-pointer text-sm">
                          Details
                        </summary>
                        <dl className="my-3 min-w-72 space-y-2 text-xs">
                          {[
                            ['Round', round.id],
                            [
                              'Call / landed',
                              `${round.chosen_side} / ${round.landed_side}`,
                            ],
                            ['Group', round.snapshot.group_id ?? 'Default'],
                            ['Odds set', round.snapshot.odds_set],
                            [
                              'Actual / published',
                              `${round.snapshot.actual_win_units / 10000}% / ${round.published_win_percent}%`,
                            ],
                            ['Draw (0–999999)', round.roll],
                            ['Config revision', round.config_revision],
                            ['Funding source', round.snapshot.source],
                            ...(round.snapshot.valuation
                              ? [
                                  [
                                    'First card bonus share',
                                    `${round.snapshot.bonus_bp / 100}%`,
                                  ],
                                  [
                                    'First card valuation',
                                    `USD ${round.snapshot.valuation.value_usd} × ${round.snapshot.valuation.multiplier} × FX ${round.snapshot.valuation.fx}`,
                                  ],
                                  [
                                    'Quoted at',
                                    orderDateTime(
                                      round.snapshot.valuation.quoted_at,
                                    ),
                                  ],
                                ]
                              : []),
                            [
                              'Credit transaction',
                              round.credit_transaction_id ?? 'None',
                            ],
                          ].map(([label, value]) => (
                            <div key={label} className="flex flex-wrap gap-x-2">
                              <dt className="text-ui-fg-subtle">{label}:</dt>
                              <dd className="break-all">{value}</dd>
                            </div>
                          ))}
                        </dl>
                        <ul className="mb-3 max-h-64 space-y-2 overflow-y-auto text-xs">
                          {round.cards.map((card) => {
                            const stake = round.snapshot.cards?.find(
                              (s) => s.card.pull_id === card.pull_id,
                            );
                            return (
                              <li key={card.pull_id} className="border-t pt-2">
                                <p>
                                  {card.name} · {rm(card.stake_amount)}
                                </p>
                                <p className="break-all text-ui-fg-subtle">
                                  {card.pull_id}
                                </p>
                                {stake && (
                                  <p className="text-ui-fg-subtle">
                                    {stake.source} · Bonus{' '}
                                    {stake.bonus_bp / 100}% · USD{' '}
                                    {stake.valuation.value_usd} ×{' '}
                                    {stake.valuation.multiplier} × FX{' '}
                                    {stake.valuation.fx}
                                  </p>
                                )}
                              </li>
                            );
                          })}
                        </ul>
                      </details>
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          </div>
          {query.data.rounds.length === 0 && (
            <Text className="p-6 text-ui-fg-subtle">
              No completed flips match these filters.
            </Text>
          )}
          <Pager
            page={filters.page}
            onPage={(page) => setFilters({ ...filters, page })}
            pageSize={25}
            count={query.data.rounds.length}
            total={query.data.count}
          />
        </>
      )}
    </Container>
  );
}

export default function CoinFlipsPage() {
  const canEdit = usePermissions().hasPermission(
    'coin_flip:update' as Permission,
  );
  const [tab, setTab] = useState('settings');
  const [reloadKey, setReloadKey] = useState(0);
  const query = useQuery({
    queryKey: settingsKey,
    queryFn: getCoinFlipSettings,
    refetchOnWindowFocus: false,
  });
  return (
    <section aria-label="Vault coin flip" className="flex flex-col gap-4">
      <Heading level="h1">Vault coin flip</Heading>
      <Tabs value={tab} onValueChange={setTab}>
        <Tabs.List>
          <Tabs.Trigger value="settings">Settings</Tabs.Trigger>
          <Tabs.Trigger value="history">History & forfeited cards</Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content
          forceMount
          value="settings"
          className="mt-4 data-[state=inactive]:hidden"
        >
          {query.isError && !query.data ? (
            <Container>
              <Text role="alert">Could not load coin flip settings.</Text>
              <Button variant="secondary" onClick={() => void query.refetch()}>
                Retry
              </Button>
            </Container>
          ) : query.data ? (
            <Settings
              active={tab === 'settings'}
              canEdit={canEdit}
              key={reloadKey}
              saved={query.data}
              reload={() => {
                void query.refetch().then((result) => {
                  if (result.isSuccess) setReloadKey((k) => k + 1);
                });
              }}
            />
          ) : (
            <LoadingSkeleton />
          )}
        </Tabs.Content>
        <Tabs.Content value="history" className="mt-4">
          <History />
        </Tabs.Content>
      </Tabs>
    </section>
  );
}
