import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import {
  Badge,
  Container,
  Heading,
  Input,
  Label,
  Prompt,
  StatusBadge,
  Switch,
  Table,
  Text,
  Textarea,
} from '@medusajs/ui';
import { Users } from '@medusajs/icons';
import type { RouteConfig } from '@mercurjs/dashboard-sdk';
import { usePlayers, useSetPlayerDisabled } from '../../lib/queries';
import type { PlayerRow } from '../../lib/admin-rest';
import { orderDateTime, rm } from '../../lib/format';
import { Pager } from '../../components/Pager';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';

// rank 0 puts this above the core Customers list inside the same group.
export const config: RouteConfig = {
  label: 'Players',
  icon: Users,
  nested: '/customers',
  rank: 0,
};

// The player the confirm modal is about. `disabled` here is the player's
// CURRENT state; useSetPlayerDisabled takes the TARGET state, so the mutation
// is handed the negation. The two conventions sit one line apart — don't merge.
type Target = { id: string; email: string; disabled: boolean };

const PlayersPage = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [target, setTarget] = useState<Target | null>(null);
  const [reason, setReason] = useState('');

  // 300 ms debounce — the list refetches on the settled value, not per keystroke.
  useEffect(() => {
    const id = setTimeout(() => setQ(search.trim()), 300);
    return () => clearTimeout(id);
  }, [search]);

  // A blank filter is passed as undefined, never ''. listPlayers omits it from
  // the URL either way, but qk.players(page, '') and qk.players(page, undefined)
  // are DIFFERENT cache keys — type-then-clear would double-cache every
  // unfiltered page and refetch what is already in hand.
  const { data, isError, isPlaceholderData } = usePlayers(page, q || undefined);
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

  async function applyDisable() {
    if (!target || !reason.trim()) return;
    try {
      await setDisabled.mutateAsync({
        id: target.id,
        disabled: !target.disabled,
        reason: reason.trim(),
      });
    } catch {
      // The hook's onError already surfaced a toast. Swallowing here keeps the
      // rejection from being unhandled and lets `finally` reset either way.
    } finally {
      closeModal();
    }
  }

  return (
    <div className="flex flex-col gap-y-3">
      <Container className="p-0">
        <div className="flex flex-wrap items-start justify-between gap-4 px-6 py-4">
          <div>
            <Heading level="h2">{t('players.title')}</Heading>
            <Text className="text-ui-fg-subtle mt-1" size="small">
              {t('players.subtitle')}
            </Text>
          </div>
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
            <Text className="text-ui-fg-subtle">{t('players.empty')}</Text>
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
                  <Table.HeaderCell>{t('players.name')}</Table.HeaderCell>
                  <Table.HeaderCell>{t('players.email')}</Table.HeaderCell>
                  <Table.HeaderCell>{t('players.phone')}</Table.HeaderCell>
                  <Table.HeaderCell>{t('players.group')}</Table.HeaderCell>
                  <Table.HeaderCell>{t('players.lvl')}</Table.HeaderCell>
                  <Table.HeaderCell className="text-right">
                    {t('players.wallet')}
                  </Table.HeaderCell>
                  <Table.HeaderCell className="text-right">
                    {t('players.vault')}
                  </Table.HeaderCell>
                  <Table.HeaderCell className="text-right">
                    {t('players.spend')}
                  </Table.HeaderCell>
                  <Table.HeaderCell className="text-right">
                    {t('players.pulls')}
                  </Table.HeaderCell>
                  <Table.HeaderCell>{t('players.registered')}</Table.HeaderCell>
                  <Table.HeaderCell>{t('players.lastSpend')}</Table.HeaderCell>
                  <Table.HeaderCell>{t('players.status')}</Table.HeaderCell>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {data.players.map((p) => (
                  <Table.Row
                    key={p.id}
                    className="cursor-pointer"
                    onClick={() => navigate(`/customers/${p.id}`)}
                  >
                    <Table.Cell>
                      {/* Real button so the row is reachable by keyboard too;
                          stopPropagation keeps the row handler from firing a
                          second navigate to the same route. Falls back to the
                          EMAIL, not an em-dash: `name` is nullable, and a
                          screen reader on a nameless row would otherwise
                          announce "— button" with no way to tell which player
                          it opens. Same fallback shape as the pulls page. */}
                      <button
                        type="button"
                        className="text-ui-fg-interactive hover:underline"
                        onClick={(e) => {
                          e.stopPropagation();
                          navigate(`/customers/${p.id}`);
                        }}
                      >
                        {p.name ?? p.email}
                      </button>
                    </Table.Cell>
                    <Table.Cell className="text-ui-fg-subtle break-words">
                      {p.email}
                    </Table.Cell>
                    <Table.Cell className="text-ui-fg-subtle whitespace-nowrap">
                      {p.phone ?? '—'}
                    </Table.Cell>
                    <Table.Cell className="text-ui-fg-subtle">
                      {p.groups[0] ?? '—'}
                    </Table.Cell>
                    <Table.Cell className="whitespace-nowrap">
                      <Badge size="2xsmall">LV {p.vip_level}</Badge>
                    </Table.Cell>
                    <Table.Cell className="text-right tabular-nums whitespace-nowrap">
                      {rm(p.wallet_balance)}
                    </Table.Cell>
                    <Table.Cell className="text-right tabular-nums whitespace-nowrap">
                      {rm(p.vault_value)}{' '}
                      <span className="text-ui-fg-muted text-xs">
                        ({p.vault_count})
                      </span>
                    </Table.Cell>
                    <Table.Cell className="text-right tabular-nums whitespace-nowrap">
                      {rm(p.total_spend)}
                    </Table.Cell>
                    <Table.Cell className="text-right tabular-nums">
                      {p.total_pulls}
                    </Table.Cell>
                    <Table.Cell className="text-ui-fg-subtle whitespace-nowrap">
                      {orderDateTime(p.registered_at)}
                    </Table.Cell>
                    <Table.Cell className="text-ui-fg-subtle whitespace-nowrap">
                      {p.last_spend_at ? orderDateTime(p.last_spend_at) : '—'}
                    </Table.Cell>
                    {/* The switch NEVER writes on its own — it only opens the
                        confirm modal, so `checked` stays a pure mirror of the
                        server state until the mutation lands. It is also gated
                        on isPlaceholderData: keepPreviousData leaves the OLD
                        rows on screen while a new page/search loads, and
                        blocking a player off a stale row is unrecoverable by
                        the operator. */}
                    <Table.Cell onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center gap-2">
                        <Switch
                          checked={!p.disabled}
                          disabled={isPlaceholderData}
                          onCheckedChange={() => openModal(p)}
                          aria-label={`${p.disabled ? t('players.disabled') : t('players.active')} — ${p.email}`}
                        />
                        <StatusBadge color={p.disabled ? 'red' : 'green'}>
                          {p.disabled ? t('players.disabled') : t('players.active')}
                        </StatusBadge>
                      </div>
                    </Table.Cell>
                  </Table.Row>
                ))}
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
              {t(target?.disabled ? 'players.enableTitle' : 'players.disableTitle')}
            </Prompt.Title>
            <Prompt.Description>
              {t(target?.disabled ? 'players.enableDesc' : 'players.disableDesc')}
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
            <Prompt.Action onClick={applyDisable} disabled={!reason.trim()}>
              {t('players.confirm')}
            </Prompt.Action>
          </Prompt.Footer>
        </Prompt.Content>
      </Prompt>
    </div>
  );
};

export default PlayersPage;
