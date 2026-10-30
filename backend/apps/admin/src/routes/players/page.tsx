import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import {
  Badge,
  Button,
  Container,
  DropdownMenu,
  Heading,
  IconButton,
  Input,
  Label,
  Prompt,
  Select,
  StatusBadge,
  Switch,
  Table,
  Text,
  Textarea,
  toast,
  Tooltip,
} from '@medusajs/ui';
import {
  ArrowDownTray,
  CheckCircleSolid,
  EllipsisHorizontal,
  Users,
} from '@medusajs/icons';
import CreatePlayerModal from './CreatePlayerModal';
import { PeriodLeaders } from './PeriodLeaders';
import type { Permission, RouteConfig } from '@mercurjs/dashboard-sdk';
import { usePermissions } from '@mercurjs/admin';
import {
  useCustomerGroupsAdmin,
  useExportPartnerAccounts,
  usePlayers,
  useSetPlayerDisabled,
} from '../../lib/queries';
import type { PlayerRow, ProfitRange } from '../../lib/admin-rest';
import { rm, timeAgo } from '../../lib/format';
import { RangePicker } from '../overview/RangePicker';
import { dayRangeText, todayMyt } from '../overview/helpers';
import {
  DEFAULT_PLAYER_GROUP_NAME,
  isDefaultPlayerGroup,
} from '../../lib/player-groups';
import { useTableSort } from '../../lib/use-table-sort';
import { Pager } from '../../components/Pager';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';

export const config: RouteConfig = {
  label: 'pcNav.players',
  translationNs: 'translation',
  icon: Users,
  rank: 30,
  permissions: ['player:read' as Permission],
};

// The dashboard (/overview) sends a role without its figures here; a role
// without the Players page either (the automation operator) goes on to the
// one page it has.
export const handle = { permissions: 'player:read', redirectTo: '/automation' };

// The player the confirm modal is about. `disabled` here is the player's
// CURRENT state; useSetPlayerDisabled takes the TARGET state, so the mutation
// is handed the negation. The two conventions sit one line apart — don't merge.
type Target = { id: string; email: string; disabled: boolean };

// EXACTLY the backend's SORTABLE allow-list (api/admin/players/route.ts):
// every column sorts, ordered by the server over every player (2026-10-23).
type SortKey =
  | 'created_at'
  | 'email'
  | 'name'
  | 'phone'
  | 'group'
  | 'level'
  | 'wallet'
  | 'vault'
  | 'topup'
  | 'withdrawn'
  | 'contribution'
  | 'spend'
  | 'status';

// All time first: it is the default, and what the totals meant before the
// period picker existed.
const PERIODS: readonly ProfitRange[] = [
  'all',
  'today',
  'yesterday',
  '7d',
  '30d',
  'month',
  'last_month',
  'custom',
];

// The sort with no column of its own (email) lives in this menu with the
// common ones; the headers sort too. Each is `key:dir`.
const SORTS = [
  'created_at:desc',
  'topup:desc',
  'withdrawn:desc',
  'contribution:desc',
  'spend:desc',
  'wallet:desc',
  'email:asc',
] as const;

