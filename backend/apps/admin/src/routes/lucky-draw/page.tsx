import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Button,
  Container,
  Heading,
  StatusBadge,
  Table,
  Text,
  toast,
} from '@medusajs/ui';
import type { RouteConfig } from '@mercurjs/dashboard-sdk';
import {
  useCancelLuckyDrawPrize,
  useCards,
  useLuckyDraw,
  usePublishLuckyDrawEvent,
  useWithdrawLuckyDrawEvent,
  type AdminLuckyDrawEvent,
  type AdminLuckyDrawPrize,
} from '../../lib/queries';
import { resolveImageUrl } from '../../lib/image-url';
import { rm } from '../../lib/format';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';
import { RowActions } from '../../components/RowActions';
import { toLocalInput } from '../tasks/task-draft';
import { EntrantsDrawer, EventEntrantsDrawer } from './entrants-drawer';
import { EventEditor } from './event-editor';
import { PrizeEditor } from './prize-editor';
import { ReasonPrompt } from './reason-prompt';
import { TicketLookup } from './ticket-lookup';
import {
  blankEventDraft,
  blankPrizeDraft,
  eventDraftFrom,
  prizeDraftFrom,
  prizeState,
  shortHash,
  whenLabel,
  type EventDraft,
  type PrizeDraft,
  type PrizeState,
} from './lucky-draw-draft';
import {
  canRemovePrize,
  canWithdraw,
  convertsOnPublish,
  eventPhase,
  eventResult,
  potPrizeState,
  prizeLock,
  publishErrorText,
  showsEventTotals,
  usesOneWinnerView,
  type EventPhase,
} from './one-winner';

// Lucky Draw (specs 2026-10-24 and 2026-10-30). An event holds a few prizes;
// players put tickets into the event, and when it ends one winner takes every
// prize, drawn from a seed committed — as a hash — when the event is published.
// Events published before that rule keep a draw per prize and their old screens
// until they finish. Every write here is audited, so every one carries a reason.
export const config: RouteConfig = {
  label: 'pcNav.luckyDraw',
  translationNs: 'translation',
  rank: 3,
  nested: '/rewards',
};

const EVENT_COLOR: Record<
  AdminLuckyDrawEvent['status'],
  'orange' | 'green' | 'grey'
> = { draft: 'orange', published: 'green', cancelled: 'grey' };

const PHASE_COLOR: Record<
  EventPhase,
  'orange' | 'blue' | 'green' | 'red' | 'grey'
> = {
  draft: 'orange',
  upcoming: 'blue',
  running: 'green',
  drawing: 'blue',
  overdue: 'red',
  drawn: 'green',
  withdrawn: 'grey',
};

const PHASE_LINE: Record<EventPhase, string> = {
  draft:
    'Draft: nothing is visible to players yet. Publishing commits a seed hash and takes the event live. When it ends, one winner takes every prize.',
  upcoming:
    'Published and not started. Prizes can still change until the start. When it ends, one winner takes every prize.',
  running:
    'Running: players can put tickets in until the end. One winner then takes every prize.',
  drawing: 'Ended: the draw runs within a minute or two.',
  overdue: 'The end has passed with no result. Check the draw job log.',
  drawn: 'Drawn: the result below is final.',
  withdrawn: 'Withdrawn: every entrant was refunded and nothing was drawn.',
};

const OLD_DRAFT_NOTE =
  'This draft was made under the old rules. Publishing switches it to one winner, and every prize’s draw time moves to the event’s end.';

const PRIZE_COLOR: Record<PrizeState, 'blue' | 'green' | 'grey' | 'red'> = {
  open: 'blue',
  drawn: 'green',
  cancelled: 'grey',
  overdue: 'red',
  ungranted: 'red',
};

const PRIZE_LABEL: Record<PrizeState, string> = {
  open: 'open',
  drawn: 'drawn',
  cancelled: 'cancelled',
  overdue: 'overdue',
  ungranted: 'Not granted',
};

/** The Status column of a prize: its state, and for a drawn one the winner and
 *  the revealed seed (anyone can recompute the winner from it). */
