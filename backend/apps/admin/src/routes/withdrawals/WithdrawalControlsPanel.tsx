import type { Permission } from '@mercurjs/dashboard-sdk';
import { usePermissions } from '@mercurjs/admin';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Button,
  Container,
  Heading,
  Input,
  Label,
  StatusBadge,
  Switch,
  Text,
  usePrompt,
} from '@medusajs/ui';
import {
  useSaveWithdrawalControls,
  useWithdrawalControls,
} from '../../lib/queries';
import type {
  ChannelControl,
  ChannelStatus,
  WithdrawalControls,
} from '../../lib/admin-rest';

// Every time here is Malaysia time (UTC+8 all year), whatever the browser's.
const MYT_MS = 8 * 60 * 60 * 1000;

/** "Sat 18 Oct, 6:00 am" in Malaysia time. */
const mytWhen = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', {
    timeZone: 'Asia/Kuala_Lumpur',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });

/** ISO instant <-> the "YYYY-MM-DDTHH:MM" a datetime-local input holds, MYT. */
const toMytInput = (iso: string) =>
  new Date(Date.parse(iso) + MYT_MS).toISOString().slice(0, 16);
const fromMytInput = (local: string) =>
  new Date(Date.parse(`${local}:00+08:00`)).toISOString();

const scheduleIncomplete = (c: ChannelControl) =>
  c.schedule.on && (!c.schedule.close_at || !c.schedule.reopen_at);

// A switch-off whose reopen time has passed is already open again (the
// backend decides by the clock), so show and resave it as on.
const settle = <C extends ChannelControl>(c: C, now: number): C =>
  !c.open && c.off_until !== null && Date.parse(c.off_until) <= now
    ? { ...c, open: true, off_until: null }
    : c;

const StatusLine = ({
  status,
  envOpen,
}: {
  status: ChannelStatus;
  envOpen: boolean;
}) => {
  const { t } = useTranslation();
  if (!envOpen)
    return (
      <StatusBadge color="red">{t('withdrawalControls.envClosed')}</StatusBadge>
    );
  if (status.open)
    return (
      <StatusBadge color="green">{t('withdrawalControls.open')}</StatusBadge>
    );
  return (
    <StatusBadge color="orange">
      {status.reopens_at
        ? t('withdrawalControls.closedUntil', {
            time: mytWhen(status.reopens_at),
          })
        : t('withdrawalControls.closed')}
    </StatusBadge>
  );
};

