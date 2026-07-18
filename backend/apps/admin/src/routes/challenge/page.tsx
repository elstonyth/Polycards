import { useState } from 'react';
import {
  Container,
  Heading,
  Text,
  Button,
  Input,
  Label,
  Select,
  Table,
  Tabs,
  FocusModal,
} from '@medusajs/ui';
import { Trophy } from '@medusajs/icons';
import type { RouteConfig } from '@mercurjs/dashboard-sdk';
import {
  useCards,
  useChallengeStages,
  useSaveChallengeStages,
  useChallengeSettings,
  useSaveChallengeSettings,
  type ChallengeStageDTO,
  type ChallengeSettingsDTO,
} from '../../lib/queries';
import { resolveImageUrl } from '../../lib/image-url';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';

let nextId = 0;

// ── Featured-card picker (adapts the daily-box picker; emits card.id) ─────────
const CardPicker = ({
  open,
  onClose,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (id: string) => void;
}) => {
  const { data: cards, isError } = useCards({ enabled: open });
  return (
    <FocusModal open={open} onOpenChange={(o) => !o && onClose()}>
      <FocusModal.Content>
        <FocusModal.Header>
          <Button size="small" variant="secondary" onClick={onClose}>
            Close
          </Button>
        </FocusModal.Header>
        <FocusModal.Body className="flex flex-col items-center overflow-auto p-10">
          <div className="flex w-full max-w-[640px] flex-col gap-y-4">
            <FocusModal.Title asChild>
              <Heading level="h2">Choose a featured card</Heading>
            </FocusModal.Title>
            {isError ? (
              <Text className="text-ui-fg-subtle">Failed to load cards.</Text>
            ) : cards == null ? (
              <LoadingSkeleton />
            ) : (
              <div className="divide-y rounded-lg border">
                {cards.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className="hover:bg-ui-bg-base-hover flex w-full items-center gap-3 px-4 py-2 text-left"
                    onClick={() => {
                      onPick(c.id);
                      onClose();
                    }}
                  >
                    <img
                      src={resolveImageUrl(c.image)}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      className="h-9 w-7 shrink-0 rounded object-contain"
                    />
                    <span className="flex-1 truncate text-sm font-medium">
                      {c.name}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </FocusModal.Body>
      </FocusModal.Content>
    </FocusModal>
  );
};

// ── Milestone Stages tab ─────────────────────────────────────────────────────
interface StageRow {
  localId: string;
  thresholdInput: string;
  creditsInput: string;
  cardIds: string[];
}
const stageFromDTO = (s: ChallengeStageDTO): StageRow => ({
  localId: `st-${nextId++}`,
  thresholdInput: String(s.threshold_myr),
  creditsInput: String(s.reward_credits),
  cardIds: s.reward_card_ids,
});
const snapshotStages = (rows: StageRow[]) =>
  JSON.stringify(rows.map((r) => [r.thresholdInput, r.creditsInput, r.cardIds]));

const StagesTab = () => {
  const { data, isError } = useChallengeStages();
  const save = useSaveChallengeStages();
  const [seededFrom, setSeededFrom] = useState<{ stages: ChallengeStageDTO[] } | undefined>();
  const [rows, setRows] = useState<StageRow[]>([]);
  const [savedSnapshot, setSavedSnapshot] = useState('');
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  // Seed once per mount only — `data` gets a new object identity on every
  // React Query refetch (e.g. refetchOnWindowFocus), so comparing
  // `data !== seededFrom` re-seeds — and silently wipes unsaved edits — on
  // every background refetch.
  if (data && seededFrom === undefined) {
    setSeededFrom(data);
    const initial = data.stages.map(stageFromDTO);
    setRows(initial);
    setSavedSnapshot(snapshotStages(initial));
  }
  if (isError) return <Text className="text-ui-fg-subtle p-6">Failed to load stages.</Text>;
  if (!data) return <LoadingSkeleton />;

  const dirty = snapshotStages(rows) !== savedSnapshot;
  // Client pre-check: contiguity is automatic (index-derived); check monotonic
  // thresholds + non-negatives inline. Empty list is valid (challenge off).
  const errors: string[] = [];
  let prev = -1;
  rows.forEach((r, i) => {
    const t = Number(r.thresholdInput);
    if (!Number.isFinite(t) || t < 0) errors.push(`Stage ${i + 1}: threshold must be ≥ 0.`);
    else {
      if (i > 0 && !(t > prev)) errors.push(`Stage ${i + 1}: threshold must exceed stage ${i}'s.`);
      prev = t;
    }
    if (!(Number(r.creditsInput) >= 0)) errors.push(`Stage ${i + 1}: credits must be ≥ 0.`);
  });
  const reasonValid = reason.trim().length > 0;
  const canSave = !save.isPending && dirty && errors.length === 0 && reasonValid;

  const setRow = (id: string, patch: Partial<StageRow>) =>
    setRows((p) => p.map((r) => (r.localId === id ? { ...r, ...patch } : r)));
  const insertAt = (index: number) =>
    setRows((p) => {
      const next = p.slice();
      next.splice(index, 0, { localId: `st-${nextId++}`, thresholdInput: '0', creditsInput: '0', cardIds: [] });
      return next;
    });
  const removeAt = (index: number) => setRows((p) => p.filter((_, i) => i !== index));

  async function onSave() {
    if (!canSave) return;
    const stages: ChallengeStageDTO[] = rows.map((r, i) => ({
      stage_number: i + 1,
      threshold_myr: Number(r.thresholdInput) || 0,
      reward_credits: Number(r.creditsInput) || 0,
      reward_card_ids: r.cardIds,
    }));
    try {
      const res = await save.mutateAsync({ stages, reason: reason.trim() });
      const reseeded = res.stages.map(stageFromDTO);
      setRows(reseeded);
      setSavedSnapshot(snapshotStages(reseeded));
      setReason('');
    } catch {
      /* onError toasts */
    }
  }

  return (
    <div className="flex flex-col gap-y-4 px-6 py-4">
      <Text className="text-ui-fg-subtle" size="small">
        Community-pool milestone stages (inert config). Stage number is the row
        order; thresholds must strictly increase. Zero stages = challenge off.
      </Text>
      {errors.length > 0 && (
        <div className="rounded-lg border border-ui-border-error p-3">
          {errors.map((e) => (
            <Text key={e} className="text-ui-fg-error" size="small">{e}</Text>
          ))}
        </div>
      )}
      <Table>
        <Table.Header>
          <Table.Row>
            <Table.HeaderCell>Stage</Table.HeaderCell>
            <Table.HeaderCell>Threshold (RM)</Table.HeaderCell>
            <Table.HeaderCell>Credits (RM)</Table.HeaderCell>
            <Table.HeaderCell>Featured cards</Table.HeaderCell>
            <Table.HeaderCell>Rows</Table.HeaderCell>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {rows.map((r, i) => (
            <Table.Row key={r.localId}>
              <Table.Cell>{i + 1}</Table.Cell>
              <Table.Cell>
                <Input value={r.thresholdInput} onChange={(e) => setRow(r.localId, { thresholdInput: e.target.value })} />
              </Table.Cell>
              <Table.Cell>
                <Input value={r.creditsInput} onChange={(e) => setRow(r.localId, { creditsInput: e.target.value })} />
              </Table.Cell>
              <Table.Cell>
                <div className="flex items-center gap-x-2">
                  <Text size="small">{r.cardIds.length} card(s)</Text>
                  <Button size="small" variant="secondary" onClick={() => setPickerFor(r.localId)}>Add</Button>
                  {r.cardIds.length > 0 && (
                    <Button size="small" variant="transparent" onClick={() => setRow(r.localId, { cardIds: r.cardIds.slice(0, -1) })}>
                      Remove last
                    </Button>
                  )}
                </div>
              </Table.Cell>
              <Table.Cell>
                <div className="flex gap-x-1">
                  <Button size="small" variant="secondary" onClick={() => insertAt(i)}>+ Above</Button>
                  <Button size="small" variant="secondary" onClick={() => insertAt(i + 1)}>+ Below</Button>
                  <Button size="small" variant="danger" onClick={() => removeAt(i)}>Delete</Button>
                </div>
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
      <div className="flex items-center gap-x-3">
        <Button variant="secondary" onClick={() => setRows((p) => [...p, { localId: `st-${nextId++}`, thresholdInput: '0', creditsInput: '0', cardIds: [] }])}>
          Add stage
        </Button>
        {dirty && <Text className="text-ui-fg-subtle" size="small">Unsaved changes</Text>}
      </div>
      <div className="flex items-end gap-x-3">
        <div className="flex-1">
          <Label htmlFor="stages-reason">Reason (audit trail)</Label>
          <Input
            id="stages-reason"
            placeholder="e.g. Add a new milestone stage"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
        <Button variant="primary" onClick={onSave} isLoading={save.isPending} disabled={!canSave}>Save stages</Button>
      </div>
      <CardPicker
        open={pickerFor !== null}
        onClose={() => setPickerFor(null)}
        onPick={(id) => {
          if (pickerFor) setRow(pickerFor, { cardIds: [...(rows.find((r) => r.localId === pickerFor)?.cardIds ?? []), id] });
        }}
      />
    </div>
  );
};

// ── Week & Payout tab ────────────────────────────────────────────────────────
const zones = (Intl as typeof Intl & { supportedValuesOf(k: string): string[] }).supportedValuesOf('timeZone');

const PayoutTab = () => {
  const { data, isError } = useChallengeSettings();
  const save = useSaveChallengeSettings();
  const [seededFrom, setSeededFrom] = useState<ChallengeSettingsDTO | undefined>();
  const [form, setForm] = useState<ChallengeSettingsDTO | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [reason, setReason] = useState('');

  // Seed once per mount only — see StagesTab above for why comparing
  // `data !== seededFrom` breaks on refetch.
  if (data && seededFrom === undefined) {
    setSeededFrom(data);
    setForm(data);
  }
  if (isError) return <Text className="text-ui-fg-subtle p-6">Failed to load settings.</Text>;
  if (!form) return <LoadingSkeleton />;

  const dirty = JSON.stringify(form) !== JSON.stringify(seededFrom);
  // Mirror the server's checks (challenge-validate.ts) so out-of-range values
  // show inline instead of round-tripping to a generic server-error toast.
  const errors: string[] = [];
  if (!Number.isInteger(form.reset_day) || form.reset_day < 0 || form.reset_day > 6)
    errors.push('Reset day must be an integer between 0 and 6.');
  if (!Number.isInteger(form.reset_hour) || form.reset_hour < 0 || form.reset_hour > 23)
    errors.push('Reset hour must be an integer between 0 and 23.');
  if (!(form.payout_credits >= 0))
    errors.push('Payout credits must be ≥ 0.');
  const reasonValid = reason.trim().length > 0;
  const canSave = !save.isPending && dirty && errors.length === 0 && reasonValid;
  const set = (patch: Partial<ChallengeSettingsDTO>) => setForm((f) => (f ? { ...f, ...patch } : f));

  async function onSave() {
    if (!form || !canSave || !seededFrom) return;
    // Send only the changed fields as the patch.
    const patch: Partial<ChallengeSettingsDTO> = {};
    (Object.keys(form) as (keyof ChallengeSettingsDTO)[]).forEach((k) => {
      if (JSON.stringify(form[k]) !== JSON.stringify(seededFrom[k])) {
        (patch as Record<string, unknown>)[k] = form[k];
      }
    });
    try {
      const res = await save.mutateAsync({ patch, reason: reason.trim() });
      setSeededFrom(res);
      setForm(res);
      setReason('');
    } catch {
      /* onError toasts */
    }
  }

  return (
    <div className="flex max-w-[520px] flex-col gap-y-4 px-6 py-4">
      <Text className="text-ui-fg-subtle" size="small">
        Fixed-weekly cadence anchored at a timezone + reset day/hour, plus the
        flat top-10 payout (inert config).
      </Text>
      {errors.length > 0 && (
        <div className="rounded-lg border border-ui-border-error p-3">
          {errors.map((e) => (
            <Text key={e} className="text-ui-fg-error" size="small">{e}</Text>
          ))}
        </div>
      )}
      <div>
        <Text size="small" weight="plus">Cadence</Text>
        <Text className="text-ui-fg-subtle" size="small">fixed_weekly (only supported value)</Text>
      </div>
      <div>
        <Text size="small" weight="plus">Timezone</Text>
        <Select value={form.timezone} onValueChange={(v) => set({ timezone: v })}>
          <Select.Trigger><Select.Value /></Select.Trigger>
          <Select.Content>
            {zones.map((z) => (<Select.Item key={z} value={z}>{z}</Select.Item>))}
          </Select.Content>
        </Select>
      </div>
      <div>
        <Text size="small" weight="plus">Reset day (0 = Sunday … 6 = Saturday)</Text>
        <Input type="number" min={0} max={6} value={String(form.reset_day)} onChange={(e) => set({ reset_day: Number(e.target.value) })} />
      </div>
      <div>
        <Text size="small" weight="plus">Reset hour (0–23)</Text>
        <Input type="number" min={0} max={23} value={String(form.reset_hour)} onChange={(e) => set({ reset_hour: Number(e.target.value) })} />
      </div>
      <div>
        <Text size="small" weight="plus">Top-10 payout credits (RM)</Text>
        <Input type="number" min={0} value={String(form.payout_credits)} onChange={(e) => set({ payout_credits: Number(e.target.value) })} />
      </div>
      <div>
        <Text size="small" weight="plus">Top-10 featured cards</Text>
        <div className="flex items-center gap-x-2">
          <Text size="small">{form.payout_card_ids.length} card(s)</Text>
          <Button size="small" variant="secondary" onClick={() => setPickerOpen(true)}>Add</Button>
          {form.payout_card_ids.length > 0 && (
            <Button size="small" variant="transparent" onClick={() => set({ payout_card_ids: form.payout_card_ids.slice(0, -1) })}>
              Remove last
            </Button>
          )}
        </div>
      </div>
      <div className="flex items-end gap-x-3">
        <div className="flex-1">
          <Label htmlFor="payout-reason">Reason (audit trail)</Label>
          <Input
            id="payout-reason"
            placeholder="e.g. Move reset to Sunday midnight"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
        <Button variant="primary" onClick={onSave} isLoading={save.isPending} disabled={!canSave}>Save week & payout</Button>
      </div>
      <CardPicker open={pickerOpen} onClose={() => setPickerOpen(false)} onPick={(id) => set({ payout_card_ids: [...form.payout_card_ids, id] })} />
    </div>
  );
};

const ChallengePage = () => {
  const [tab, setTab] = useState<'stages' | 'payout'>('stages');
  return (
    <Container className="p-0">
      <Tabs value={tab} onValueChange={(v) => setTab(v as 'stages' | 'payout')}>
        <div className="flex items-center justify-between px-6 py-4">
          <div>
            <Heading level="h2">Weekly Challenge</Heading>
            <Text className="text-ui-fg-subtle mt-1" size="small">
              Milestone stages and the weekly reset + top-10 payout. Inert config
              a future settlement engine will read.
            </Text>
          </div>
          <Tabs.List>
            <Tabs.Trigger value="stages">Milestone Stages</Tabs.Trigger>
            <Tabs.Trigger value="payout">Week & Payout</Tabs.Trigger>
          </Tabs.List>
        </div>
        <Tabs.Content value="stages"><StagesTab /></Tabs.Content>
        <Tabs.Content value="payout"><PayoutTab /></Tabs.Content>
      </Tabs>
    </Container>
  );
};

export default ChallengePage;

export const config: RouteConfig = {
  label: 'Weekly Challenge',
  icon: Trophy,
  rank: 33,
};
