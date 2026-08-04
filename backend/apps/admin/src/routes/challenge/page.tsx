import { useState } from 'react';
import {
  Container,
  Heading,
  Text,
  Button,
  Input,
  Label,
  Select,
  StatusBadge,
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
  useChallengeSchedules,
  useChallengeWinners,
  useCreateChallengeSchedule,
  useDeleteChallengeSchedule,
  useChallengeSettings,
  useSaveChallengeSettings,
  type ChallengeStageDTO,
  type ChallengeSettingsDTO,
} from '../../lib/queries';
import { resolveImageUrl } from '../../lib/image-url';
import { orderDateTime, rm } from '../../lib/format';
import {
  describeInShopZone,
  isWeeklyResetInstant,
  nextWeeklyReset,
  toLocalInput,
} from '../../lib/challenge-schedule';
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

// COUPLED MIRROR of modules/packs/challenge-validate.ts (MAX_VOUCHER_MYR /
// MAX_THRESHOLD_MYR). Kept as literals — separate builds, no shared package
// (same convention as lib/purchase-invoice-form.ts).
const MAX_CREDITS_MYR = 10_000;
const MAX_THRESHOLD_MYR = 100_000_000;

// ONE parser drives validation, the pays-anything filter and serialization so
// they can never disagree. Blank reads as 0; anything else non-finite,
// negative, or over the voucher ceiling is caught by `creditsValid` and
// blocks the save.
const parseCredits = (v: string): number => (v.trim() === '' ? 0 : Number(v));
const creditsValid = (v: string): boolean => {
  const n = parseCredits(v);
  return Number.isFinite(n) && n >= 0 && n <= MAX_CREDITS_MYR;
};
// A rank pays only if it carries a card and/or a positive credit amount.
const rankPays = (r: RankRow): boolean =>
  r.cardId !== null ||
  (creditsValid(r.creditsInput) && parseCredits(r.creditsInput) > 0);
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

// Client pre-check mirroring challenge-validate.ts: contiguity is automatic
// (index-derived) and rank uniqueness/range are structural here, so only
// thresholds and per-rank credits can actually be wrong. Empty list is valid
// (challenge off); an all-empty rank table is valid (stage pays nothing).
// The per-rank credits cap and the stage threshold cap (plan 044) mirror the
// server via MAX_CREDITS_MYR / MAX_THRESHOLD_MYR above.
//
// A free function, not inline in the tab: the Scheduled tab validates a queued
// edition with the SAME rules, and the backend rejects both through the same
// validateChallengeStages — two copies would drift.
const stageErrors = (rows: StageRow[]): string[] => {
  const errors: string[] = [];
  let prev = -1;
  rows.forEach((r, i) => {
    // Blank is NOT 0 (Number('') coerces to 0) and Infinity JSON-serializes to
    // null — both must fail here, not surprise the operator server-side.
    const t = r.thresholdInput.trim() === '' ? NaN : Number(r.thresholdInput);
    if (!Number.isFinite(t) || t < 0)
      errors.push(`Stage ${i + 1}: threshold must be ≥ 0.`);
    else {
      // A separate check (not folded into the line above) so an over-cap
      // threshold still updates `prev` — otherwise the NEXT stage's
      // contiguity check would compare against a stale value and cascade a
      // spurious "must exceed" error onto every row that follows.
      if (t > MAX_THRESHOLD_MYR)
        errors.push(
          `Stage ${i + 1}: threshold must be ≤ ${MAX_THRESHOLD_MYR.toLocaleString('en-US')}.`,
        );
      if (i > 0 && !(t > prev))
        errors.push(`Stage ${i + 1}: threshold must exceed stage ${i}'s.`);
      prev = t;
    }
    r.ranks.forEach((rk, ri) => {
      if (!creditsValid(rk.creditsInput))
        errors.push(
          `Stage ${i + 1}, rank ${ri + 1}: credits must be a number between 0 and ${MAX_CREDITS_MYR.toLocaleString('en-US')}.`,
        );
    });
  });
  return errors;
};

/** Dense editor rows → the SPARSE wire shape: drop every rank that pays
 *  nothing. Shared by the live save and the schedule POST. */