// Two letters for the avatar: initials of the name, else the email's start.
const initials = (p: PlayerRow): string => {
  const words = (p.name ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return words[0][0] + words[1][0];
  return (words[0] ?? p.email).slice(0, 2);
};

// '12 Oct' this year, '12 Oct 2025' before it — in Malaysia time.
const joined = (iso: string): string => {
  const opts = { timeZone: 'Asia/Kuala_Lumpur' } as const;
  const year = (d: Date) =>
    d.toLocaleDateString('en-MY', { ...opts, year: 'numeric' });
  const d = new Date(iso);
  return d.toLocaleDateString('en-MY', {
    ...opts,
    day: 'numeric',
    month: 'short',
    ...(year(d) === year(new Date()) ? {} : { year: 'numeric' }),
  });
};

// The All Players list (spec 2026-10-14-admin-finance-pages §8): who, how to
// reach them, their group and level, and the money figures (the top-up and
// withdraw totals came back 2026-10-15, at the operator's request). Everything
// else (real name, pulls) is on the player's own page, one click away.
const PlayersPage = () => {
  const { t } = useTranslation();
  // A view-only role (Support viewer) reads players but changes nothing, and
  // has no dashboard figures: hide the leaders board (GET /admin/stats) and
  // the Generate button (POST /admin/players) rather than show it a 403. The
  // logins export carries partner passwords, so it asks its own policy.
  const perms = usePermissions();
  const canSeeStats = perms.hasPermission('stats:read' as Permission);
  const canCreate = perms.hasPermission('player:update' as Permission);
  const canExport = perms.hasPermission(
    'partner_credential:read' as Permission,
  );
  const navigate = useNavigate();
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  // '' = every group; 'default' = outside every non-default group; else an id.
  const [group, setGroup] = useState('');
  // The period the turnover and money in/out columns (and their sorts) cover.
  const [range, setRange] = useState<ProfitRange>('all');
  const [from, setFrom] = useState(todayMyt);
  const [to, setTo] = useState(todayMyt);
  const [target, setTarget] = useState<Target | null>(null);
  const [reason, setReason] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const exporter = useExportPartnerAccounts();
  // Names the default group for players with no stored membership (the
  // constant is the fallback before the list resolves), and fills the filter.
  const { data: groupList } = useCustomerGroupsAdmin();
  const groups = groupList?.customer_groups ?? [];
  const defaultGroupName =
    groups.find(isDefaultPlayerGroup)?.name ?? DEFAULT_PLAYER_GROUP_NAME;
  const otherGroups = groups.filter((g) => !isDefaultPlayerGroup(g));

  // 300 ms debounce — the list refetches on the settled value, not per keystroke.
  useEffect(() => {
    const id = setTimeout(() => setQ(search.trim()), 300);
    return () => clearTimeout(id);
  }, [search]);

  // Sorting resets to page 0 — the operator re-ordered the whole result set,
  // so staying on page 3 of the old order would show an arbitrary slice.
  const { sort, setSort, sortHeader } = useTableSort<SortKey>(
    { key: 'created_at', dir: 'desc' },
    { onChange: () => setPage(0) },
  );

  // A blank filter is passed as undefined, never ''. listPlayers omits it from
  // the URL either way, but qk.players(page, '') and qk.players(page, undefined)
  // are DIFFERENT cache keys — type-then-clear would double-cache every
  // unfiltered page and refetch what is already in hand.
  const { data, isError, isPlaceholderData } = usePlayers(
    page,
    q || undefined,
    sort ? `${sort.key}:${sort.dir}` : 'created_at:desc',
    group || undefined,
    range === 'all'
      ? undefined
      : range === 'custom'
        ? { range, from, to }
        : { range },
  );
  const setDisabled = useSetPlayerDisabled();

  const closeModal = () => {
    setTarget(null);
    setReason('');
  };

  // Reason is cleared on OPEN, not only on close: a value left over from the
  // previous player would be written to the audit log as that player's reason.
  const openModal = (p: PlayerRow) => {
    setReason('');
    setTarget({ id: p.id, email: p.email, disabled: p.disabled });
  };

  // No try/finally: the React Compiler skips a component that has one.
  async function applyDisable() {
    if (!target || !reason.trim()) return;
    await setDisabled
      .mutateAsync({
        id: target.id,
        disabled: !target.disabled,
        reason: reason.trim(),
      })
      // The hook's onError already surfaced a toast; swallowing keeps the
      // rejection from being unhandled, and the modal closes either way.
      .catch(() => undefined);
    closeModal();
  }

  const exportLogins = () => {
    toast.info(t('players.exportStarted'));
    exporter.mutate(undefined, {
      onSuccess: () => toast.success(t('players.exportDone')),
    });
  };
  // A header sort the menu doesn't list (name, oldest first…) shows 'Sort'.
  const sortValue = sort ? `${sort.key}:${sort.dir}` : 'created_at:desc';
  const menuSort = (SORTS as readonly string[]).includes(sortValue)
    ? sortValue
    : '';

  return (
    <div className="flex flex-col gap-y-3">
      {canSeeStats && <PeriodLeaders />}
      <Container className="p-0">
        <div className="flex flex-wrap items-start justify-between gap-4 px-6 py-4">
          <div>
            <Heading level="h2">{t('players.title')}</Heading>
            <Text className="text-ui-fg-subtle mt-1 max-w-xl" size="small">
              {data?.window
                ? t('players.periodNote', {
                    window: dayRangeText(data.window),
                  })
                : t('players.subtitle')}
            </Text>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={group || 'all'}
              onValueChange={(v) => {
                setGroup(v === 'all' ? '' : v);
                setPage(0);
              }}
            >
              <Select.Trigger
                className="w-44"
                aria-label={t('players.groupFilter')}
              >
                <Select.Value />
              </Select.Trigger>
              <Select.Content>
                <Select.Item value="all">{t('players.allGroups')}</Select.Item>
                <Select.Item value="default">{defaultGroupName}</Select.Item>
                {otherGroups.map((g) => (
                  <Select.Item key={g.id} value={g.id}>
                    {g.name}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select>
            <Select
              value={menuSort}
              onValueChange={(v) => {
                const [key, dir] = v.split(':') as [SortKey, 'asc' | 'desc'];
                setSort({ key, dir });
                setPage(0);
              }}
            >
              <Select.Trigger className="w-44" aria-label={t('players.sortBy')}>
                <Select.Value placeholder={t('players.sortBy')} />
              </Select.Trigger>
              <Select.Content>
                {SORTS.map((v) => (
                  <Select.Item key={v} value={v}>
                    {t(`players.sort.${v.replace(':', '_')}`)}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select>
            <Input
              type="search"
              className="w-72"
              placeholder={t('players.searchPlaceholder')}
              aria-label={t('players.searchPlaceholder')}
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(0);
              }}
            />
            {canCreate && (
              <Button
                size="base"
                variant="secondary"
                onClick={() => setCreateOpen(true)}
              >
                {t('players.generate')}
              </Button>
            )}
            {canExport && (
              <DropdownMenu>
                <DropdownMenu.Trigger asChild>
                  <IconButton aria-label={t('players.more')}>
                    <EllipsisHorizontal />
                  </IconButton>
                </DropdownMenu.Trigger>
                <DropdownMenu.Content align="end">
                  {/* The .xlsx of every generated partner login — the same rows
                      the generator shows once, so a closed modal loses nothing. */}
                  <DropdownMenu.Item
                    className="gap-x-2"
                    disabled={exporter.isPending}
                    onClick={exportLogins}
                  >
                    <ArrowDownTray className="text-ui-fg-subtle" />
                    {t('players.exportShort')}
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu>
            )}
          </div>
        </div>
        <div className="px-6 pb-4">
          <RangePicker
            range={range}
            onRange={(r) => {
              setRange(r);
              setPage(0);
            }}
            ranges={PERIODS}
            from={from}
            to={to}
            onFrom={(v) => {
              setFrom(v);
              setPage(0);
            }}
            onTo={(v) => {
              setTo(v);
              setPage(0);
            }}
          />
        </div>

        {isError ? (
          <div className="border-t px-6 py-8">
            <Text className="text-ui-fg-subtle">{t('players.loadError')}</Text>
          </div>
        ) : !data ? (
          <div className="border-t px-6 py-8">
            <LoadingSkeleton />
          </div>
        ) : data.players.length === 0 ? (
          <div className="border-t px-6 py-8">
            <Text className="text-ui-fg-subtle">
              {q
                ? t('players.noResults')
                : group
                  ? t('players.noGroupResults')
                  : t('players.empty')}
            </Text>
          </div>
        ) : (
          <div
            className="overflow-x-auto"
            tabIndex={0}
            role="region"
            aria-label="Players table"
          >
            <Table>
              <Table.Header>
                <Table.Row>
                  {sortHeader('name', t('players.player'))}
                  {sortHeader('phone', t('players.phone'))}
                  {sortHeader('group', t('players.group'))}
                  {sortHeader('level', t('players.level'))}
                  {sortHeader('wallet', t('players.wallet'), true)}
                  {sortHeader('vault', t('players.vault'), true)}
                  {sortHeader('topup', t('players.topup'), true)}
                  {sortHeader('withdrawn', t('players.withdrawn'), true)}
                  {sortHeader(
                    'contribution',
                    t('players.netDeposit'),
                    true,
                    t('players.contributionHint'),
                  )}
                  {sortHeader('spend', t('players.spend'), true)}
                  {sortHeader('created_at', t('players.joined'))}
                  {sortHeader('status', t('players.status'))}
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {data.players.map((p) => {
                  const groupName = p.player_group ?? defaultGroupName;
                  return (
                    <Table.Row
                      key={p.id}
                      className="cursor-pointer"
                      onClick={() => navigate(`/customers/${p.id}`)}
                    >
                      <Table.Cell>
                        {/* Capped so a long email truncates (full text on
                            hover) instead of pushing the money off-screen. */}
                        <div
                          className="flex min-w-0 max-w-[13rem] items-center gap-3"
                          title={p.email}
                        >
                          <span
                            aria-hidden
                            className="bg-ui-bg-component text-ui-fg-subtle txt-compact-xsmall-plus flex size-8 shrink-0 items-center justify-center rounded-full uppercase"
                          >
                            {initials(p)}
                          </span>
                          <span className="min-w-0">
                            {/* Real button so the row is reachable by keyboard
                                too; stopPropagation keeps the row handler from
                                firing a second navigate to the same route.
                                Falls back to the EMAIL: `name` is nullable,
                                and a nameless button would announce nothing. */}
                            <button
                              type="button"
                              className="text-ui-fg-interactive block w-full truncate text-left hover:underline"
                              onClick={(e) => {
                                e.stopPropagation();
                                navigate(`/customers/${p.id}`);
                              }}
                            >
                              {p.name ?? p.email}
                            </button>
                            <Text
                              as="span"
                              size="xsmall"
                              className="text-ui-fg-subtle block truncate"
                            >
                              {p.email}
                            </Text>
                          </span>
                        </div>
                      </Table.Cell>
                      {/* With the phone gate live, "why can't this player top
                          up or request delivery?" is a question this list has
                          to answer: a tick means the phone is verified. */}
                      <Table.Cell className="text-ui-fg-subtle whitespace-nowrap">
                        {p.phone ? (
                          <span className="inline-flex items-center gap-1.5">
                            {p.phone}
                            {p.phone_verified ? (
                              <Tooltip content={t('players.verifiedYes')}>
                                <span
                                  role="img"
                                  tabIndex={0}
                                  aria-label={t('players.verifiedYes')}
                                  className="inline-flex"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  <CheckCircleSolid
                                    aria-hidden
                                    className="text-ui-tag-green-icon"
                                  />
                                </span>
                              </Tooltip>
                            ) : null}
                          </span>
                        ) : (
                          '—'
                        )}
                      </Table.Cell>
                      <Table.Cell>
                        {/* No stored membership is not "no odds" — it rolls set
                            1, exactly what DEFAULT's members roll, so it reads
                            as the default group (resolved from the group list:
                            the group can be renamed). */}
                        <Badge
                          size="2xsmall"
                          color={
                            groupName === defaultGroupName ? 'grey' : 'blue'
                          }
                          className="max-w-32 truncate"
                        >
                          {groupName}
                        </Badge>
                      </Table.Cell>
                      <Table.Cell className="whitespace-nowrap">
                        LV {p.vip_level}
                      </Table.Cell>
                      <Table.Cell className="text-right tabular-nums whitespace-nowrap">
                        {rm(p.wallet_balance)}
                      </Table.Cell>
                      <Table.Cell className="text-right tabular-nums whitespace-nowrap">
                        {p.vault_count > 0 ? (
                          <>
                            {rm(p.vault_value)}
                            <span className="text-ui-fg-subtle text-xs">
                              {' '}
                              ({p.vault_count})
                            </span>
                          </>
                        ) : (
                          <span className="text-ui-fg-muted">—</span>
                        )}
                      </Table.Cell>
                      <Table.Cell className="text-right tabular-nums whitespace-nowrap">
                        {rm(p.total_topup)}
                      </Table.Cell>
                      <Table.Cell className="text-right tabular-nums whitespace-nowrap">
                        {rm(p.total_withdrawn)}
                      </Table.Cell>
                      {/* Negative = the player has taken out more than they
                          put in (wins cashed out), so it reads red. */}
                      <Table.Cell
                        className={`text-right tabular-nums whitespace-nowrap ${
                          p.total_contribution < 0 ? 'text-ui-fg-error' : ''
                        }`}
                      >
                        <Tooltip
                          content={t('players.netDepositHint', {
                            topup: rm(p.total_topup),
                            withdrawn: rm(p.total_withdrawn),
                          })}
                        >
                          <span
                            tabIndex={0}
                            onClick={(e) => e.stopPropagation()}
                          >
                            {rm(p.total_contribution)}
                          </span>
                        </Tooltip>
                      </Table.Cell>
                      <Table.Cell className="text-right tabular-nums whitespace-nowrap">
                        {rm(p.total_spend)}
                      </Table.Cell>
                      <Table.Cell className="text-ui-fg-subtle whitespace-nowrap">
                        {joined(p.registered_at)}
                        {p.last_spend_at ? (
                          <Text
                            as="span"
                            size="xsmall"
                            className="text-ui-fg-subtle block"
                          >
                            {t('players.activeAgo', {
                              ago: timeAgo(p.last_spend_at),
                            })}
                          </Text>
                        ) : null}
                        {p.disabled ? (
                          <span className="mt-0.5 block">
                            <StatusBadge color="red">
                              {t('players.disabled')}
                            </StatusBadge>
                          </span>
                        ) : null}
                      </Table.Cell>
                      {/* The switch NEVER writes on its own — it only opens the
                          confirm modal, so `checked` stays a pure mirror of the
                          server state until the mutation lands. It is also
                          gated on isPlaceholderData: keepPreviousData leaves
                          the OLD rows on screen while a new page/search loads,
                          and blocking a player off a stale row is
                          unrecoverable by the operator. */}
                      <Table.Cell onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center gap-2">
                          <Switch
                            size="small"
                            checked={!p.disabled}
                            disabled={isPlaceholderData}
                            onCheckedChange={() => openModal(p)}
                            aria-label={`${p.disabled ? t('players.disabled') : t('players.active')} — ${p.email}`}
                          />
                          {/* Partner account (spec 2026-09-09) — visible from
                              the list: "is this player on a special rate?" is
                              asked from here. The title names the source,
                              because a group partner cannot be changed on the
                              profile's Referral card. */}
                          {p.partner && (
                            <StatusBadge
                              color="purple"
                              title={
                                p.partner === 'group'
                                  ? p.partner_group
                                    ? t('players.partnerViaGroup', {
                                        group: p.partner_group,
                                      })
                                    : t('players.partner')
                                  : t('players.partnerManual')
                              }
                            >
                              {t('players.partner')}
                            </StatusBadge>
                          )}
                        </div>
                      </Table.Cell>
                    </Table.Row>
                  );
                })}
              </Table.Body>
            </Table>
          </div>
        )}

        {data && (
          <Pager
            page={page}
            onPage={setPage}
            pageSize={data.limit}
            count={data.players.length}
            total={data.total}
          />
        )}
      </Container>

      {/* ── Confirm modal — mandatory audited reason, both directions ─────── */}
      <Prompt
        // Prompt defaults to 'danger' (red confirm). Blocking a login is
        // destructive; lifting the block is not.
        variant={target?.disabled ? 'confirmation' : 'danger'}
        open={target !== null}
        onOpenChange={(open) => {
          if (!open) closeModal();
        }}
      >
        <Prompt.Content>
          <Prompt.Header>
            <Prompt.Title>
              {t(
                target?.disabled
                  ? 'players.enableTitle'
                  : 'players.disableTitle',
              )}
            </Prompt.Title>
            <Prompt.Description>
              {t(
                target?.disabled ? 'players.enableDesc' : 'players.disableDesc',
              )}
            </Prompt.Description>
          </Prompt.Header>

          <div className="flex flex-col gap-1 px-6 pb-2">
            <Label htmlFor="players-reason" size="small">
              {t('players.reasonLabel')}
            </Label>
            {/* Server caps the reason at 500 chars. Capping here too, because
                Radix closes the dialog on Action click — a 400 would take the
                typed text down with it. */}
            <Textarea
              id="players-reason"
              maxLength={500}
              value={reason}
              placeholder={t('players.reasonPlaceholder')}
              onChange={(e) => setReason(e.target.value)}
              autoFocus
            />
          </div>

          <Prompt.Footer>
            <Prompt.Cancel>{t('players.cancel')}</Prompt.Cancel>
            <Prompt.Action
              onClick={applyDisable}
              disabled={!reason.trim() || setDisabled.isPending}
            >
              {t('players.confirm')}
            </Prompt.Action>
          </Prompt.Footer>
        </Prompt.Content>
      </Prompt>

      <CreatePlayerModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
      />
    </div>
  );
};

export default PlayersPage;
