import { useState } from 'react';
import { Button, Drawer, Input, Text, toast } from '@medusajs/ui';
import { useSaveLuckyDrawEvent } from '../../lib/queries';
import { Field, Section } from '../../components/form-bits';
import { toIso } from '../tasks/task-draft';
import { CreditPrizeRows } from './credit-prize-rows';
import { InventoryPicker } from './inventory-picker';
import { eventDraftToPayload, type EventDraft } from './lucky-draw-draft';
import {
  MAX_NEW_EVENT_PRIZES,
  newEventPayload,
  poolSummary,
  type PoolCard,
  type PoolCredit,
} from './prize-pool';

/** Create or edit an event: name and window. Once published only the name may
 *  change (the window is what customers saw), so the times lock. A NEW event
 *  also takes its prize pool — cards picked from the inventory plus credit
 *  prizes — and is created with them in one request. An existing event's
 *  prizes are the prize editor's. */
export const EventEditor = ({
  draft,
  published,
  onChange,
  onSaved,
  onClose,
}: {
  draft: EventDraft;
  published: boolean;
  onChange: (d: EventDraft) => void;
  onSaved: (id: string) => void;
  onClose: () => void;
}) => {
  const save = useSaveLuckyDrawEvent();
  const [reason, setReason] = useState('');
  const [cards, setCards] = useState<PoolCard[]>([]);
  const [credits, setCredits] = useState<PoolCredit[]>([]);

  const creating = !draft.id;
  const payload = creating
    ? newEventPayload(draft, cards, credits)
    : eventDraftToPayload(draft);
  const poolFull = cards.length + credits.length >= MAX_NEW_EVENT_PRIZES;
  const starts = toIso(draft.startsAt);
  const ends = toIso(draft.endsAt);
  const windowBad =
    starts && ends && new Date(ends).getTime() <= new Date(starts).getTime()
      ? 'The end must be after the start.'
      : null;
  const valid = payload !== null && reason.trim() !== '';

  const submit = () => {
    if (!payload || !valid) return;
    save.mutate(
      { ...payload, reason: reason.trim() },
      {
        onSuccess: ({ id }) => {
          toast.success(
            draft.id
              ? 'Event updated.'
              : cards.length + credits.length > 0
                ? `Event created with ${cards.length + credits.length} prizes.`
                : 'Event created.',
          );
          onSaved(id);
        },
        onError: (e) => toast.error(e.message),
      },
    );
  };

  return (
    <Drawer
      open
      onOpenChange={(open) => {
        if (!open && !save.isPending) onClose();
      }}
    >
      <Drawer.Content>
        <Drawer.Header>
          <Drawer.Title>{draft.id ? 'Edit event' : 'New event'}</Drawer.Title>
        </Drawer.Header>
        <Drawer.Body className="flex flex-col gap-5 overflow-y-auto">
          <Field
            label="Name"
            htmlFor="ld-event-name"
            hint="Shown to players as the draw's title."
          >
            <Input
              id="ld-event-name"
              value={draft.name}
              maxLength={80}
              onChange={(e) => onChange({ ...draft, name: e.target.value })}
              placeholder="e.g. November Lucky Draw"
            />
          </Field>

          <div className="flex flex-wrap gap-4">
            <Field label="Starts" htmlFor="ld-event-starts" className="w-56">
              <Input
                id="ld-event-starts"
                type="datetime-local"
                value={draft.startsAt}
                disabled={published}
                onChange={(e) =>
                  onChange({ ...draft, startsAt: e.target.value })
                }
              />
            </Field>
            <Field label="Ends" htmlFor="ld-event-ends" className="w-56">
              <Input
                id="ld-event-ends"
                type="datetime-local"
                value={draft.endsAt}
                disabled={published}
                onChange={(e) => onChange({ ...draft, endsAt: e.target.value })}
              />
            </Field>
          </div>
          <Text size="small" className="text-ui-fg-subtle -mt-3">
            {published
              ? 'A published event can only be renamed — its window is fixed.'
              : 'Your browser’s time zone. Malaysia time is UTC+8.'}
          </Text>
          {windowBad && (
            <Text size="small" className="text-ui-fg-error -mt-3">
              {windowBad}
            </Text>
          )}

          {creating && (
            <Section
              title="Prize pool"
              description="Cards come from the inventory; picking one holds no stock. The event is created as a draft — publish it from the Lucky Draw page."
            >
              <Field label="Cards from inventory">
                <InventoryPicker
                  selected={cards}
                  onChange={setCards}
                  canAddMore={!poolFull}
                />
              </Field>
              <Field label="Credit prizes">
                <CreditPrizeRows
                  credits={credits}
                  onChange={setCredits}
                  canAddMore={!poolFull}
                />
              </Field>
              <div>
                <Text weight="plus" aria-live="polite">
                  {poolSummary(cards, credits)}
                </Text>
                <Text size="small" className="text-ui-fg-subtle">
                  Each prize draws when the event ends. Change a prize’s draw
                  time after creating it.
                </Text>
                {poolFull && (
                  <Text size="small" className="text-ui-fg-subtle">
                    A new event takes at most {MAX_NEW_EVENT_PRIZES} prizes.
                  </Text>
                )}
              </div>
            </Section>
          )}

          <Field
            label="Reason"
            htmlFor="ld-event-reason"
            hint="Recorded against your admin account. Required."
          >
            <Input
              id="ld-event-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Set up the November draw"
            />
          </Field>
        </Drawer.Body>
        <Drawer.Footer>
          <Drawer.Close asChild>
            <Button size="small" variant="secondary" disabled={save.isPending}>
              Cancel
            </Button>
          </Drawer.Close>
          <Button
            size="small"
            onClick={submit}
            isLoading={save.isPending}
            disabled={!valid || save.isPending}
          >
            {draft.id ? 'Save changes' : 'Create event'}
          </Button>
        </Drawer.Footer>
      </Drawer.Content>
    </Drawer>
  );
};