const toStageDTOs = (rows: StageRow[]): ChallengeStageDTO[] =>
  rows.map((r, i) => ({
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

// The milestone-ladder editor itself, with no opinion about WHERE the ladder is
// going — the live challenge (StagesTab) and a queued one (ScheduleTab) get the
// same table, the same rank picker and the same validation. Expansion state and
// the card picker are internal because they are pure view state; `rows` belongs
// to the caller, which owns dirty-tracking and saving.
const StageListEditor = ({
  rows,
  setRows,
  errors,
}: {
  rows: StageRow[];
  setRows: React.Dispatch<React.SetStateAction<StageRow[]>>;
  errors: string[];
}) => {
  const { data: cards } = useCards();
  const [pickerFor, setPickerFor] = useState<{
    stageId: string;
    rank: number;
  } | null>(null);
  // Which stages are expanded, and which rank rows that stage shows. Key absent
  // = collapsed (the rank table unmounts; edits live in `rows`, not the DOM).
  // The visible-rank list is frozen when the stage opens so a row never
  // disappears mid-edit (e.g. clearing a credits field to retype it).
  const [openRanks, setOpenRanks] = useState<Record<string, number[]>>({});

  const cardById = new Map((cards ?? []).map((c) => [c.id, c]));

  const setRow = (id: string, patch: Partial<StageRow>) =>
    setRows((p) => p.map((r) => (r.localId === id ? { ...r, ...patch } : r)));
  const setRank = (stageId: string, rank: number, patch: Partial<RankRow>) =>
    setRows((p) =>
      p.map((r) =>
        r.localId === stageId
          ? {
              ...r,
              ranks: r.ranks.map((rk, i) =>
                i === rank - 1 ? { ...rk, ...patch } : rk,
              ),
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
      const configured = ALL_RANKS.filter((n) =>
        rankConfigured(row.ranks[n - 1]),
      );
      // Nothing configured yet => nothing to hide, open the full table.
      return {
        ...p,
        [row.localId]: configured.length > 0 ? configured : ALL_RANKS,
      };
    });
  const showAllRanks = (localId: string) =>
    setOpenRanks((p) => ({ ...p, [localId]: ALL_RANKS }));
  const insertAt = (index: number) =>
    setRows((p) => {
      const next = p.slice();
      next.splice(index, 0, emptyStage());
      return next;
    });
  const removeAt = (index: number) =>
    setRows((p) => p.filter((_, i) => i !== index));

  return (
    <>
      <Text className="text-ui-fg-subtle" size="small">
        Thresholds must increase down the list. A rank can take a card, credits,
        both, or nothing. No stages means no challenge.
      </Text>
      {errors.length > 0 && (
        <div className="rounded-lg border border-ui-border-error p-3">
          {errors.map((e) => (
            <Text key={e} className="text-ui-fg-error" size="small">
              {e}
            </Text>
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
          (sum, rk) =>
            sum +
            (creditsValid(rk.creditsInput) ? parseCredits(rk.creditsInput) : 0),
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
                <Text size="small" weight="plus">
                  Stage {i + 1}
                </Text>
              </button>
              <div className="flex items-center gap-x-2">
                <Label
                  htmlFor={`threshold-${r.localId}`}
                  size="small"
                  className="text-ui-fg-subtle"
                >
                  Unlocks at RM
                </Label>
                <Input
                  id={`threshold-${r.localId}`}
                  className="w-28"
                  inputMode="numeric"
                  value={r.thresholdInput}
                  onChange={(e) =>
                    setRow(r.localId, { thresholdInput: e.target.value })
                  }
                />
              </div>
              <Text className="text-ui-fg-subtle" size="small">
                {paying === 0
                  ? 'Pays nothing'
                  : [
                      `${paying} of ${MAX_REWARD_RANK} ranks pay`,
                      cardCount > 0
                        ? `${cardCount} card${cardCount > 1 ? 's' : ''}`
                        : null,
                      creditTotal > 0 ? `${rm(creditTotal)} credits` : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
              </Text>
              <div className="pc-row-actions flex-1">
                <RowActions
                  subject={`stage ${i + 1}`}
                  actions={[
                    {
                      label: 'Insert stage above',
                      onSelect: () => insertAt(i),
                    },
                    {
                      label: 'Insert stage below',
                      onSelect: () => insertAt(i + 1),
                    },
                    {
                      label: 'Delete stage',
                      danger: true,
                      onSelect: () => removeAt(i),
                    },
                  ]}
                />
              </div>
            </div>
            {open && (
              <div
                id={panelId}
                className="flex max-w-[760px] flex-col gap-y-2 border-t p-3"
              >
                <Table>
                  <Table.Header>
                    <Table.Row>
                      <Table.HeaderCell className="w-16">Rank</Table.HeaderCell>
                      <Table.HeaderCell>Prize card</Table.HeaderCell>
                      <Table.HeaderCell className="w-40">
                        Credits (RM)
                      </Table.HeaderCell>
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {visible.map((rank) => {
                      const rk = r.ranks[rank - 1];
                      const card =
                        rk.cardId === null
                          ? undefined
                          : cardById.get(rk.cardId);
                      return (
                        <Table.Row key={rank}>
                          <Table.Cell>#{rank}</Table.Cell>
                          <Table.Cell>
                            <div className="flex items-center gap-x-2">
                              {rk.cardId === null ? (
                                <Text className="text-ui-fg-muted" size="small">
                                  No card
                                </Text>
                              ) : (
                                <>
                                  {card && (
                                    <img
                                      src={resolveImageUrl(
                                        card.slab_image ?? card.image,
                                      )}
                                      alt=""
                                      loading="lazy"
                                      decoding="async"
                                      className="h-9 w-7 shrink-0 rounded object-contain"
                                    />
                                  )}
                                  <Text size="small">
                                    {card ? card.name : rk.cardId}
                                  </Text>
                                </>
                              )}
                              <Button
                                size="small"
                                variant="secondary"
                                onClick={() =>
                                  setPickerFor({ stageId: r.localId, rank })
                                }
                              >
                                {rk.cardId === null ? 'Choose' : 'Change'}
                              </Button>
                              {rk.cardId !== null && (
                                <Button
                                  size="small"
                                  variant="transparent"
                                  onClick={() =>
                                    setRank(r.localId, rank, { cardId: null })
                                  }
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
                              onChange={(e) =>
                                setRank(r.localId, rank, {
                                  creditsInput: e.target.value,
                                })
                              }
                            />
                          </Table.Cell>
                        </Table.Row>
                      );
                    })}
                  </Table.Body>
                </Table>
                {visible.length < MAX_REWARD_RANK && (
                  <div>
                    <Button
                      size="small"
                      variant="secondary"
                      onClick={() => showAllRanks(r.localId)}
                    >
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
        <Button
          variant="secondary"
          onClick={() => setRows((p) => [...p, emptyStage()])}
        >
          Add stage
        </Button>
      </div>
      <CardPicker
        open={pickerFor !== null}
        onClose={() => setPickerFor(null)}
        onPick={(id) => {
          if (pickerFor)
            setRank(pickerFor.stageId, pickerFor.rank, { cardId: id });
        }}
      />
    </>
  );
};

// The LIVE challenge — what players are competing for right now.
const StagesTab = () => {
  const { data, isError } = useChallengeStages();
  const save = useSaveChallengeStages();
  const [seededFrom, setSeededFrom] = useState<
    { stages: ChallengeStageDTO[] } | undefined
  >();
  const [rows, setRows] = useState<StageRow[]>([]);
  const [savedSnapshot, setSavedSnapshot] = useState('');
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
  if (isError)
    return (
      <Text className="text-ui-fg-subtle p-6">Failed to load stages.</Text>
    );
  if (!data) return <LoadingSkeleton />;

  const dirty = snapshotStages(rows) !== savedSnapshot;
  const errors = stageErrors(rows);
  const reasonValid = reason.trim().length > 0;
  const canSave =
    !save.isPending && dirty && errors.length === 0 && reasonValid;

  async function onSave() {
    if (!canSave) return;
    try {
      const res = await save.mutateAsync({
        stages: toStageDTOs(rows),
        reason: reason.trim(),
      });
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
      <StageListEditor rows={rows} setRows={setRows} errors={errors} />
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
    </div>
  );
};

// ── Scheduled tab ────────────────────────────────────────────────────────────
// The QUEUE in front of the live challenge. Nothing here affects players until
// its start passes and the hourly settle job promotes it (see
// promoteDueChallengeSchedules) — promotion happens AFTER that week is settled,
// so the ending week always pays on the stages it actually ran.

const stageSummary = (stages: ChallengeStageDTO[]): string => {
  if (stages.length === 0) return 'No stages — challenge off for that week';
  const cards = stages.reduce(
    (n, s) => n + s.rank_rewards.filter((r) => r.card_id !== null).length,
    0,
  );
  const credits = stages.reduce(
    (n, s) => n + s.rank_rewards.reduce((m, r) => m + r.credits, 0),
    0,
  );
  return [
    `${stages.length} stage${stages.length > 1 ? 's' : ''}`,
    cards > 0 ? `${cards} card${cards > 1 ? 's' : ''}` : null,
    credits > 0 ? `${rm(credits)} credits` : null,
  ]
    .filter(Boolean)
    .join(' · ');
};

const AddChallengeModal = ({
  open,
  onClose,
  seedFrom,
  openedAt,
}: {
  open: boolean;
  onClose: () => void;
  /** The LIVE stages, copied in as a starting point — most weeks are a tweak of
   *  the last one, and an empty ladder means "no challenge", which is almost
   *  never what the operator wanted to schedule. */
  seedFrom: ChallengeStageDTO[];
  /** Clock reading from the click that opened this modal. Passed in rather than
   *  read here so render stays pure — see startValid below. */
  openedAt: number;
}) => {
  // The configured week boundary (Week & Reset tab) — the default start snaps
  // to it. "+7 days from now" would flip the milestone ladder mid-week, under
  // players already competing on those thresholds.
  const { data: settings } = useChallengeSettings();
  const create = useCreateChallengeSchedule();
  const [rows, setRows] = useState<StageRow[]>([]);
  const [startsAt, setStartsAt] = useState('');
  const [label, setLabel] = useState('');
  const [reason, setReason] = useState('');
  // Seed on OPEN, not on mount: the modal stays mounted between opens, so
  // seeding once would hand the operator their previous draft — including one
  // they already saved.
  const [seededOpen, setSeededOpen] = useState(false);
  // Waits for settings: seeding a wrong default and silently correcting it
  // later would be worse than an empty field for the half-second it takes.
  if (open && !seededOpen && settings) {
    setSeededOpen(true);
    setRows(seedFrom.map(stageFromDTO));
    setStartsAt(toLocalInput(nextWeeklyReset(settings)));
    setLabel('');
    setReason('');
  }
  if (!open && seededOpen) setSeededOpen(false);

  const errors = stageErrors(rows);
  const start = startsAt === '' ? null : new Date(startsAt);
  // Mirrors the route's guard: a past start would be promoted by the very next
  // tick, which is a surprising way to replace the live challenge.
  //
  // `openedAt` is stamped by the button that opened this modal — an event
  // handler, where reading the clock is allowed. Render must stay pure, and a
  // value that changes every render would make "is this in the future?" flip
  // under its own feet. A clock frozen at open is enough: the window is a
  // minute or two, and the route re-checks against the real time on submit.
  const startValid =
    start !== null &&
    !Number.isNaN(start.getTime()) &&
    start.getTime() > openedAt;
  const canSave =
    !create.isPending &&
    startValid &&
    errors.length === 0 &&
    reason.trim() !== '';

  async function onSave() {
    if (!canSave || start === null) return;
    try {
      await create.mutateAsync({
        starts_at: start.toISOString(),
        label: label.trim() || null,
        stages: toStageDTOs(rows),
        reason: reason.trim(),
      });
      onClose();
    } catch {
      /* onError toasts */
    }
  }

  return (
    <FocusModal open={open} onOpenChange={(o) => !o && onClose()}>
      <FocusModal.Content>
        <FocusModal.Header>
          <div className="flex items-center gap-x-2">
            <Button size="small" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button
              size="small"
              onClick={onSave}
              isLoading={create.isPending}
              disabled={!canSave}
            >
              Schedule challenge
            </Button>
          </div>
        </FocusModal.Header>
        <FocusModal.Body className="pc-admin flex flex-col items-center overflow-auto p-10">
          <div className="flex w-full max-w-[860px] flex-col gap-y-4">
            <FocusModal.Title asChild>
              <Heading level="h2">Add weekly challenge</Heading>
            </FocusModal.Title>
            <Text className="text-ui-fg-subtle" size="small">
              Queued, not live. It replaces the current milestone ladder on the
              first hourly tick after its start — once that week&apos;s payouts
              have settled.
            </Text>
            <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
              <div className="flex flex-col gap-y-1">
                <Label htmlFor="schedule-start" size="small">
                  Goes live
                </Label>
                <Input
                  id="schedule-start"
                  type="datetime-local"
                  className="w-60"
                  value={startsAt}
                  onChange={(e) => setStartsAt(e.target.value)}
                  aria-invalid={
                    startsAt !== '' && !startValid ? true : undefined
                  }
                />
                {/* The input is BROWSER wall-clock. Echoing the same instant in
                    the shop's zone is the only way an operator sitting in a
                    different one can see that their "Monday 00:00" is not the
                    shop's reset. */}
                {startValid && settings && (
                  <Text className="text-ui-fg-subtle" size="small">
                    {describeInShopZone(start, settings.timezone)}{' '}
                    {settings.timezone}
                  </Text>
                )}
                {/* Not an error — a mid-week start is legal and occasionally
                    deliberate. But it promotes under players who are already
                    competing on the current thresholds, and the settlement that
                    follows pays that finished week on the NEW table, so the
                    operator should be choosing it rather than inheriting it. */}
                {startValid &&
                  settings &&
                  !isWeeklyResetInstant(settings, start) && (
                    <Text className="text-ui-fg-subtle" size="small">
                      ⚠ Not a weekly reset — this replaces the ladder mid-week,
                      and the finished week settles on the new prizes.
                    </Text>
                  )}
              </div>
              <div className="flex min-w-64 flex-1 flex-col gap-y-1">
                <Label htmlFor="schedule-label" size="small">
                  Name (optional)
                </Label>
                <Input
                  id="schedule-label"
                  placeholder="e.g. Chinese New Year week"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                />
              </div>
            </div>
            {startsAt !== '' && !startValid && (
              <Text className="text-ui-fg-error" size="small">
                Pick a date and time in the future.
              </Text>
            )}
            <StageListEditor rows={rows} setRows={setRows} errors={errors} />
            <div className="flex flex-col gap-y-1">
              <Label htmlFor="schedule-reason" size="small">
                Reason (audit trail)
              </Label>
              <Input
                id="schedule-reason"
                placeholder="e.g. Bigger prizes for the holiday week"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </div>
          </div>
        </FocusModal.Body>
      </FocusModal.Content>
    </FocusModal>
  );
};

const ScheduleTab = () => {
  const { data, isError } = useChallengeSchedules();
  const { data: live } = useChallengeStages();
  // Already cached by the modal and the Week & Reset tab — this only needs the
  // timezone, to render the queue in the shop's clock rather than the browser's.
  const { data: settings } = useChallengeSettings();
  const remove = useDeleteChallengeSchedule();
  const [adding, setAdding] = useState(false);
  const [openedAt, setOpenedAt] = useState(0);

  const schedules = data?.schedules ?? [];

  return (
    <div className="pc-admin flex flex-col gap-y-4 px-6 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <Text className="text-ui-fg-subtle" size="small">
          Weekly challenges waiting to go live. Each one replaces the whole
          milestone ladder when its start passes; the current one keeps running
          until then.
        </Text>
        {/* The clock is read HERE, in the handler — render must stay pure, and
            the modal only needs "now" as of the moment it opened. */}
        <Button
          variant="secondary"
          onClick={() => {
            setOpenedAt(Date.now());
            setAdding(true);
          }}
        >
          Add weekly challenge
        </Button>
      </div>

      {isError ? (
        <Text className="text-ui-fg-subtle">Failed to load the schedule.</Text>
      ) : !data ? (
        <LoadingSkeleton />
      ) : schedules.length === 0 ? (
        <Text className="text-ui-fg-subtle">
          Nothing scheduled — the current milestone ladder runs every week until
          one is.
        </Text>
      ) : (
        <Table>
          <Table.Header>
            <Table.Row>
              <Table.HeaderCell>Goes live</Table.HeaderCell>
              <Table.HeaderCell>Name</Table.HeaderCell>
              <Table.HeaderCell>Prizes</Table.HeaderCell>
              <Table.HeaderCell>Status</Table.HeaderCell>
              <Table.HeaderCell />
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {schedules.map((s) => {
              // From the server, not the browser: "overdue" is a claim about
              // the promotion job, which runs on the server's clock. A skewed
              // laptop clock should not decide whether a row looks stuck.
              const due = s.due;
              // Due but unstamped. Usually a prize card deleted since queueing
              // — but it is ALSO what a failing weekly settlement looks like,
              // because promotion runs after settlement and never gets its
              // turn. Naming only the first cause would send the operator to
              // the wrong screen, so the copy names both and the job log is
              // where the answer actually is.
              const status = s.applied_at
                ? 'Live'
                : due
                  ? 'Overdue — check its prize cards, then the settle job log'
                  : 'Queued';
              return (
                <Table.Row key={s.id}>
                  {/* Shop timezone, not browser: orderDateTime renders local
                      wall-clock unlabelled, so an operator abroad would read
                      the queue in a different zone than the one the modal
                      warns them about. */}
                  <Table.Cell className="whitespace-nowrap tabular-nums">
                    {settings
                      ? describeInShopZone(
                          new Date(s.starts_at),
                          settings.timezone,
                        )
                      : orderDateTime(s.starts_at)}
                  </Table.Cell>
                  <Table.Cell>{s.label ?? '—'}</Table.Cell>
                  <Table.Cell className="text-ui-fg-subtle">
                    {stageSummary(s.stages)}
                  </Table.Cell>
                  <Table.Cell
                    className={
                      !s.applied_at && due ? 'text-ui-fg-error' : undefined
                    }
                  >
                    {status}
                  </Table.Cell>
                  <Table.Cell className="text-right">
                    {/* A promoted row is history, not a queue entry: deleting
                        it would un-apply nothing but would erase the record of
                        why the live ladder changed (the backend refuses too). */}
                    {!s.applied_at && (
                      <RowActions
                        subject={s.label ?? orderDateTime(s.starts_at)}
                        actions={[
                          {
                            label: 'Remove from schedule',
                            danger: true,
                            onSelect: () => remove.mutate(s.id),
                          },
                        ]}
                      />
                    )}
                  </Table.Cell>
                </Table.Row>
              );
            })}
          </Table.Body>
        </Table>
      )}

      <AddChallengeModal
        open={adding}
        onClose={() => setAdding(false)}
        seedFrom={live?.stages ?? []}
        openedAt={openedAt}
      />
    </div>
  );
};

// ── Winners tab ──────────────────────────────────────────────────────────────
// What the weekly settlement actually paid, and what it could not. Read-only:
// settlement owns these rows, and nothing here marks, resends or exports.
//
// The out-of-stock half is why this exists. A prize card the settlement could
// not grant is recorded `skipped_no_stock` and then mentioned once, in a job
// log, which nobody reads — so the spec's "manual fulfilment queue" had no
// queue. This is it.
const WinnersTab = () => {
  const [week, setWeek] = useState('');
  const { data, isError } = useChallengeWinners(week);
  const { data: settings } = useChallengeSettings();

  if (isError)
    return (
      <Text className="text-ui-fg-subtle p-6">Failed to load winners.</Text>
    );
  if (!data) return <LoadingSkeleton />;

  const weeks = data.weeks;
  const summary = weeks.find((w) => w.weekStart === data.week);
  const tz = settings?.timezone;
  const weekLabel = (iso: string) =>
    tz ? describeInShopZone(new Date(iso), tz) : orderDateTime(iso);

  return (
    <div className="pc-admin flex flex-col gap-y-4 px-6 py-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <Text className="text-ui-fg-subtle" size="small">
          Every settled week, paid by the hourly job. Ranks are the pulled-value
          leaderboard as it stood when the week closed.
        </Text>
        {weeks.length > 0 && (
          <div className="flex flex-col gap-y-1">
            <Label htmlFor="winners-week" size="small">
              Week
            </Label>
            {/* Value is data.week, not `week`: '' means "latest" and the server
                resolves which week that is, so echoing the raw state would
                leave the trigger blank on first paint. */}
            <Select value={data.week ?? ''} onValueChange={setWeek}>
              <Select.Trigger id="winners-week" className="w-72">
                <Select.Value />
              </Select.Trigger>
              <Select.Content>
                {weeks.map((w) => (
                  <Select.Item key={w.weekStart} value={w.weekStart}>
                    {weekLabel(w.weekStart)} — {w.winners} paid
                  </Select.Item>
                ))}
              </Select.Content>
            </Select>
          </div>
        )}
      </div>

      {summary && summary.skipped > 0 && (
        // The one line on this page that needs an operator: these cards were
        // won and never granted, so somebody has to ship them by hand.
        <div className="border-ui-border-error rounded-lg border p-3">
          <Text className="text-ui-fg-error" size="small">
            {summary.skipped} prize card
            {summary.skipped > 1 ? 's were' : ' was'} out of stock at settlement
            and never granted — fulfil by hand. Marked below.
          </Text>
        </div>
      )}

      {weeks.length === 0 || data.winners.length === 0 ? (
        <Text className="text-ui-fg-subtle">
          No week has settled yet. The hourly job writes these rows when a
          challenge week closes.
        </Text>
      ) : (
        <>
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.HeaderCell className="w-16">Rank</Table.HeaderCell>
                <Table.HeaderCell>Player</Table.HeaderCell>
                <Table.HeaderCell className="text-right">
                  Credits
                </Table.HeaderCell>
                <Table.HeaderCell>Cards</Table.HeaderCell>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {data.winners.map((w) => (
                <Table.Row key={w.customer_id}>
                  <Table.Cell className="tabular-nums">#{w.rank}</Table.Cell>
                  <Table.Cell className="text-ui-fg-subtle break-words">
                    {w.customer_email ?? w.customer_id}
                  </Table.Cell>
                  <Table.Cell className="text-right tabular-nums whitespace-nowrap">
                    {w.credits > 0 ? rm(w.credits) : '—'}
                  </Table.Cell>
                  <Table.Cell>
                    {w.cards.length === 0 ? (
                      <Text className="text-ui-fg-muted" size="small">
                        —
                      </Text>
                    ) : (
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                        {w.cards.map((c) => (
                          <div
                            key={c.card_id}
                            className="flex items-center gap-x-2"
                          >
                            {c.image && (
                              <img
                                src={resolveImageUrl(c.image)}
                                alt=""
                                loading="lazy"
                                decoding="async"
                                className="h-9 w-7 shrink-0 rounded object-contain"
                              />
                            )}
                            <Text size="small">{c.name ?? c.card_id}</Text>
                            {c.qty > 1 && (
                              <Text className="text-ui-fg-muted" size="small">
                                ×{c.qty}
                              </Text>
                            )}
                            {c.status === 'skipped_no_stock' && (
                              <StatusBadge color="red">
                                Out of stock
                              </StatusBadge>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
          {summary && (
            <Text className="text-ui-fg-subtle" size="small">
              Pool {rm(data.winners[0]?.pool_myr ?? 0)} · stages{' '}
              {data.winners[0]?.unlocked_stages.join(', ') || 'none'} unlocked ·{' '}
              {rm(summary.credits)} credits paid across {summary.winners}{' '}
              players
            </Text>
          )}
        </>
      )}
    </div>
  );
};

// ── Week & Reset tab ─────────────────────────────────────────────────────────
const zones = (
  Intl as typeof Intl & { supportedValuesOf(k: string): string[] }
).supportedValuesOf('timeZone');

const PayoutTab = () => {
  const { data, isError } = useChallengeSettings();
  const save = useSaveChallengeSettings();
  const [seededFrom, setSeededFrom] = useState<
    ChallengeSettingsDTO | undefined
  >();
  const [form, setForm] = useState<ChallengeSettingsDTO | null>(null);
  const [reason, setReason] = useState('');

  // Seed once per mount only — see StagesTab above for why comparing
  // `data !== seededFrom` breaks on refetch.
  if (data && seededFrom === undefined) {
    setSeededFrom(data);
    setForm(data);
  }
  if (isError)
    return (
      <Text className="text-ui-fg-subtle p-6">Failed to load settings.</Text>
    );
  if (!form) return <LoadingSkeleton />;

  const dirty = JSON.stringify(form) !== JSON.stringify(seededFrom);
  // Mirror the server's checks (challenge-validate.ts) so out-of-range values
  // show inline instead of round-tripping to a generic server-error toast.
  const errors: string[] = [];
  if (
    !Number.isInteger(form.reset_day) ||
    form.reset_day < 0 ||
    form.reset_day > 6
  )
    errors.push('Reset day must be an integer between 0 and 6.');
  if (
    !Number.isInteger(form.reset_hour) ||
    form.reset_hour < 0 ||
    form.reset_hour > 23
  )
    errors.push('Reset hour must be an integer between 0 and 23.');
  const reasonValid = reason.trim().length > 0;
  const canSave =
    !save.isPending && dirty && errors.length === 0 && reasonValid;
  const set = (patch: Partial<ChallengeSettingsDTO>) =>
    setForm((f) => (f ? { ...f, ...patch } : f));

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
        Fixed-weekly cadence anchored at a timezone + reset day/hour. The weekly
        prize pool is the CUMULATIVE unlocked stage rewards (Milestone Stages
        tab) — the old flat top-10 payout is retired.
      </Text>
      {errors.length > 0 && (
        <div className="rounded-lg border border-ui-border-error p-3">
          {errors.map((e) => (
            <Text key={e} className="text-ui-fg-error" size="small">
              {e}
            </Text>
          ))}
        </div>
      )}
      <div>
        <Text size="small" weight="plus">
          Cadence
        </Text>
        <Text className="text-ui-fg-subtle" size="small">
          fixed_weekly (only supported value)
        </Text>
      </div>
      <div>
        <Text size="small" weight="plus">
          Timezone
        </Text>
        <Select
          value={form.timezone}
          onValueChange={(v) => set({ timezone: v })}
        >
          <Select.Trigger>
            <Select.Value />
          </Select.Trigger>
          <Select.Content>
            {zones.map((z) => (
              <Select.Item key={z} value={z}>
                {z}
              </Select.Item>
            ))}
          </Select.Content>
        </Select>
      </div>
      <div>
        <Text size="small" weight="plus">
          Reset day (0 = Sunday … 6 = Saturday)
        </Text>
        <Input
          type="number"
          min={0}
          max={6}
          value={String(form.reset_day)}
          onChange={(e) => set({ reset_day: Number(e.target.value) })}
        />
      </div>
      <div>
        <Text size="small" weight="plus">
          Reset hour (0–23)
        </Text>
        <Input
          type="number"
          min={0}
          max={23}
          value={String(form.reset_hour)}
          onChange={(e) => set({ reset_hour: Number(e.target.value) })}
        />
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
        <Button
          variant="primary"
          onClick={onSave}
          isLoading={save.isPending}
          disabled={!canSave}
        >
          Save week & reset
        </Button>
      </div>
    </div>
  );
};

type ChallengeTab = 'stages' | 'schedule' | 'winners' | 'payout';

const ChallengePage = () => {
  const [tab, setTab] = useState<ChallengeTab>('stages');
  return (
    <Container className="p-0">
      <Tabs value={tab} onValueChange={(v) => setTab(v as ChallengeTab)}>
        <div className="flex flex-wrap items-start justify-between gap-3 px-6 py-4">
          <div>
            <Heading level="h2">Weekly Challenge</Heading>
            <Text className="text-ui-fg-subtle mt-1" size="small">
              Weekly prizes for the top {MAX_REWARD_RANK} players. Stages unlock
              as the community pool grows and their prizes stack. Payouts are
              still settled by hand.
            </Text>
          </div>
          {/* In the order the operator thinks about them: what is running now,
              what runs next, what already paid out, and when the week turns
              over. */}
          <Tabs.List>
            <Tabs.Trigger value="stages">This week</Tabs.Trigger>
            <Tabs.Trigger value="schedule">Scheduled</Tabs.Trigger>
            <Tabs.Trigger value="winners">Winners</Tabs.Trigger>
            <Tabs.Trigger value="payout">Week & Reset</Tabs.Trigger>
          </Tabs.List>
        </div>
        {/* forceMount: tab buffers are seeded once per mount; unmounting the
            inactive tab would wipe unsaved edits. Hide it with `hidden` instead.
            Pinned by tab-buffers.test.ts. */}
        <Tabs.Content
          value="stages"
          forceMount
          className={tab === 'stages' ? undefined : 'hidden'}
        >
          <StagesTab />
        </Tabs.Content>
        <Tabs.Content
          value="schedule"
          forceMount
          className={tab === 'schedule' ? undefined : 'hidden'}
        >
          <ScheduleTab />
        </Tabs.Content>
        {/* Winners is deliberately NOT forceMounted, unlike its siblings: it
            holds no edit buffer to protect, and mounting it always would fire
            its query on every visit to this page whether or not anyone opens
            the tab. Pinned as a negative in tab-buffers.test.ts so the next
            reader does not "fix the inconsistency". */}
        <Tabs.Content value="winners">
          <WinnersTab />
        </Tabs.Content>
        <Tabs.Content
          value="payout"
          forceMount
          className={tab === 'payout' ? undefined : 'hidden'}
        >
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