/** One channel: its on/off switch, live status and daily closed window. */
const ChannelEditor = ({
  id,
  label,
  hint,
  value,
  onChange,
  status,
  envOpen,
  children,
}: {
  id: string;
  label: string;
  hint: string;
  value: ChannelControl;
  onChange: (next: ChannelControl) => void;
  status: ChannelStatus;
  envOpen: boolean;
  children?: ReactNode;
}) => {
  const { t } = useTranslation();
  const setSchedule = (patch: Partial<ChannelControl['schedule']>) =>
    onChange({ ...value, schedule: { ...value.schedule, ...patch } });
  return (
    <div className="flex flex-col gap-3 border-t px-6 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Label htmlFor={`${id}-open`} weight="plus">
            {label}
          </Label>
          <Text size="small" className="text-ui-fg-subtle">
            {hint}
          </Text>
        </div>
        <div className="flex items-center gap-3">
          <StatusLine status={status} envOpen={envOpen} />
          <Switch
            id={`${id}-open`}
            checked={value.open}
            onCheckedChange={(open) =>
              onChange({ ...value, open, off_until: null })
            }
          />
        </div>
      </div>
      {value.open ? null : (
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-off-until`} size="small">
            {t('withdrawalControls.reopenOn')}
          </Label>
          <Input
            id={`${id}-off-until`}
            type="datetime-local"
            size="small"
            className="w-56"
            value={value.off_until ? toMytInput(value.off_until) : ''}
            onChange={(e) =>
              onChange({
                ...value,
                off_until: e.target.value ? fromMytInput(e.target.value) : null,
              })
            }
          />
          <Text size="xsmall" className="text-ui-fg-subtle">
            {t('withdrawalControls.reopenOnHint')}
          </Text>
        </div>
      )}
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex h-8 items-center gap-2">
          <Switch
            id={`${id}-schedule`}
            checked={value.schedule.on}
            onCheckedChange={(on) => setSchedule({ on })}
          />
          <Label htmlFor={`${id}-schedule`} size="small">
            {t('withdrawalControls.schedule')}
          </Label>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-close`} size="small">
            {t('withdrawalControls.closeAt')}
          </Label>
          <Input
            id={`${id}-close`}
            type="time"
            size="small"
            className="w-32"
            value={value.schedule.close_at ?? ''}
            onChange={(e) => setSchedule({ close_at: e.target.value || null })}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-reopen`} size="small">
            {t('withdrawalControls.reopenAt')}
          </Label>
          <Input
            id={`${id}-reopen`}
            type="time"
            size="small"
            className="w-32"
            value={value.schedule.reopen_at ?? ''}
            onChange={(e) => setSchedule({ reopen_at: e.target.value || null })}
          />
        </div>
        {children}
      </div>
      {scheduleIncomplete(value) ? (
        <Text size="small" className="text-ui-fg-error">
          {t('withdrawalControls.scheduleIncomplete')}
        </Text>
      ) : null}
    </div>
  );
};

/**
 * The admin's withdrawal switches (2026-10-17), at the top of the
 * Withdrawals page. Edits are a draft until saved with a reason; the backend
 * validates and audits the whole set.
 */
export const WithdrawalControlsPanel = () => {
  const { t } = useTranslation();
  const prompt = usePrompt();
  const query = useWithdrawalControls();
  const save = useSaveWithdrawalControls();
  // Saving asks payment:update. A view-only role still reads what is open and
  // when: support is asked "why can't I withdraw?".
  const canEdit = usePermissions().hasPermission(
    'payment:update' as Permission,
  );
  const [draft, setDraft] = useState<WithdrawalControls | null>(null);
  const [reason, setReason] = useState('');

  if (query.isError)
    return (
      <Container className="px-6 py-4">
        <Text size="small" className="text-ui-fg-error">
          {t('withdrawalControls.loadError')}
        </Text>
      </Container>
    );
  if (!query.data) return null;

  const { status, env, tng_min_floor_rm: floor } = query.data;
  // The fetch time (refetched every minute), so the switches agree with the
  // status badges the same response carries.
  const now = query.dataUpdatedAt;
  const saved: WithdrawalControls = {
    withdrawals: settle(query.data.controls.withdrawals, now),
    tng: settle(query.data.controls.tng, now),
  };
  const value = draft ?? saved;
  const dirty =
    draft !== null && JSON.stringify(draft) !== JSON.stringify(saved);
  const minRm = value.tng.min_rm;
  const minInvalid = minRm !== null && !(minRm >= floor);
  const canSave =
    dirty &&
    reason.trim().length > 0 &&
    !save.isPending &&
    !minInvalid &&
    !scheduleIncomplete(value.withdrawals) &&
    !scheduleIncomplete(value.tng);

  const submit = async () => {
    if (!canSave) return;
    const confirmed = await prompt({
      title: t('withdrawalControls.title'),
      description: t('withdrawalControls.confirm'),
      confirmText: t('withdrawalControls.save'),
    });
    if (!confirmed) return;
    // Re-settled at the click: a reopen time that passed since the last
    // fetch would otherwise be refused as "must be in the future".
    const at = Date.now();
    save.mutate(
      {
        withdrawals: settle(value.withdrawals, at),
        tng: settle(value.tng, at),
        reason: reason.trim(),
      },
      {
        onSuccess: () => {
          setDraft(null);
          setReason('');
        },
      },
    );
  };

  return (
    <Container className="p-0">
      <div className="px-6 py-4">
        <Heading level="h2">{t('withdrawalControls.title')}</Heading>
        <Text className="text-ui-fg-subtle mt-1" size="small">
          {t('withdrawalControls.subtitle')}
        </Text>
      </div>
      <fieldset disabled={!canEdit} className="contents">
      <ChannelEditor
        id="wc-withdrawals"
        label={t('withdrawalControls.withdraw')}
        hint={t('withdrawalControls.withdrawHint')}
        value={value.withdrawals}
        onChange={(withdrawals) => setDraft({ ...value, withdrawals })}
        status={status.withdrawals}
        envOpen={env.withdrawals}
      />
      <ChannelEditor
        id="wc-tng"
        label={t('withdrawalControls.tng')}
        hint={t('withdrawalControls.tngHint')}
        value={value.tng}
        onChange={(tng) =>
          setDraft({ ...value, tng: { ...value.tng, ...tng } })
        }
        status={status.tng}
        envOpen={env.tng}
      >
        <div className="flex flex-col gap-1">
          <Label htmlFor="wc-tng-min" size="small">
            {t('withdrawalControls.tngMin')}
          </Label>
          <Input
            id="wc-tng-min"
            type="number"
            size="small"
            className="w-32"
            min={floor}
            step={1}
            placeholder={String(floor)}
            value={minRm ?? ''}
            aria-invalid={minInvalid}
            onChange={(e) =>
              setDraft({
                ...value,
                tng: {
                  ...value.tng,
                  min_rm: e.target.value === '' ? null : Number(e.target.value),
                },
              })
            }
          />
        </div>
      </ChannelEditor>
      </fieldset>
      <div className="flex flex-col gap-1 border-t px-6 py-4">
        <Text size="small" className="text-ui-fg-subtle">
          {t('withdrawalControls.footnote', { floor })}
        </Text>
        {dirty ? (
          <div className="mt-2 flex flex-wrap items-end gap-3">
            <div className="flex min-w-64 flex-1 flex-col gap-1">
              <Label htmlFor="wc-reason" size="small" weight="plus">
                {t('withdrawalControls.reason')}
              </Label>
              <Input
                id="wc-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={t('withdrawalControls.reasonPlaceholder')}
              />
            </div>
            <Button
              variant="secondary"
              onClick={() => {
                setDraft(null);
                setReason('');
              }}
              disabled={save.isPending}
            >
              {t('withdrawalControls.discard')}
            </Button>
            <Button
              onClick={submit}
              isLoading={save.isPending}
              disabled={!canSave}
            >
              {t('withdrawalControls.save')}
            </Button>
          </div>
        ) : null}
      </div>
    </Container>
  );
};