const PrizeOutcome = ({
  prize,
  state,
}: {
  prize: AdminLuckyDrawPrize;
  state: PrizeState;
}) => {
  const result = prize.result;
  return (
    <div className="flex flex-col items-start gap-y-1">
      <StatusBadge color={PRIZE_COLOR[state]}>{PRIZE_LABEL[state]}</StatusBadge>
      {state === 'cancelled' && prize.cancelled_at && (
        <Text size="small" className="text-ui-fg-muted">
          {whenLabel(prize.cancelled_at)} · entries refunded
        </Text>
      )}
      {state === 'overdue' && (
        <Text size="small" className="text-ui-fg-error">
          Draw time passed with no result — is the event published? Check
          the draw job log
        </Text>
      )}
      {state === 'ungranted' && (
        <Text size="small" className="text-ui-fg-error">
          Drawn, but nothing was minted or credited — fulfil by hand
        </Text>
      )}
      {(state === 'drawn' || state === 'ungranted') && result && (
        <>
          {result.winner_customer_id ? (
            <Text size="small">
              <Link
                to={`/customers/${result.winner_customer_id}`}
                className="text-ui-fg-interactive break-all hover:underline"
              >
                {result.winner_customer_id}
              </Link>{' '}
              <span className="text-ui-fg-subtle">
                · {result.winner_tickets.toLocaleString()} of{' '}
                {result.total_tickets.toLocaleString()} tickets
              </span>
            </Text>
          ) : (
            <Text size="small" className="text-ui-fg-subtle">
              No entries — no winner
            </Text>
          )}
          <Text size="xsmall" className="text-ui-fg-muted break-all">
            seed {result.seed}
          </Text>
        </>
      )}
    </div>
  );
};

/** A prize's Status on the one-winner screen. The winner and seed are the
 *  event's, shown once by EventOutcome, not on every row. */
const PotPrizeStatus = ({
  prize,
  state,
}: {
  prize: AdminLuckyDrawPrize;
  state: PrizeState;
}) => (
  <div className="flex flex-col items-start gap-y-1">
    <StatusBadge color={PRIZE_COLOR[state]}>
      {state === 'open' ? 'in the pool' : PRIZE_LABEL[state]}
    </StatusBadge>
    {state === 'cancelled' && prize.cancelled_at && (
      <Text size="small" className="text-ui-fg-muted">
        {whenLabel(prize.cancelled_at)}
      </Text>
    )}
    {state === 'ungranted' && (
      <Text size="small" className="text-ui-fg-error">
        Drawn, but nothing was minted or credited — fulfil by hand
      </Text>
    )}
  </div>
);

/** A one-winner event's commitment and, once drawn, its winner and revealed
 *  seed: what anyone needs to recompute the draw. */
const EventOutcome = ({ event }: { event: AdminLuckyDrawEvent }) => {
  const result = eventResult(event);
  return (
    <div className="flex flex-col gap-y-1 px-6 pb-4">
      {result &&
        (result.winner_customer_id ? (
          <Text size="small">
            Winner{' '}
            <Link
              to={`/customers/${result.winner_customer_id}`}
              className="text-ui-fg-interactive break-all hover:underline"
            >
              {result.winner_customer_id}
            </Link>{' '}
            <span className="text-ui-fg-subtle">
              · {result.winner_tickets.toLocaleString()} of{' '}
              {result.total_tickets.toLocaleString()} tickets ·{' '}
              {whenLabel(result.drawn_at)}
            </span>
          </Text>
        ) : (
          <Text size="small" className="text-ui-fg-subtle">
            No entries — no winner, nothing paid · {whenLabel(result.drawn_at)}
          </Text>
        ))}
      {event.seed_hash && (
        <Text size="xsmall" className="text-ui-fg-muted break-all">
          seed hash {event.seed_hash}
        </Text>
      )}
      {result && (
        <Text size="xsmall" className="text-ui-fg-muted break-all">
          seed {result.seed}
        </Text>
      )}
    </div>
  );
};

