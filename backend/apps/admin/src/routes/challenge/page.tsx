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
import { Trophy, TriangleDownMini, TriangleRightMini } from '@medusajs/icons';
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
import { RowActions } from '../../components/RowActions';
import { StickySaveBar } from '../../components/StickySaveBar';

let nextId = 0;

// Mirrors MAX_REWARD_RANK in backend/packages/api/src/modules/packs/challenge-validate.ts.
const MAX_REWARD_RANK = 10;

// ── Prize-card picker (adapts the daily-box picker; emits card.id) ────────────
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
              <Heading level="h2">Choose a prize card</Heading>
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
// A stage holds a DENSE ranks 1..MAX_REWARD_RANK array locally (so every rank
// is always editable) but the API shape is SPARSE: a rank that pays nothing is
// simply absent from `rank_rewards`.
interface RankRow {
  cardId: string | null;
  creditsInput: string;
}
interface StageRow {
  localId: string;
  thresholdInput: string;
  ranks: RankRow[];
}

// ONE parser drives validation, the pays-anything filter and serialization so
// they can never disagree. Blank reads as 0; anything else non-finite or
// negative is caught by `creditsValid` and blocks the save.
const parseCredits = (v: string): number => (v.trim() === '' ? 0 : Number(v));
const creditsValid = (v: string): boolean => {
  const n = parseCredits(v);
  return Number.isFinite(n) && n >= 0;
};
// A rank pays only if it carries a card and/or a positive credit amount.
const rankPays = (r: RankRow): boolean =>
  r.cardId !== null || (creditsValid(r.creditsInput) && parseCredits(r.creditsInput) > 0);
// Broader than rankPays: what the editor shows when a stage is expanded. A rank
// the operator has touched at all (card, "0", even a typo) stays visible so it
// can be fixed; only never-configured ranks are hidden behind "Show all".
const rankConfigured = (r: RankRow): boolean =>
  r.cardId !== null || r.creditsInput.trim() !== '';
const ALL_RANKS = Array.from({ length: MAX_REWARD_RANK }, (_, i) => i + 1);

const emptyRanks = (): RankRow[] =>
  Array.from({ length: MAX_REWARD_RANK }, () => ({
    cardId: null,
    creditsInput: '',
  }));

const emptyStage = (): StageRow => ({
  localId: `st-${nextId++}`,
  thresholdInput: '0',
  ranks: emptyRanks(),
});

const stageFromDTO = (s: ChallengeStageDTO): StageRow => {
  const ranks = emptyRanks();
  for (const rr of s.rank_rewards ?? []) {
    if (!Number.isInteger(rr.rank) || rr.rank < 1 || rr.rank > MAX_REWARD_RANK)
      continue;
    ranks[rr.rank - 1] = {
      cardId: rr.card_id ?? null,
      creditsInput: rr.credits ? String(rr.credits) : '',
    };
  }
  return {
    localId: `st-${nextId++}`,
    thresholdInput: String(s.threshold_myr),
    ranks,
  };
};

const snapshotStages = (rows: StageRow[]) =>
  JSON.stringify(rows.map((r) => [r.thresholdInput, r.ranks]));

