import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Button,
  Checkbox,
  FocusModal,
  Heading,
  Input,
  Label,
  Prompt,
  StatusBadge,
  Switch,
  Table,
  Text,
  Textarea,
  toast,
} from '@medusajs/ui';
import type { AdminPack, LosslessSchedule } from '../../lib/packs-api';
import {
  useCancelLosslessSchedule,
  useCreateLosslessSchedule,
  useLosslessSchedules,
  usePacks,
} from '../../lib/queries';
import { describeInShopZone, toLocalInput } from '../../lib/challenge-schedule';
import { losslessEligiblePacks, packsLabel } from '../../lib/lossless';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';

// The shop clock. Windows are entered on the operator's browser wall-clock (a
// datetime-local input has no zone), so every time here is echoed in the shop's
// zone — the one customers and the weekly reset run on.
const SHOP_TZ = 'Asia/Kuala_Lumpur';

const STATUS_COLOR = {
  upcoming: 'blue',
  live: 'green',
  ended: 'grey',
  cancelled: 'grey',
} as const;

const parseLocal = (v: string): Date | null => {
  const d = v === '' ? null : new Date(v);
  return d !== null && !Number.isNaN(d.getTime()) ? d : null;
};

// ── Schedule a window ────────────────────────────────────────────────────────
// Mounted only while open, so the default start (the click's clock reading) is
// seeded once by the useState initialiser and a closed modal never hands the
// operator their previous draft.
const ScheduleModal = ({
  openedAt,
  packs,
  onClose,
}: {
  /** Clock reading from the click that opened the modal. Passed in rather than
   *  read here so render stays pure. */
  openedAt: number;
  /** Eligible (paid) packs, or undefined while the list loads. */
  packs: AdminPack[] | undefined;
  onClose: () => void;
}) => {
  const { t } = useTranslation();
  const create = useCreateLosslessSchedule();
  const [startsAt, setStartsAt] = useState(() =>
    toLocalInput(new Date(openedAt)),
  );
  const [endsAt, setEndsAt] = useState('');
  const [allPacks, setAllPacks] = useState(true);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [reason, setReason] = useState('');

  const start = parseLocal(startsAt);
  const end = parseLocal(endsAt);
  const orderOk = start !== null && end !== null && end > start;
  // The route also refuses an end in the past; a clock frozen at open is enough
  // to catch the obvious slip, and the server re-checks against real time.
  const futureOk = end !== null && end.getTime() > openedAt;
  const packsOk = allPacks || picked.size > 0;
  const canSave =
    !create.isPending && orderOk && futureOk && packsOk && reason.trim() !== '';

  async function onSave() {
    if (!canSave || start === null || end === null) return;
    try {
      await create.mutateAsync({
        starts_at: start.toISOString(),
        ends_at: end.toISOString(),
        // Catalog order, so the stored list does not depend on click order.
        pack_slugs: allPacks
          ? null
          : (packs ?? []).filter((p) => picked.has(p.slug)).map((p) => p.slug),
        reason: reason.trim(),
      });
      toast.success(t('packs.lossless.toast.scheduled'));
      onClose();
    } catch {
      /* onError toasts */
    }
  }

  const togglePack = (slug: string, on: boolean) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (on) next.add(slug);
      else next.delete(slug);
      return next;
    });

  return (
    <FocusModal open onOpenChange={(o) => !o && onClose()}>
      <FocusModal.Content>
        <FocusModal.Header>
          <div className="flex items-center justify-end gap-x-2">
            <Button size="small" variant="secondary" onClick={onClose}>
              {t('packs.lossless.form.cancel')}
            </Button>
            <Button
              size="small"
              onClick={onSave}
              isLoading={create.isPending}
              disabled={!canSave}
            >
              {t('packs.lossless.form.save')}
            </Button>
          </div>
        </FocusModal.Header>
        <FocusModal.Body className="flex flex-col items-center overflow-auto p-10">
          <div className="flex w-full max-w-[640px] flex-col gap-y-6">
            <div>
              <FocusModal.Title asChild>
                <Heading level="h2">{t('packs.lossless.form.title')}</Heading>
              </FocusModal.Title>
              <FocusModal.Description asChild>
                <Text className="text-ui-fg-subtle mt-1" size="small">
                  {t('packs.lossless.form.subtitle')}
                </Text>
              </FocusModal.Description>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="flex flex-col gap-y-2">
                <Label size="small" weight="plus" htmlFor="lossless-start">
                  {t('packs.lossless.form.start')}
                </Label>
                <Input
                  id="lossless-start"
                  type="datetime-local"
                  value={startsAt}
                  onChange={(e) => setStartsAt(e.target.value)}
                />
                {start !== null && (
                  <Text className="text-ui-fg-subtle" size="small">
                    {describeInShopZone(start, SHOP_TZ)} MYT
                  </Text>
                )}
              </div>
              <div className="flex flex-col gap-y-2">
                <Label size="small" weight="plus" htmlFor="lossless-end">
                  {t('packs.lossless.form.end')}
                </Label>
                <Input
                  id="lossless-end"
                  type="datetime-local"
                  value={endsAt}
                  onChange={(e) => setEndsAt(e.target.value)}
                  aria-invalid={
                    end !== null && !(orderOk && futureOk) ? true : undefined
                  }
                />
                {end !== null && (
                  <Text className="text-ui-fg-subtle" size="small">
                    {describeInShopZone(end, SHOP_TZ)} MYT
                  </Text>
                )}
              </div>
            </div>
            {end !== null && !orderOk && (
              <Text className="text-ui-fg-error -mt-3" size="small">
                {t('packs.lossless.form.endBeforeStart')}
              </Text>
            )}
            {orderOk && !futureOk && (
              <Text className="text-ui-fg-error -mt-3" size="small">
                {t('packs.lossless.form.endPast')}
              </Text>
            )}

            <div className="bg-ui-bg-subtle flex items-center justify-between rounded-lg px-4 py-3">
              <div className="flex flex-col">
                <Label size="small" weight="plus" htmlFor="lossless-all">
                  {t('packs.lossless.form.allPacks')}
                </Label>
                <Text className="text-ui-fg-subtle text-xs">
                  {t('packs.lossless.form.allPacksHint')}
                </Text>
              </div>
              <Switch
                id="lossless-all"
                checked={allPacks}
                onCheckedChange={setAllPacks}
              />
            </div>

            {!allPacks && (
              <div className="flex flex-col gap-y-2">
                <Text size="small" weight="plus">
                  {t('packs.lossless.form.pickPacks')}
                </Text>
                {packs === undefined ? (
                  <LoadingSkeleton />
                ) : packs.length === 0 ? (
                  <Text className="text-ui-fg-subtle" size="small">
                    {t('packs.lossless.form.noPackList')}
                  </Text>
                ) : (
                  <div className="flex max-h-64 flex-col gap-y-2 overflow-auto rounded-lg border p-3">
                    {packs.map((p) => (
                      <div key={p.slug} className="flex items-center gap-x-2">
                        <Checkbox
                          id={`lossless-pack-${p.slug}`}
                          checked={picked.has(p.slug)}
                          onCheckedChange={(v) =>
                            togglePack(p.slug, v === true)
                          }
                        />
                        <Label size="small" htmlFor={`lossless-pack-${p.slug}`}>
                          {p.title}
                        </Label>
                      </div>
                    ))}
                  </div>
                )}
                {!packsOk && (
                  <Text className="text-ui-fg-subtle" size="small">
                    {t('packs.lossless.form.noPacks')}
                  </Text>
                )}
              </div>
            )}

            <div className="flex flex-col gap-y-2">
              <Label size="small" weight="plus" htmlFor="lossless-reason">
                {t('packs.lossless.form.reason')}
              </Label>
              <Textarea
                id="lossless-reason"
                maxLength={500}
                value={reason}
                placeholder={t('packs.lossless.form.reasonPlaceholder')}
                onChange={(e) => setReason(e.target.value)}
              />
            </div>
          </div>
        </FocusModal.Body>
      </FocusModal.Content>
    </FocusModal>
  );
};