const PrizeTable = ({
  event,
  onEdit,
  onEntrants,
  onCancel,
}: {
  event: AdminLuckyDrawEvent;
  onEdit: (p: AdminLuckyDrawPrize) => void;
  onEntrants: (p: AdminLuckyDrawPrize) => void;
  onCancel: (p: AdminLuckyDrawPrize) => void;
}) => {
  const oneWinner = usesOneWinnerView(event);
  const lock = oneWinner ? prizeLock(event) : null;
  const removable = oneWinner && canRemovePrize(event);
  // A card prize shows the card's own art unless an override was uploaded;
  // only fetch the catalogue when some row actually needs it.
  const needsCards = event.prizes.some((p) => p.kind === 'card' && !p.image_url);
  const { data: cards } = useCards({ enabled: needsCards });
  const artOf = (p: AdminLuckyDrawPrize): string | null => {
    if (p.image_url) return p.image_url;
    const card = cards?.find((c) => c.handle === p.card_handle);
    return card ? (card.slab_image ?? card.image) : null;
  };

  return (
    <div className="overflow-x-auto">
      <Table>
        <Table.Header>
          <Table.Row>
            <Table.HeaderCell>Prize</Table.HeaderCell>
            <Table.HeaderCell>Kind</Table.HeaderCell>
            <Table.HeaderCell className="text-right">Value</Table.HeaderCell>
            {!oneWinner && (
              <>
                <Table.HeaderCell>Draws</Table.HeaderCell>
                <Table.HeaderCell className="text-right">
                  Tickets
                </Table.HeaderCell>
                <Table.HeaderCell className="text-right">
                  Entrants
                </Table.HeaderCell>
                <Table.HeaderCell>Seed hash</Table.HeaderCell>
              </>
            )}
            <Table.HeaderCell>Status</Table.HeaderCell>
            <Table.HeaderCell />
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {event.prizes.map((p) => {
            const art = artOf(p);
            const state = oneWinner ? potPrizeState(p) : prizeState(p);
            // An overdue prize stays editable and cancellable: cancelling is
            // how staff refund a draw that keeps failing.
            const undrawn = state === 'open' || state === 'overdue';
            const actions = oneWinner
              ? state === 'open' && lock === null
                ? [
                    { label: 'Edit', onSelect: () => onEdit(p) },
                    {
                      label: removable
                        ? 'Remove prize…'
                        : 'Can’t remove the last prize',
                      danger: true,
                      disabled: !removable,
                      onSelect: () => onCancel(p),
                    },
                  ]
                : []
              : [
                  ...(undrawn && event.status !== 'cancelled'
                    ? [{ label: 'Edit', onSelect: () => onEdit(p) }]
                    : []),
                  { label: 'Entrants', onSelect: () => onEntrants(p) },
                  ...(undrawn
                    ? [
                        {
                          label: 'Cancel prize…',
                          danger: true,
                          onSelect: () => onCancel(p),
                        },
                      ]
                    : []),
                ];
            return (
              <Table.Row key={p.id}>
                <Table.Cell>
                  <div className="flex items-center gap-x-3">
                    <div className="bg-ui-bg-subtle flex h-14 w-10 shrink-0 items-center justify-center overflow-hidden rounded">
                      {art && (
                        <img
                          src={resolveImageUrl(art)}
                          alt=""
                          loading="lazy"
                          decoding="async"
                          className="max-h-full max-w-full object-contain"
                        />
                      )}
                    </div>
                    <div className="flex items-center gap-x-2">
                      <Text size="small">{p.title}</Text>
                      <Text
                        size="small"
                        className="text-ui-fg-muted tabular-nums"
                      >
                        #{p.sort}
                      </Text>
                    </div>
                  </div>
                </Table.Cell>
                <Table.Cell className="text-ui-fg-subtle">
                  {p.kind === 'card' ? 'Card' : 'Bonus credit'}
                </Table.Cell>
                <Table.Cell className="text-right tabular-nums whitespace-nowrap">
                  {rm(p.value_myr)}
                </Table.Cell>
                {!oneWinner && (
                  <>
                    <Table.Cell className="text-ui-fg-subtle whitespace-nowrap">
                      {whenLabel(p.draw_at)}
                    </Table.Cell>
                    <Table.Cell className="text-right tabular-nums">
                      {p.total_tickets.toLocaleString()}
                    </Table.Cell>
                    <Table.Cell className="text-right tabular-nums">
                      {p.entrant_count.toLocaleString()}
                    </Table.Cell>
                    <Table.Cell className="text-ui-fg-muted font-mono text-xs">
                      {/* Only the commitment — an undrawn prize has no seed to show. */}
                      <span title={p.seed_hash ?? undefined}>
                        {shortHash(p.seed_hash)}
                      </span>
                    </Table.Cell>
                  </>
                )}
                <Table.Cell>
                  {oneWinner ? (
                    <PotPrizeStatus prize={p} state={state} />
                  ) : (
                    <PrizeOutcome prize={p} state={state} />
                  )}
                </Table.Cell>
                <Table.Cell className="text-right">
                  {actions.length > 0 && (
                    <RowActions subject={p.title} actions={actions} />
                  )}
                </Table.Cell>
              </Table.Row>
            );
          })}
        </Table.Body>
      </Table>
    </div>
  );
};

