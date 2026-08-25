import { useRef, useState, type ChangeEvent } from 'react';
import {
  Container,
  Heading,
  Text,
  Button,
  Input,
  Label,
  Table,
  Tabs,
  toast,
} from '@medusajs/ui';
import { Star } from '@medusajs/icons';
import type { RouteConfig } from '@mercurjs/dashboard-sdk';
import {
  useRewardsSettings,
  useSaveRewardsSettings,
  useAvatarFrames,
  useSaveAvatarFrames,
  useUploadImage,
} from '../../lib/queries';
import { resolveImageUrl } from '../../lib/image-url';
import { validateImageFile } from '../../lib/image-validation';
import { VipLevelsTab } from './vip-levels-tab';

const DailyRewardsPage = () => {
  const [tab, setTab] = useState<'levels' | 'frames' | 'settings'>('levels');
  return (
    <Container className="p-0">
      <Tabs
        value={tab}
        onValueChange={(v) => setTab(v as 'levels' | 'frames' | 'settings')}
        activationMode="manual"
      >
        <div className="flex items-center justify-between px-6 py-4">
          <div>
            <Heading level="h2">VIP</Heading>
            <Text className="text-ui-fg-subtle mt-1" size="small">
              The VIP ladder, the avatar frames unlocked every 10 levels, and
              the rewards engine settings.
            </Text>
          </div>
          <Tabs.List>
            <Tabs.Trigger value="levels">Levels</Tabs.Trigger>
            <Tabs.Trigger value="frames">Frames</Tabs.Trigger>
            <Tabs.Trigger value="settings">Engine settings</Tabs.Trigger>
          </Tabs.List>
        </div>
        {/* forceMount: these tabs seed their edit buffer once per mount, so
            unmounting the inactive tab would silently wipe unsaved edits. Hide
            it with `hidden` instead. */}
        <Tabs.Content
          value="levels"
          forceMount
          className={tab === 'levels' ? undefined : 'hidden'}
        >
          <VipLevelsTab />
        </Tabs.Content>
        <Tabs.Content
          value="frames"
          forceMount
          className={tab === 'frames' ? undefined : 'hidden'}
        >
          <FramesTab />
        </Tabs.Content>
        <Tabs.Content
          value="settings"
          forceMount
          className={tab === 'settings' ? undefined : 'hidden'}
        >
          <SettingsTab />
        </Tabs.Content>
      </Tabs>
    </Container>
  );
};

const FRAME_LEVELS = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100] as const;

// Avatar-frame catalog editor: one row per milestone level. Uploads go through
// /admin/media kind 'avatar-frame' (square ≥256px; a flat-magenta AI render is
// keyed to transparency automatically); Save replaces the whole catalog with
// an audit reason, matching the other tabs' discipline.
const FramesTab = () => {
  const { data, isError } = useAvatarFrames();
  const save = useSaveAvatarFrames();
  const upload = useUploadImage();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploadingFor, setUploadingFor] = useState<number | null>(null);
  // undefined = untouched buffer; otherwise the full edited catalog.
  const [pending, setPending] = useState<Record<string, string> | undefined>(
    undefined,
  );
  const [reason, setReason] = useState('');

  const current: Record<string, string> = data?.frames ?? {};
  const effective = pending ?? current;
  const dirty =
    pending !== undefined && JSON.stringify(pending) !== JSON.stringify(current);
  const canSave = dirty && !save.isPending && reason.trim().length > 0;

  const pickFile = (level: number) => {
    setUploadingFor(level);
    fileRef.current?.click();
  };

  const handleFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const level = uploadingFor;
    if (fileRef.current) fileRef.current.value = '';
    if (!file || level === null) {
      setUploadingFor(null);
      return;
    }
    try {
      const problem = await validateImageFile(file, 'avatar-frame');
      if (problem) {
        toast.error(problem);
        return;
      }
      const url = await upload.mutateAsync({ file, kind: 'avatar-frame' });
      setPending((prev) => ({ ...(prev ?? current), [String(level)]: url }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setUploadingFor(null);
    }
  };

  const removeFrame = (level: number) => {
    setPending((prev) => {
      const next = { ...(prev ?? current) };
      delete next[String(level)];
      return next;
    });
  };

  const submit = () => {
    if (!canSave || pending === undefined) return;
    save.mutate(
      { frames: pending, reason: reason.trim() },
      {
        onSuccess: () => {
          setPending(undefined);
          setReason('');
        },
      },
    );
  };

  if (isError) {
    return (
      <div className="px-6 py-8">
        <Text className="text-ui-fg-subtle">Failed to load avatar frames.</Text>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-y-5 border-t px-6 py-6">
      <Text className="text-ui-fg-subtle" size="small">
        One frame per 10 VIP levels, overlaid on the customer&apos;s profile
        photo once equipped. Upload a square transparent WebP/PNG ≥ 256×256
        (a flat-magenta AI render is keyed automatically). Customers can equip
        a frame only after reaching its level.
      </Text>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => void handleFile(e)}
      />
      <Table>
        <Table.Header>
          <Table.Row>
            <Table.HeaderCell>Unlock level</Table.HeaderCell>
            <Table.HeaderCell>Frame</Table.HeaderCell>
            <Table.HeaderCell />
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {FRAME_LEVELS.map((level) => {
            const url = effective[String(level)];
            return (
              <Table.Row key={level}>
                <Table.Cell className="font-medium">LV {level}</Table.Cell>
                <Table.Cell>
                  {url ? (
                    <div className="flex items-center gap-3">
                      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-neutral-900 p-1">
                        <img
                          src={resolveImageUrl(url)}
                          alt={`LV ${level} frame`}
                          className="max-h-full max-w-full object-contain"
                        />
                      </div>
                      <Text size="small" className="text-ui-fg-subtle truncate">
                        {url}
                      </Text>
                    </div>
                  ) : (
                    <Text size="small" className="text-ui-fg-subtle">
                      No frame uploaded — LV {level} customers can&apos;t equip
                      one yet.
                    </Text>
                  )}
                </Table.Cell>
                <Table.Cell>
                  <div className="flex justify-end gap-2">
                    <Button
                      size="small"
                      variant="secondary"
                      onClick={() => pickFile(level)}
                      isLoading={upload.isPending && uploadingFor === level}
                      disabled={upload.isPending}
                    >
                      {url ? 'Replace…' : 'Upload…'}
                    </Button>
                    {url && (
                      <Button
                        size="small"
                        variant="transparent"
                        onClick={() => removeFrame(level)}
                      >
                        Remove
                      </Button>
                    )}
                  </div>
                </Table.Cell>
              </Table.Row>
            );
          })}
        </Table.Body>
      </Table>
      <div className="flex items-end gap-4">
        <div className="flex min-w-64 flex-1 flex-col gap-y-1">
          <Label htmlFor="frames-reason" size="small" weight="plus">
            Reason
          </Label>
          <Input
            id="frames-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Required — audit note for this change"
          />
        </div>
        <Button onClick={submit} isLoading={save.isPending} disabled={!canSave}>
          Save frames
        </Button>
      </div>
    </div>
  );
};

