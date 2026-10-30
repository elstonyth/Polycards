import { useRef, useState, type ChangeEvent } from 'react';
import { Button, Drawer, Input, Select, Text, toast } from '@medusajs/ui';
import {
  useCards,
  useSaveLuckyDrawPrize,
  useUploadImage,
  type AdminLuckyDrawEvent,
} from '../../lib/queries';
import { validateImageFile } from '../../lib/image-validation';
import { resolveImageUrl } from '../../lib/image-url';
import { Field, StaleAwareSelect } from '../../components/form-bits';
import {
  drawTimeProblem,
  prizeDraftToPayload,
  type PrizeDraft,
} from './lucky-draw-draft';
import { usesOneWinnerView } from './one-winner';

/** Add or edit one prize. On a published event the kind, card, amount and draw
 *  time are what customers entered for, so an existing prize locks them (the
 *  backend refuses a change; this just says so up front). Title, art and order
 *  stay editable, and a NEW prize on a published event is fine. A one-winner
 *  event's prizes all draw at its end, so there is no draw time here, and
 *  nothing locks: the page only opens this before the start. */
export const PrizeEditor = ({
  draft,
  event,
  onChange,
  onClose,
}: {
  draft: PrizeDraft;
  event: AdminLuckyDrawEvent;
  /** Updater form, applied to the latest draft: an upload resolves long after
   *  the handler captured `draft`, and must not roll back what was typed
   *  meanwhile. */
  onChange: (update: (d: PrizeDraft) => PrizeDraft) => void;
  onClose: () => void;
}) => {
  const save = useSaveLuckyDrawPrize();
  const upload = useUploadImage();
  const fileRef = useRef<HTMLInputElement>(null);
  const [reason, setReason] = useState('');
  const [cardQuery, setCardQuery] = useState('');
  const patch = (changes: Partial<PrizeDraft>) =>
    onChange((d) => ({ ...d, ...changes }));
  const { data: cards } = useCards({ enabled: draft.kind === 'card' });

  const oneWinner = usesOneWinnerView(event);
  const locked = !oneWinner && event.status === 'published' && Boolean(draft.id);

  // Same search-then-select the Tasks card reward uses: useCards already holds
  // the whole list, so it is filtered client-side.
  const cardOptions = (cards ?? [])
    .filter((c) =>
      locked
        ? c.handle === draft.cardHandle
        : cardQuery.trim() === ''
          ? true
          : `${c.name} ${c.handle}`
              .toLowerCase()
              .includes(cardQuery.trim().toLowerCase()),
    )
    .slice(0, 200)
    .map((c) => ({
      value: c.handle,
      label: c.grade ? `${c.name} · ${c.grader} ${c.grade}` : c.name,
    }));

  const payload = prizeDraftToPayload(draft, event.id);
  const timeProblem = oneWinner ? null : drawTimeProblem(draft, event);
  const valid = payload !== null && timeProblem === null && reason.trim() !== '';

  const handleFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // Instant client-side gate; the server re-validates and is authoritative.
    const problem = await validateImageFile(file, 'card');
    if (problem) {
      toast.error(problem);
      if (fileRef.current) fileRef.current.value = '';
      return;
    }
    try {
      const url = await upload.mutateAsync({ file, kind: 'card' });
      patch({ imageUrl: url });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const submit = () => {
    if (!payload || !valid) return;
    save.mutate(
      {
        ...payload,
        // Locked: don't re-post the time at all (null = keep the stored one),
        // so a draw time with stray seconds can't read as a change.
        ...(locked || oneWinner ? { draw_at: null } : {}),
        reason: reason.trim(),
      },
      {
        onSuccess: () => {
          toast.success(draft.id ? 'Prize updated.' : 'Prize added.');
          onClose();
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
          <Drawer.Title>{draft.id ? 'Edit prize' : 'Add prize'}</Drawer.Title>
        </Drawer.Header>
        <Drawer.Body className="flex flex-col gap-5 overflow-y-auto">
          {locked && (
            <Text size="small" className="text-ui-fg-subtle">
              The event is published: kind, card, amount and draw time are
              fixed. Title, art and order can still change.
            </Text>
          )}

          <Field label="Kind" className="w-56">
            <Select
              value={draft.kind}
              disabled={locked}
              onValueChange={(kind) =>
                patch({ kind: kind as PrizeDraft['kind'] })
              }
            >
              <Select.Trigger>
                <Select.Value />
              </Select.Trigger>
              <Select.Content>
                <Select.Item value="card">A card</Select.Item>
                <Select.Item value="credit">Bonus credit (RM)</Select.Item>
              </Select.Content>
            </Select>
          </Field>

          {draft.kind === 'card' ? (
            <>
              {!locked && (
                <Field label="Search cards" htmlFor="ld-card-q">
                  <Input
                    id="ld-card-q"
                    value={cardQuery}
                    onChange={(e) => setCardQuery(e.target.value)}
                    placeholder="Charizard…"
                  />
                </Field>
              )}
              <Field
                label="Which card"
                hint="Goes straight to the winner's vault, like a challenge card prize."
              >
                <StaleAwareSelect
                  value={draft.cardHandle}
                  onChange={(cardHandle) => patch({ cardHandle })}
                  placeholder="Pick a card"
                  options={cardOptions}
                  disabled={locked}
                />
              </Field>
            </>
          ) : (
            <Field
              label="Amount (RM)"
              htmlFor="ld-credit"
              hint="Whole sen, up to RM 50,000. Paid to the winner as bonus credit."
              className="w-40"
            >
              <Input
                id="ld-credit"
                inputMode="decimal"
                value={draft.creditMyr}
                disabled={locked}
                onChange={(e) =>
                  patch({ creditMyr: e.target.value })
                }
                placeholder="250"
              />
            </Field>
          )}

          <Field
            label="Art"
            hint={
              draft.kind === 'credit'
                ? 'Optional — players see the credit coins if you leave this empty. 5:7 portrait, at least 600×840.'
                : 'Optional — the card’s own art shows if you leave this empty. 5:7 portrait, at least 600×840.'
            }
          >
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleFile}
            />
            <div className="flex items-center gap-x-3">
              {draft.imageUrl && (
                <img
                  src={resolveImageUrl(draft.imageUrl)}
                  alt=""
                  className="h-14 w-10 rounded object-contain"
                />
              )}
              <Button
                size="small"
                variant="secondary"
                type="button"
                onClick={() => fileRef.current?.click()}
                isLoading={upload.isPending}
              >
                {draft.imageUrl ? 'Replace image…' : 'Upload image…'}
              </Button>
              {draft.imageUrl && (
                <Button
                  size="small"
                  variant="transparent"
                  type="button"
                  onClick={() => patch({ imageUrl: '' })}
                >
                  Remove
                </Button>
              )}
            </div>
          </Field>

          <Field
            label="Title"
            htmlFor="ld-title"
            hint="Shown to players exactly as typed."
          >
            <Input
              id="ld-title"
              value={draft.title}
              maxLength={120}
              onChange={(e) => patch({ title: e.target.value })}
              placeholder="e.g. Charizard PSA 10"
            />
          </Field>

          <div className="flex flex-wrap gap-4">
            <Field
              label="Order"
              htmlFor="ld-sort"
              hint="Low numbers first."
              className="w-32"
            >
              <Input
                id="ld-sort"
                type="number"
                value={draft.sort}
                onChange={(e) => patch({ sort: e.target.value })}
              />
            </Field>
            {!oneWinner && (
              <Field
                label="Draw time"
                htmlFor="ld-draw-at"
                hint="Your browser’s time zone. Blank = when the event ends."
                className="w-56"
              >
                <Input
                  id="ld-draw-at"
                  type="datetime-local"
                  value={draft.drawAt}
                  disabled={locked}
                  onChange={(e) => patch({ drawAt: e.target.value })}
                />
              </Field>
            )}
          </div>
          {timeProblem && (
            <Text size="small" className="text-ui-fg-error -mt-3">
              {timeProblem}
            </Text>
          )}

          <Field
            label="Reason"
            htmlFor="ld-prize-reason"
            hint="Recorded against your admin account. Required."
          >
            <Input
              id="ld-prize-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Added the grand prize"
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
            {draft.id ? 'Save changes' : 'Add prize'}
          </Button>
        </Drawer.Footer>
      </Drawer.Content>
    </Drawer>
  );
};