// ── Cancel a window ──────────────────────────────────────────────────────────
// Mounted per target so the reason box starts empty every time. The mutation
// lives in the parent: this unmounts the moment it confirms, and a per-call
// toast callback would die with it.
const CancelPrompt = ({
  onConfirm,
  onClose,
}: {
  onConfirm: (reason: string) => void;
  onClose: () => void;
}) => {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  return (
    <Prompt open variant="danger" onOpenChange={(o) => !o && onClose()}>
      <Prompt.Content>
        <Prompt.Header>
          <Prompt.Title>{t('packs.lossless.cancel.title')}</Prompt.Title>
          <Prompt.Description>
            {t('packs.lossless.cancel.description')}
          </Prompt.Description>
        </Prompt.Header>
        <div className="flex flex-col gap-1 px-6 pb-2">
          <Label htmlFor="lossless-cancel-reason" size="small">
            {t('packs.lossless.cancel.reason')}
          </Label>
          <Textarea
            id="lossless-cancel-reason"
            maxLength={500}
            value={reason}
            placeholder={t('packs.lossless.cancel.reasonPlaceholder')}
            onChange={(e) => setReason(e.target.value)}
            autoFocus
          />
        </div>
        <Prompt.Footer>
          <Prompt.Cancel>{t('packs.lossless.cancel.keep')}</Prompt.Cancel>
          <Prompt.Action
            disabled={reason.trim() === ''}
            onClick={() => {
              if (reason.trim() === '') return;
              onConfirm(reason.trim());
              onClose();
            }}
          >
            {t('packs.lossless.cancel.confirm')}
          </Prompt.Action>
        </Prompt.Footer>
      </Prompt.Content>
    </Prompt>
  );
};