const SettingsTab = () => {
  const { data, isError } = useRewardsSettings();
  const save = useSaveRewardsSettings();
  const [withdrawals, setWithdrawals] = useState('');
  const [reason, setReason] = useState('');
  const [seeded, setSeeded] = useState(false);
  if (data && !seeded) {
    setSeeded(true);
    setWithdrawals(String(data.withdrawals_per_day));
  }

  const wdN = Number(withdrawals);
  const errors: string[] = [];
  if (!Number.isInteger(wdN) || wdN < 1)
    errors.push('Withdrawals/day must be an integer ≥ 1.');
  const canSave =
    !save.isPending &&
    seeded &&
    errors.length === 0 &&
    reason.trim().length > 0;

  const submit = () => {
    if (!canSave) return;
    save.mutate({
      withdrawals_per_day: wdN,
      reason: reason.trim(),
    });
    setReason('');
  };

  if (isError)
    return (
      <div className="px-6 py-8">
        <Text className="text-ui-fg-subtle">Failed to load settings.</Text>
      </div>
    );

  const field = (
    id: string,
    label: string,
    value: string,
    set: (v: string) => void,
    hint: string,
  ) => (
    <div className="flex flex-col gap-y-1">
      <Label htmlFor={id} size="small" weight="plus">
        {label}
      </Label>
      <Input
        id={id}
        type="number"
        className="w-40"
        value={value}
        onChange={(e) => set(e.target.value)}
      />
      <Text size="small" className="text-ui-fg-subtle">
        {hint}
      </Text>
    </div>
  );

  return (
    <div className="flex flex-col gap-y-5 border-t px-6 py-6">
      <Text className="text-ui-fg-subtle" size="small">
        Reward knobs. Changes are clamped and audited server-side.
      </Text>
      <div className="flex flex-wrap gap-6">
        {field(
          'settings-withdrawals',
          'Withdrawals per day',
          withdrawals,
          setWithdrawals,
          'Per-customer daily withdrawal limit.',
        )}
      </div>
      {errors.length > 0 && (
        <div className="flex flex-col gap-1">
          {errors.map((err) => (
            <Text key={err} size="small" className="text-ui-fg-error">
              {err}
            </Text>
          ))}
        </div>
      )}
      <div className="flex items-end gap-4">
        <div className="flex min-w-64 flex-1 flex-col gap-y-1">
          <Label htmlFor="settings-reason" size="small" weight="plus">
            Reason
          </Label>
          <Input
            id="settings-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Required — audit note for this change"
          />
        </div>
        <Button onClick={submit} isLoading={save.isPending} disabled={!canSave}>
          Save settings
        </Button>
      </div>
    </div>
  );
};

export default DailyRewardsPage;

export const config: RouteConfig = {
  label: 'VIP',
  icon: Star,
  rank: 32,
};