const LuckyDrawPage = () => {
  const { data, isLoading, isError } = useLuckyDraw();
  const publish = usePublishLuckyDrawEvent();
  const cancel = useCancelLuckyDrawPrize();
  const withdraw = useWithdrawLuckyDrawEvent();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [eventDraft, setEventDraft] = useState<EventDraft | null>(null);
  const [prizeDraft, setPrizeDraft] = useState<PrizeDraft | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [cancelId, setCancelId] = useState<string | null>(null);
  const [entrantsId, setEntrantsId] = useState<string | null>(null);
  const [withdrawing, setWithdrawing] = useState(false);
  const [eventEntrants, setEventEntrants] = useState(false);

  const events = data ?? [];
  // The newest event until the operator picks another; a stale id (the event
  // is gone after a refetch) falls back the same way.
  const selected = events.find((e) => e.id === selectedId) ?? events[0];
  const livePrizes = selected?.prizes.filter((p) => !p.cancelled_at) ?? [];
  const cancelPrize = selected?.prizes.find((p) => p.id === cancelId);
  const entrantsPrize = selected?.prizes.find((p) => p.id === entrantsId);
  const oneWinner = selected ? usesOneWinnerView(selected) : false;
  const lock = selected && oneWinner ? prizeLock(selected) : null;

  return (
    <div className="flex flex-col gap-y-4">
      <Container className="p-0">
        <div className="flex items-start justify-between gap-x-4 px-6 py-4">
          <div>
            <Heading level="h2">Lucky Draw</Heading>
            <Text size="small" className="text-ui-fg-subtle mt-1">
              Players put tickets into the running event. When it ends, one
              winner takes every prize, drawn from a seed committed (as a hash)
              when the event is published. Events published under the old rules
              finish prize by prize.
            </Text>
          </div>
          <Button
            size="small"
            className="shrink-0"
            onClick={() => setEventDraft(blankEventDraft())}
          >
            New event
          </Button>
        </div>

        {isError ? (
          <Text size="small" className="text-ui-fg-error px-6 pb-6">
            Failed to load Lucky Draw events.
          </Text>
        ) : isLoading || !data ? (
          <div className="px-6 pb-6">
            <LoadingSkeleton rows={3} />
          </div>
        ) : events.length === 0 ? (
          <Text size="small" className="text-ui-fg-muted px-6 pb-4">
            No events yet.
          </Text>
        ) : (
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.HeaderCell>Event</Table.HeaderCell>
                <Table.HeaderCell>Runs</Table.HeaderCell>
                <Table.HeaderCell>Status</Table.HeaderCell>
                <Table.HeaderCell className="text-right">Prizes</Table.HeaderCell>
                <Table.HeaderCell className="text-right">Tickets</Table.HeaderCell>
                <Table.HeaderCell className="text-right">Entrants</Table.HeaderCell>
                <Table.HeaderCell>Seed hash</Table.HeaderCell>
                <Table.HeaderCell>Winner</Table.HeaderCell>
                <Table.HeaderCell />
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {events.map((e) => {
                const live = e.prizes.filter((p) => !p.cancelled_at).length;
                const phase = eventPhase(e);
                const newRules = usesOneWinnerView(e);
                const totals = showsEventTotals(e);
                const result = totals ? eventResult(e) : null;
                const actions = [
                  ...(e.status !== 'cancelled'
                    ? [
                        {
                          label: 'Edit',
                          onSelect: () => setEventDraft(eventDraftFrom(e)),
                        },
                      ]
                    : []),
                  ...(e.status === 'draft'
                    ? [
                        {
                          label: 'Publish…',
                          // The backend refuses an event with no
                          // live prize; say so by not offering it.
                          disabled: live === 0,
                          onSelect: () => {
                            setSelectedId(e.id);
                            setPublishing(true);
                          },
                        },
                      ]
                    : []),
                  ...(totals
                    ? [
                        {
                          label: 'Entrants',
                          onSelect: () => {
                            setSelectedId(e.id);
                            setEventEntrants(true);
                          },
                        },
                      ]
                    : []),
                  ...(canWithdraw(e)
                    ? [
                        {
                          label: 'Withdraw event…',
                          danger: true,
                          onSelect: () => {
                            setSelectedId(e.id);
                            setWithdrawing(true);
                          },
                        },
                      ]
                    : []),
                ];
                return (
                  <Table.Row
                    key={e.id}
                    onClick={() => setSelectedId(e.id)}
                    className={`cursor-pointer ${
                      e.id === selected?.id ? 'bg-ui-bg-base-hover' : ''
                    }`}
                  >
                    <Table.Cell>
                      {/* A real button: the row's onClick is mouse-only, and
                          cancelled events have no actions menu to select from. */}
                      <button
                        type="button"
                        className="text-ui-fg-base txt-compact-small-plus text-left hover:underline"
                        aria-current={e.id === selected?.id}
                        onClick={() => setSelectedId(e.id)}
                      >
                        {e.name}
                      </button>
                    </Table.Cell>
                    <Table.Cell className="text-ui-fg-subtle whitespace-nowrap">
                      {whenLabel(e.starts_at)} → {whenLabel(e.ends_at)}
                    </Table.Cell>
                    <Table.Cell>
                      <StatusBadge
                        color={newRules ? PHASE_COLOR[phase] : EVENT_COLOR[e.status]}
                      >
                        {newRules ? phase : e.status}
                      </StatusBadge>
                    </Table.Cell>
                    <Table.Cell className="text-right tabular-nums">
                      {live}
                    </Table.Cell>
                    <Table.Cell className="text-right tabular-nums">
                      {totals ? e.total_tickets.toLocaleString() : '—'}
                    </Table.Cell>
                    <Table.Cell className="text-right tabular-nums">
                      {totals ? e.entrant_count.toLocaleString() : '—'}
                    </Table.Cell>
                    <Table.Cell className="text-ui-fg-muted font-mono text-xs">
                      <span title={(totals && e.seed_hash) || undefined}>
                        {totals ? shortHash(e.seed_hash) : '—'}
                      </span>
                    </Table.Cell>
                    <Table.Cell>
                      {result?.winner_customer_id ? (
                        <Link
                          to={`/customers/${result.winner_customer_id}`}
                          className="text-ui-fg-interactive break-all hover:underline"
                        >
                          {result.winner_customer_id}
                        </Link>
                      ) : (
                        <span className="text-ui-fg-subtle">
                          {result ? 'No entries' : '—'}
                        </span>
                      )}
                    </Table.Cell>
                    <Table.Cell className="text-right">
                      {actions.length > 0 && (
                        <RowActions subject={e.name} actions={actions} />
                      )}
                    </Table.Cell>
                  </Table.Row>
                );
              })}
            </Table.Body>
          </Table>
        )}
      </Container>

      {selected && (
        <Container className="p-0">
          <div className="flex flex-wrap items-start justify-between gap-3 px-6 py-4">
            <div>
              <Heading level="h2">Prizes — {selected.name}</Heading>
              <Text size="small" className="text-ui-fg-subtle mt-1">
                {oneWinner
                  ? PHASE_LINE[eventPhase(selected)]
                  : selected.status === 'published'
                    ? 'Published: kind, card, amount and draw time are fixed. New prizes can still be added.'
                    : 'Cancelled: this event is closed.'}
              </Text>
              {lock && (
                <Text size="small" className="text-ui-fg-subtle mt-1">
                  {lock}
                </Text>
              )}
              {convertsOnPublish(selected) && (
                <Text size="small" className="text-ui-fg-subtle mt-1">
                  {OLD_DRAFT_NOTE}
                </Text>
              )}
            </div>
            {selected.status !== 'cancelled' && (
              <div className="flex items-center gap-x-2">
                <Button
                  size="small"
                  variant="secondary"
                  disabled={lock !== null}
                  onClick={() =>
                    setPrizeDraft({
                      ...blankPrizeDraft(),
                      // Shown, so the operator sees what a blank would mean.
                      ...(oneWinner
                        ? {}
                        : { drawAt: toLocalInput(new Date(selected.ends_at)) }),
                    })
                  }
                >
                  Add prize
                </Button>
                {selected.status === 'draft' && (
                  <Button
                    size="small"
                    onClick={() => setPublishing(true)}
                    disabled={livePrizes.length === 0}
                  >
                    Publish
                  </Button>
                )}
              </div>
            )}
          </div>
          {showsEventTotals(selected) && <EventOutcome event={selected} />}
          {selected.prizes.length === 0 ? (
            <Text size="small" className="text-ui-fg-muted px-6 pb-4">
              No prizes yet. Add at least one before publishing.
            </Text>
          ) : (
            <PrizeTable
              event={selected}
              onEdit={(p) => setPrizeDraft(prizeDraftFrom(p))}
              onEntrants={(p) => setEntrantsId(p.id)}
              onCancel={(p) => setCancelId(p.id)}
            />
          )}
        </Container>
      )}

      <TicketLookup />

      {eventDraft && (
        <EventEditor
          draft={eventDraft}
          published={
            eventDraft.id !== undefined &&
            events.find((e) => e.id === eventDraft.id)?.status === 'published'
          }
          onChange={setEventDraft}
          onSaved={(id) => {
            setSelectedId(id);
            setEventDraft(null);
          }}
          onClose={() => setEventDraft(null)}
        />
      )}

      {prizeDraft && selected && (
        <PrizeEditor
          draft={prizeDraft}
          event={selected}
          // A closed editor (null) stays closed if an upload lands late.
          onChange={(update) => setPrizeDraft((d) => (d ? update(d) : d))}
          onClose={() => setPrizeDraft(null)}
        />
      )}

      {entrantsPrize && (
        <EntrantsDrawer
          prize={entrantsPrize}
          onClose={() => setEntrantsId(null)}
        />
      )}

      {eventEntrants && selected && (
        <EventEntrantsDrawer
          event={selected}
          onClose={() => setEventEntrants(false)}
        />
      )}

      {withdrawing && selected && (
        <ReasonPrompt
          danger
          title={`Withdraw ${selected.name}?`}
          description={`Every entrant is refunded at once (${selected.total_tickets.toLocaleString()} tickets from ${selected.entrant_count.toLocaleString()} ${
            selected.entrant_count === 1 ? 'player' : 'players'
          }), every prize is cancelled and no draw runs. This cannot be undone.`}
          confirmLabel="Withdraw event"
          pending={withdraw.isPending}
          onClose={() => setWithdrawing(false)}
          onConfirm={(reason) =>
            withdraw.mutate(
              { id: selected.id, reason },
              {
                onSuccess: ({ refunded }) => {
                  toast.success(
                    `Event withdrawn — ${refunded} ${
                      refunded === 1 ? 'player' : 'players'
                    } refunded.`,
                  );
                  setWithdrawing(false);
                },
                onError: (e) => toast.error(e.message),
              },
            )
          }
        />
      )}

      {publishing && selected && (
        <ReasonPrompt
          title={`Publish ${selected.name}?`}
          description={`${
            convertsOnPublish(selected) ? `${OLD_DRAFT_NOTE} ` : ''
          }This commits the event’s seed hash and takes it live with ${livePrizes.length} ${
            livePrizes.length === 1 ? 'prize' : 'prizes'
          }. The window can no longer change, and the prizes lock at the start. When it ends, one winner takes them all. To stop it after publishing, withdraw it and every entrant is refunded. Publishing cannot be undone.`}
          confirmLabel="Publish"
          pending={publish.isPending}
          onClose={() => setPublishing(false)}
          onConfirm={(reason) =>
            publish.mutate(
              { id: selected.id, reason },
              {
                onSuccess: () => {
                  toast.success('Event published.');
                  setPublishing(false);
                },
                onError: (e) => toast.error(publishErrorText(e)),
              },
            )
          }
        />
      )}

      {cancelPrize && (
        <ReasonPrompt
          danger
          title={`${oneWinner ? 'Remove' : 'Cancel'} ${cancelPrize.title}?`}
          description={
            oneWinner
              ? 'The prize leaves the event’s pool. Players can’t enter before the start, so there is nothing to refund. This cannot be undone.'
              : `The prize is withdrawn before its draw and every entrant’s tickets are refunded at once (${cancelPrize.total_tickets.toLocaleString()} tickets from ${cancelPrize.entrant_count.toLocaleString()} ${
                  cancelPrize.entrant_count === 1 ? 'player' : 'players'
                }). This cannot be undone.`
          }
          confirmLabel={oneWinner ? 'Remove prize' : 'Cancel prize'}
          pending={cancel.isPending}
          onClose={() => setCancelId(null)}
          onConfirm={(reason) =>
            cancel.mutate(
              { id: cancelPrize.id, reason },
              {
                onSuccess: ({ refunded }) => {
                  toast.success(
                    oneWinner
                      ? 'Prize removed.'
                      : `Prize cancelled — ${refunded} ${
                          refunded === 1 ? 'player' : 'players'
                        } refunded.`,
                  );
                  setCancelId(null);
                },
                onError: (e) => toast.error(e.message),
              },
            )
          }
        />
      )}
    </div>
  );
};

export default LuckyDrawPage;