const StagesTab = () => {
  const { data, isError } = useChallengeStages();
  const { data: cards } = useCards();
  const save = useSaveChallengeStages();
  const [seededFrom, setSeededFrom] = useState<{ stages: ChallengeStageDTO[] } | undefined>();
  const [rows, setRows] = useState<StageRow[]>([]);
  const [savedSnapshot, setSavedSnapshot] = useState('');
  const [pickerFor, setPickerFor] = useState<{ stageId: string; rank: number } | null>(null);
  const [reason, setReason] = useState('');
  // Which stages are expanded, and which rank rows that stage shows. Key absent
  // = collapsed (the rank table unmounts; edits live in `rows`, not the DOM).
  // The visible-rank list is frozen when the stage opens so a row never
  // disappears mid-edit (e.g. clearing a credits field to retype it).
  const [openRanks, setOpenRanks] = useState<Record<string, number[]>>({});

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

  const cardById = new Map((cards ?? []).map((c) => [c.id, c]));
  const dirty = snapshotStages(rows) !== savedSnapshot;
  // Client pre-check mirroring challenge-validate.ts: contiguity is automatic
  // (index-derived) and rank uniqueness/range are structural here, so only
  // thresholds and per-rank credits can actually be wrong. Empty list is valid
  // (challenge off); an all-empty rank table is valid (stage pays nothing).
  // A per-rank reward cap (plan 044) would slot in beside the credits check.
  const errors: string[] = [];
  let prev = -1;
  rows.forEach((r, i) => {
    // Blank is NOT 0 (Number('') coerces to 0) and Infinity JSON-serializes to
    // null — both must fail here, not surprise the operator server-side.
    const t = r.thresholdInput.trim() === '' ? NaN : Number(r.thresholdInput);
    if (!Number.isFinite(t) || t < 0) errors.push(`Stage ${i + 1}: threshold must be ≥ 0.`);
    else {
      if (i > 0 && !(t > prev)) errors.push(`Stage ${i + 1}: threshold must exceed stage ${i}'s.`);
      prev = t;
    }
    r.ranks.forEach((rk, ri) => {
      if (!creditsValid(rk.creditsInput))
        errors.push(`Stage ${i + 1}, rank ${ri + 1}: credits must be a number ≥ 0.`);
    });
  });
  const reasonValid = reason.trim().length > 0;
  const canSave = !save.isPending && dirty && errors.length === 0 && reasonValid;

  const setRow = (id: string, patch: Partial<StageRow>) =>
    setRows((p) => p.map((r) => (r.localId === id ? { ...r, ...patch } : r)));
  const setRank = (stageId: string, rank: number, patch: Partial<RankRow>) =>
    setRows((p) =>
      p.map((r) =>
        r.localId === stageId
          ? {
              ...r,
              ranks: r.ranks.map((rk, i) => (i === rank - 1 ? { ...rk, ...patch } : rk)),
            }
          : r,
      ),
    );
  const toggleStage = (row: StageRow) =>
    setOpenRanks((p) => {
      if (p[row.localId]) {
        const next = { ...p };
        delete next[row.localId];
        return next;
      }
      const configured = ALL_RANKS.filter((n) => rankConfigured(row.ranks[n - 1]));
      // Nothing configured yet => nothing to hide, open the full table.
      return { ...p, [row.localId]: configured.length > 0 ? configured : ALL_RANKS };
    });
  const showAllRanks = (localId: string) =>
    setOpenRanks((p) => ({ ...p, [localId]: ALL_RANKS }));
  const insertAt = (index: number) =>
    setRows((p) => {
      const next = p.slice();
      next.splice(index, 0, emptyStage());
      return next;
    });
  const removeAt = (index: number) => setRows((p) => p.filter((_, i) => i !== index));

  async function onSave() {
    if (!canSave) return;
    // Dense → sparse: drop every rank that pays nothing.
    const stages: ChallengeStageDTO[] = rows.map((r, i) => ({
      stage_number: i + 1,
      threshold_myr: Number(r.thresholdInput) || 0,
      rank_rewards: r.ranks.flatMap((rk, ri) =>
        rankPays(rk)
          ? [
              {
                rank: ri + 1,
                card_id: rk.cardId,
                credits: parseCredits(rk.creditsInput),
              },
            ]
          : [],
      ),
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
    <div className="pc-admin flex flex-col gap-y-4 px-6 py-4">
      <Text className="text-ui-fg-subtle" size="small">
        Thresholds must increase down the list. A rank can take a card,
        credits, both, or nothing. No stages means no challenge.
      </Text>
      {errors.length > 0 && (
        <div className="rounded-lg border border-ui-border-error p-3">
          {errors.map((e) => (
            <Text key={e} className="text-ui-fg-error" size="small">{e}</Text>
          ))}
        </div>
      )}
      {rows.map((r, i) => {
        const visible = openRanks[r.localId];
        const open = visible !== undefined;
        const panelId = `stage-panel-${r.localId}`;
        const paying = r.ranks.filter(rankPays).length;
        const cardCount = r.ranks.filter((rk) => rk.cardId !== null).length;
        // Guard the sum: an in-progress invalid entry must not render "RM NaN".
        const creditTotal = r.ranks.reduce(
          (sum, rk) => sum + (creditsValid(rk.creditsInput) ? parseCredits(rk.creditsInput) : 0),
          0,
        );
        return (
        <div key={r.localId} className="flex flex-col rounded-lg border">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 p-3">
            <button
              type="button"
              data-pc-stage-toggle
              aria-expanded={open}
              aria-controls={panelId}
              onClick={() => toggleStage(r)}
              className="hover:bg-ui-bg-base-hover flex items-center gap-x-1 rounded-md px-1 py-1 text-left"
            >
              {open ? <TriangleDownMini /> : <TriangleRightMini />}
              <Text size="small" weight="plus">Stage {i + 1}</Text>
            </button>
            <div className="flex items-center gap-x-2">
              <Label htmlFor={`threshold-${r.localId}`} size="small" className="text-ui-fg-subtle">
                Unlocks at RM
              </Label>
              <Input
                id={`threshold-${r.localId}`}
                className="w-28"
                inputMode="numeric"
                value={r.thresholdInput}
                onChange={(e) => setRow(r.localId, { thresholdInput: e.target.value })}
              />
            </div>
            <Text className="text-ui-fg-subtle" size="small">
              {paying === 0
                ? 'Pays nothing'
                : [
                    `${paying} of ${MAX_REWARD_RANK} ranks pay`,
                    cardCount > 0 ? `${cardCount} card${cardCount > 1 ? 's' : ''}` : null,
                    creditTotal > 0 ? `RM ${creditTotal} credits` : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
            </Text>
            <div className="pc-row-actions flex-1">
              <RowActions
                subject={`stage ${i + 1}`}
                actions={[
                  { label: 'Insert stage above', onSelect: () => insertAt(i) },
                  { label: 'Insert stage below', onSelect: () => insertAt(i + 1) },
                  { label: 'Delete stage', danger: true, onSelect: () => removeAt(i) },
                ]}
              />
            </div>
          </div>
          {open && (
          <div id={panelId} className="flex max-w-[760px] flex-col gap-y-2 border-t p-3">
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.HeaderCell className="w-16">Rank</Table.HeaderCell>
                <Table.HeaderCell>Prize card</Table.HeaderCell>
                <Table.HeaderCell className="w-40">Credits (RM)</Table.HeaderCell>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {visible.map((rank) => {
                const rk = r.ranks[rank - 1];
                const card = rk.cardId === null ? undefined : cardById.get(rk.cardId);
                return (
                  <Table.Row key={rank}>
                    <Table.Cell>#{rank}</Table.Cell>
                    <Table.Cell>
                      <div className="flex items-center gap-x-2">
                        {rk.cardId === null ? (
                          <Text className="text-ui-fg-muted" size="small">No card</Text>
                        ) : (
                          <>
                            {card && (
                              <img
                                src={resolveImageUrl(card.slab_image ?? card.image)}
                                alt=""
                                loading="lazy"
                                decoding="async"
                                className="h-9 w-7 shrink-0 rounded object-contain"
                              />
                            )}
                            <Text size="small">{card ? card.name : rk.cardId}</Text>
                          </>
                        )}
                        <Button
                          size="small"
                          variant="secondary"
                          onClick={() => setPickerFor({ stageId: r.localId, rank })}
                        >
                          {rk.cardId === null ? 'Choose' : 'Change'}
                        </Button>
                        {rk.cardId !== null && (
                          <Button
                            size="small"
                            variant="transparent"
                            onClick={() => setRank(r.localId, rank, { cardId: null })}
                          >
                            Clear
                          </Button>
                        )}
                      </div>
                    </Table.Cell>
                    <Table.Cell>
                      <Input
                        aria-label={`Stage ${i + 1} rank ${rank} credits`}
                        className="w-28"
                        inputMode="numeric"
                        placeholder="0"
                        value={rk.creditsInput}
                        onChange={(e) => setRank(r.localId, rank, { creditsInput: e.target.value })}
                      />
                    </Table.Cell>
                  </Table.Row>
                );
              })}
            </Table.Body>
          </Table>
          {visible.length < MAX_REWARD_RANK && (
            <div>
              <Button size="small" variant="secondary" onClick={() => showAllRanks(r.localId)}>
                Show all {MAX_REWARD_RANK} ranks
              </Button>
            </div>
          )}
          </div>
          )}
        </div>
        );
      })}
      <div className="flex items-center gap-x-3">
        <Button variant="secondary" onClick={() => setRows((p) => [...p, emptyStage()])}>
          Add stage
        </Button>
      </div>
      <StickySaveBar
        dirty={dirty}
        saving={save.isPending}
        canSave={errors.length === 0 && reasonValid}
        onSave={onSave}
        label="Save stages"
        message={
          errors.length > 0
            ? `${errors.length} validation issue${errors.length > 1 ? 's' : ''}`
            : dirty && !reasonValid
              ? 'Add a reason to save'
              : undefined
        }
      >
        <div className="min-w-64 flex-1">
          <Label htmlFor="stages-reason" size="small">
            Reason (audit trail)
          </Label>
          <Input
            id="stages-reason"
            placeholder="e.g. Add a new milestone stage"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
      </StickySaveBar>
      <CardPicker
        open={pickerFor !== null}
        onClose={() => setPickerFor(null)}
        onPick={(id) => {
          if (pickerFor) setRank(pickerFor.stageId, pickerFor.rank, { cardId: id });
        }}
      />
    </div>
  );
};

// ── Week & Reset tab ─────────────────────────────────────────────────────────
const zones = (Intl as typeof Intl & { supportedValuesOf(k: string): string[] }).supportedValuesOf('timeZone');

const PayoutTab = () => {
  const { data, isError } = useChallengeSettings();
  const save = useSaveChallengeSettings();
  const [seededFrom, setSeededFrom] = useState<ChallengeSettingsDTO | undefined>();
  const [form, setForm] = useState<ChallengeSettingsDTO | null>(null);
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
    <div className="pc-admin flex max-w-[520px] flex-col gap-y-4 px-6 py-4">
      <Text className="text-ui-fg-subtle" size="small">
        Fixed-weekly cadence anchored at a timezone + reset day/hour. The
        weekly prize pool is the CUMULATIVE unlocked stage rewards (Milestone
        Stages tab) — the old flat top-10 payout is retired.
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
        <Button variant="primary" onClick={onSave} isLoading={save.isPending} disabled={!canSave}>Save week & reset</Button>
      </div>
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
              Weekly prizes for the top {MAX_REWARD_RANK} players. Stages
              unlock as the community pool grows and their prizes stack.
              Payouts are still settled by hand.
            </Text>
          </div>
          <Tabs.List>
            <Tabs.Trigger value="stages">Milestone Stages</Tabs.Trigger>
            <Tabs.Trigger value="payout">Week & Reset</Tabs.Trigger>
          </Tabs.List>
        </div>
        {/* forceMount: tab buffers are seeded once per mount; unmounting the
            inactive tab would wipe unsaved edits. Hide it with `hidden` instead. */}
        <Tabs.Content value="stages" forceMount className={tab === 'stages' ? undefined : 'hidden'}>
          <StagesTab />
        </Tabs.Content>
        <Tabs.Content value="payout" forceMount className={tab === 'payout' ? undefined : 'hidden'}>
          <PayoutTab />
        </Tabs.Content>
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