// ── The tab ──────────────────────────────────────────────────────────────────
export const LosslessTab = () => {
  const { t } = useTranslation();
  const { data, isError, refetch } = useLosslessSchedules();
  const { data: allPacks } = usePacks();
  const cancel = useCancelLosslessSchedule();
  // Non-null while the schedule modal is open; the value is the clock reading
  // taken in the click handler, where reading the clock is allowed.
  const [openedAt, setOpenedAt] = useState<number | null>(null);
  const [cancelTarget, setCancelTarget] = useState<LosslessSchedule | null>(
    null,
  );

  const eligible = allPacks ? losslessEligiblePacks(allPacks) : undefined;
  // Titles come from the FULL catalog, not the eligible list: a window made
  // before a pack was moved to a promo category should still read by name.
  const titleBySlug = new Map((allPacks ?? []).map((p) => [p.slug, p.title]));
  const when = (iso: string) => describeInShopZone(new Date(iso), SHOP_TZ);

  return (
    <div className="flex flex-col gap-y-4 px-6 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <Text className="text-ui-fg-subtle max-w-3xl" size="small">
          {t('packs.lossless.hint')}
        </Text>
        <Button
          size="small"
          variant="primary"
          onClick={() => setOpenedAt(Date.now())}
        >
          {t('packs.lossless.schedule')}
        </Button>
      </div>

      {isError ? (
        <div className="flex flex-col items-start gap-3">
          <Text className="text-ui-fg-subtle">
            {t('packs.lossless.loadError')}
          </Text>
          <Button size="small" variant="secondary" onClick={() => refetch()}>
            Retry
          </Button>
        </div>
      ) : data === undefined ? (
        <LoadingSkeleton />
      ) : data.length === 0 ? (
        <Text className="text-ui-fg-subtle">{t('packs.lossless.empty')}</Text>
      ) : (
        <Table>
          <Table.Header>
            <Table.Row>
              <Table.HeaderCell>
                {t('packs.lossless.col.start')}
              </Table.HeaderCell>
              <Table.HeaderCell>{t('packs.lossless.col.end')}</Table.HeaderCell>
              <Table.HeaderCell>
                {t('packs.lossless.col.packs')}
              </Table.HeaderCell>
              <Table.HeaderCell>
                {t('packs.lossless.col.status')}
              </Table.HeaderCell>
              <Table.HeaderCell className="text-right">
                {t('packs.lossless.col.actions')}
              </Table.HeaderCell>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {data.map((s) => (
              <Table.Row key={s.id}>
                <Table.Cell className="whitespace-nowrap tabular-nums">
                  {when(s.starts_at)}
                </Table.Cell>
                {/* effective_end, not ends_at: a window cancelled early reads as
                    ending when it was cancelled. */}
                <Table.Cell className="whitespace-nowrap tabular-nums">
                  {when(s.effective_end)}
                </Table.Cell>
                <Table.Cell className="max-w-md break-words">
                  {packsLabel(
                    s.pack_slugs,
                    titleBySlug,
                    t('packs.lossless.allPacks'),
                  )}
                </Table.Cell>
                <Table.Cell>
                  <StatusBadge color={STATUS_COLOR[s.status]}>
                    {t(`packs.lossless.status.${s.status}`)}
                  </StatusBadge>
                </Table.Cell>
                <Table.Cell className="text-right">
                  {(s.status === 'upcoming' || s.status === 'live') && (
                    <Button
                      size="small"
                      variant="transparent"
                      disabled={cancel.isPending}
                      onClick={() => setCancelTarget(s)}
                    >
                      {t('packs.lossless.cancel.action')}
                    </Button>
                  )}
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      )}

      {openedAt !== null && (
        <ScheduleModal
          openedAt={openedAt}
          packs={eligible}
          onClose={() => setOpenedAt(null)}
        />
      )}
      {cancelTarget !== null && (
        <CancelPrompt
          onClose={() => setCancelTarget(null)}
          onConfirm={(reason) =>
            cancel.mutate(
              { id: cancelTarget.id, reason },
              {
                onSuccess: () =>
                  toast.success(t('packs.lossless.toast.cancelled')),
              },
            )
          }
        />
      )}
    </div>
  );
};
