import { useRef, useState, type MutableRefObject } from 'react';
import {
  Container,
  Heading,
  Text,
  Button,
  Switch,
  Input,
  Label,
  Select,
  Table,
  FocusModal,
  toast,
} from '@medusajs/ui';
import { Calendar } from '@medusajs/icons';
import type { RouteConfig } from '@mercurjs/dashboard-sdk';
import { computeOdds } from '@acme/odds-math';
import {
  useCards,
  useDailyBoxes,
  useDailyBox,
  useSaveDailyBox,
  useVoucherLadder,
  useSaveVoucherRanges,
  type DailyBoxEditorDTO,
  type DailyBoxPrizeDTO,
  type VoucherLadderDTO,
  type VoucherRangeDTO,
} from '../../lib/queries';
import { getDailyBox } from '../../lib/admin-rest';
import { fmtPct, rm } from '../../lib/format';
import { resolveImageUrl } from '../../lib/image-url';
import { snapshotOf } from './box-snapshot';

const TIERS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'Z'] as const;

const KIND_LABEL: Record<DailyBoxPrizeDTO['kind'], string> = {
  credit: 'Credit',
  product: 'Product',
  voucher: 'Voucher',
  nothing: 'Nothing',
};

// Mirrors MAX_BOX_CREDIT_MYR in packages/api src/modules/packs/daily-box.ts — keep in sync.
const MAX_BOX_CREDIT_MYR = 10_000;

// One prize row in the editable buffer. `payload` fields are flattened here
// (rather than kept nested) so every cell binds to a single controlled input;
// save re-nests them into DailyBoxSaveBody.prizes.
interface EditRow {
  localId: string;
  kind: DailyBoxPrizeDTO['kind'];
  amountInput: string;
  productHandle: string | null;
  qtyInput: string;
  locked: boolean;
  pctInput: string;
}

let nextLocalId = 0;
const blankRow = (): EditRow => ({
  localId: `new-${nextLocalId++}`,
  kind: 'credit',
  amountInput: '5',
  productHandle: null,
  qtyInput: '1',
  locked: false,
  pctInput: '0',
});

const rowFromPrize = (p: DailyBoxPrizeDTO): EditRow => ({
  localId: p.id ?? `new-${nextLocalId++}`,
  kind: p.kind,
  amountInput: String((p.payload as { amount_myr?: number }).amount_myr ?? '5'),
  productHandle:
    (p.payload as { product_handle?: string }).product_handle ?? null,
  qtyInput: String((p.payload as { qty?: number }).qty ?? '1'),
  locked: p.locked,
  pctInput: String(p.pct),
});

const DailyRewardsPage = () => {
  const [tab, setTab] = useState<'boxes' | 'vouchers'>('boxes');
  const boxesDirty = useRef(false);
  const switchTab = (next: 'boxes' | 'vouchers') => {
    if (
      tab === 'boxes' &&
      next !== 'boxes' &&
      boxesDirty.current &&
      !window.confirm('Discard unsaved box changes?')
    )
      return;
    setTab(next);
  };
  return (
    <Container className="p-0">
      <div className="flex items-center justify-between px-6 py-4">
        <div>
          <Heading level="h2">Daily Rewards</Heading>
          <Text className="text-ui-fg-subtle mt-1" size="small">
            Configure the daily box each VIP tier opens and the one-time
            vouchers granted by level.
          </Text>
        </div>
        <div className="flex gap-2">
          <Button
            variant={tab === 'boxes' ? 'primary' : 'secondary'}
            onClick={() => switchTab('boxes')}
          >
            Boxes
          </Button>
          <Button
            variant={tab === 'vouchers' ? 'primary' : 'secondary'}
            onClick={() => switchTab('vouchers')}
          >
            Vouchers
          </Button>
        </div>
      </div>
      {tab === 'boxes' ? <BoxesTab dirtyRef={boxesDirty} /> : <VouchersTab />}
    </Container>
  );
};

// One range row in the editable buffer. String inputs so the field can hold
// transient/invalid text (e.g. empty) while typing — parsed to numbers only
// for validation/fold/save, same pattern as EditRow's amountInput.
interface RangeRow {
  localId: string;
  fromInput: string;
  toInput: string;
  amountInput: string;
}

let nextRangeLocalId = 0;
const rangeRowFromDTO = (r: VoucherRangeDTO): RangeRow => ({
  localId: `range-${nextRangeLocalId++}`,
  fromInput: String(r.from),
  toInput: String(r.to),
  amountInput: String(r.amount_myr),
});

const LEVELS = 100;

// Mirrors foldRanges in packages/api src/modules/packs/voucher-ranges.ts —
// duplicated here (not imported) so the admin app never depends on backend
// source. Returns either the folded per-level ladder or a list of human
// -readable problems (never both), so the caller can show every issue at
// once instead of stopping at the first one.
function foldRangesLocal(
  ranges: { from: number; to: number; amountInput: string }[],
): { levels: number[] } | { errors: string[] } {
  const errors: string[] = [];
  const out = new Array<number>(LEVELS).fill(-1);
  const overlapLevels = new Set<number>();

  for (const r of ranges) {
    if (
      !Number.isInteger(r.from) ||
      !Number.isInteger(r.to) ||
      r.from < 1 ||
      r.to > LEVELS ||
      r.from > r.to
    ) {
      errors.push(
        `Range ${r.from}–${r.to} is invalid: levels must be whole numbers within 1–${LEVELS}, with from ≤ to.`,
      );
      continue;
    }
    const amt = Number(r.amountInput);
    if (!(Number.isFinite(amt) && amt >= 0)) {
      errors.push(`Range ${r.from}–${r.to} needs an RM amount of 0 or more.`);
      continue;
    }
    for (let level = r.from; level <= r.to; level++) {
      if (out[level - 1] !== -1) overlapLevels.add(level);
      out[level - 1] = amt;
    }
  }

  if (overlapLevels.size > 0) {
    errors.push(
      `Ranges overlap at level${overlapLevels.size > 1 ? 's' : ''} ${summarizeLevels([...overlapLevels])}.`,
    );
  }

  const gaps: number[] = [];
  for (let i = 0; i < LEVELS; i++) if (out[i] === -1) gaps.push(i + 1);
  if (gaps.length > 0) {
    errors.push(
      `Level${gaps.length > 1 ? 's' : ''} ${summarizeLevels(gaps)} ${gaps.length > 1 ? 'are' : 'is'} not covered by any range.`,
    );
  }

  return errors.length > 0 ? { errors } : { levels: out };
}

// Collapses a sorted list of levels into "42" or "42–44, 90" style ranges for
// error text, so an admin sees exactly which levels are wrong instead of a
// raw array dump.
function summarizeLevels(levels: number[]): string {
  const sorted = [...levels].sort((a, b) => a - b);
  const parts: string[] = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i <= sorted.length; i++) {
    const cur = sorted[i];
    if (cur === prev + 1) {
      prev = cur;
      continue;
    }
    parts.push(start === prev ? `${start}` : `${start}–${prev}`);
    start = cur;
    prev = cur;
  }
  return parts.join(', ');
}

const VouchersTab = () => {
  const { data, isError } = useVoucherLadder();
  const saveRanges = useSaveVoucherRanges();
  const saving = saveRanges.isPending;

  const [seededFrom, setSeededFrom] = useState<VoucherLadderDTO | undefined>(
    undefined,
  );
  const [rows, setRows] = useState<RangeRow[]>([]);
  const [reason, setReason] = useState('');
  if (data && data !== seededFrom) {
    setSeededFrom(data);
    setRows(data.ranges.map(rangeRowFromDTO));
  }

  const setRow = (localId: string, patch: Partial<RangeRow>) =>
    setRows((prev) =>
      prev.map((r) => (r.localId === localId ? { ...r, ...patch } : r)),
    );
  const removeRow = (localId: string) =>
    setRows((prev) => prev.filter((r) => r.localId !== localId));
  const addRow = () =>
    setRows((prev) => {
      const lastTo = prev.reduce(
        (max, r) => Math.max(max, Number(r.toInput) || 0),
        0,
      );
      return [
        ...prev,
        {
          localId: `range-${nextRangeLocalId++}`,
          fromInput: String(Math.min(lastTo + 1, LEVELS)),
          toInput: String(LEVELS),
          amountInput: '0',
        },
      ];
    });

  const parsedRows = rows.map((r) => ({
    from: Number(r.fromInput),
    to: Number(r.toInput),
    amountInput: r.amountInput,
  }));
  const folded =
    rows.length === 0
      ? { errors: ['At least one range is required.'] }
      : foldRangesLocal(parsedRows);
  const foldErrors = 'errors' in folded ? folded.errors : [];
  const levels = 'levels' in folded ? folded.levels : null;

  const gapLevels: number[] = [];
  if (levels === null) {
    // Recompute coverage alone (ignoring overlap/bounds errors) so "Fill
    // gaps" stays available even while other range rows are mid-edit.
    const covered = new Array<boolean>(LEVELS).fill(false);
    for (const r of parsedRows) {
      if (
        Number.isInteger(r.from) &&
        Number.isInteger(r.to) &&
        r.from >= 1 &&
        r.to <= LEVELS &&
        r.from <= r.to
      ) {
        for (let level = r.from; level <= r.to; level++)
          covered[level - 1] = true;
      }
    }
    covered.forEach((c, i) => {
      if (!c) gapLevels.push(i + 1);
    });
  }

  const fillGaps = () => {
    if (gapLevels.length === 0) return;
    // Fill-gaps adds one range per contiguous run of uncovered levels, e.g.
    // gaps [7,8,9,42] -> two new ranges (7-9 and 42-42), not four singles.
    const newRows: RangeRow[] = [];
    let start = gapLevels[0];
    let prev = gapLevels[0];
    const flush = () => {
      newRows.push({
        localId: `range-${nextRangeLocalId++}`,
        fromInput: String(start),
        toInput: String(prev),
        amountInput: '0',
      });
    };
    for (let i = 1; i <= gapLevels.length; i++) {
      const cur = gapLevels[i];
      if (cur === prev + 1) {
        prev = cur;
        continue;
      }
      flush();
      start = cur;
      prev = cur;
    }
    setRows((prevRows) => [...prevRows, ...newRows]);
  };

  const reasonValid = reason.trim().length > 0;
  const canSave =
    !saving && seededFrom !== undefined && reasonValid && levels !== null;

  async function save() {
    if (!canSave || levels === null) return;
    if (levels.every((amt) => amt === 0)) {
      const ok = window.confirm(
        'All voucher amounts are zero — customers will stop receiving level-up vouchers. Save anyway?',
      );
      if (!ok) return;
    }
    try {
      await saveRanges.mutateAsync({
        ranges: rows.map((r) => ({
          from: Number(r.fromInput),
          to: Number(r.toInput),
          amount_myr: Number(r.amountInput) || 0,
        })),
        reason: reason.trim(),
      });
      setReason('');
      // useSaveVoucherRanges invalidates qk.voucherLadder → the buffer
      // reseeds from the refetch above.
    } catch {
      // useSaveVoucherRanges.onError already toasts the backend message.
    }
  }

  if (isError) {
    return (
      <Container className="p-6">
        <Text className="text-ui-fg-subtle">Failed to load vouchers.</Text>
      </Container>
    );
  }

  return (
    <div className="border-t">
      {/* Range table */}
      <Table>
        <Table.Header>
          <Table.Row>
            <Table.HeaderCell>From level</Table.HeaderCell>
            <Table.HeaderCell>To level</Table.HeaderCell>
            <Table.HeaderCell>RM amount</Table.HeaderCell>
            <Table.HeaderCell />
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {rows.map((r) => (
            <Table.Row key={r.localId}>
              <Table.Cell>
                <Input
                  type="number"
                  min={1}
                  max={100}
                  value={r.fromInput}
                  onChange={(e) =>
                    setRow(r.localId, { fromInput: e.target.value })
                  }
                  className="w-20 tabular-nums"
                />
              </Table.Cell>
              <Table.Cell>
                <Input
                  type="number"
                  min={1}
                  max={100}
                  value={r.toInput}
                  onChange={(e) =>
                    setRow(r.localId, { toInput: e.target.value })
                  }
                  className="w-20 tabular-nums"
                />
              </Table.Cell>
              <Table.Cell>
                <div className="flex items-center gap-1">
                  <Text size="small" className="text-ui-fg-subtle">
                    RM
                  </Text>
                  <Input
                    type="number"
                    min={0}
                    step={0.01}
                    value={r.amountInput}
                    onChange={(e) =>
                      setRow(r.localId, { amountInput: e.target.value })
                    }
                    className="w-28 tabular-nums"
                  />
                </div>
              </Table.Cell>
              <Table.Cell>
                <Button
                  size="small"
                  variant="transparent"
                  onClick={() => removeRow(r.localId)}
                >
                  Remove
                </Button>
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>

      <div className="flex flex-col gap-3 px-6 py-4">
        <div className="flex gap-2">
          <Button size="small" variant="secondary" onClick={addRow}>
            Add range
          </Button>
          {gapLevels.length > 0 && (
            <Button size="small" variant="secondary" onClick={fillGaps}>
              Fill gaps with RM 0
            </Button>
          )}
        </div>

        {foldErrors.length > 0 && (
          <div className="flex flex-col gap-1">
            {foldErrors.map((err) => (
              <Text key={err} size="small" className="text-ui-tag-red-text">
                {err}
              </Text>
            ))}
          </div>
        )}

        <div className="flex items-end gap-3">
          <div className="flex-1">
            <Label htmlFor="voucher-reason">Reason (audit trail)</Label>
            <Input
              id="voucher-reason"
              placeholder="e.g. Boost mid-tier voucher payouts"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          <Button
            variant="primary"
            onClick={save}
            isLoading={saving}
            disabled={!canSave}
          >
            Save
          </Button>
        </div>
      </div>

      {/* Read-only 100-level preview, folded client-side from the rows above. */}
      <div className="border-t px-6 py-4">
        <Text className="mb-3 font-medium">Preview: level → RM</Text>
        {levels === null ? (
          <Text size="small" className="text-ui-fg-subtle">
            Fix the errors above to see the full 100-level preview.
          </Text>
        ) : (
          <div className="grid grid-cols-5 gap-x-4 gap-y-1 sm:grid-cols-10">
            {levels.map((amt, i) => (
              <div
                key={i}
                className="flex items-center justify-between gap-2 text-sm"
              >
                <Text size="small" className="text-ui-fg-subtle">
                  {i + 1}
                </Text>
                <Text size="small" className="tabular-nums">
                  {rm(amt)}
                </Text>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

const BoxesTab = ({ dirtyRef }: { dirtyRef: MutableRefObject<boolean> }) => {
  const { data: boxesData } = useDailyBoxes();
  const boxes = boxesData?.boxes ?? [];
  const [tier, setTier] = useState<string>('a');

  const { data, isError } = useDailyBox(tier);
  const saveBox = useSaveDailyBox();
  const saving = saveBox.isPending;

  // Seed the editable buffer from the server snapshot during render — same
  // buffer-from-snapshot pattern as reward-pools/packs editors.
  const [seededFrom, setSeededFrom] = useState<DailyBoxEditorDTO | undefined>(
    undefined,
  );
  const [name, setName] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [drawsPerDay, setDrawsPerDay] = useState('1');
  const [rows, setRows] = useState<EditRow[]>([]);
  const [reason, setReason] = useState('');
  const [serverSnap, setServerSnap] = useState('');
  if (data && data !== seededFrom) {
    setSeededFrom(data);
    setName(data.box.name);
    setEnabled(data.box.enabled);
    setDrawsPerDay(String(data.box.draws_per_day));
    setRows(data.prizes.map(rowFromPrize));
    setServerSnap(
      snapshotOf({
        name: data.box.name,
        enabled: data.box.enabled,
        drawsPerDay: String(data.box.draws_per_day),
        rows: data.prizes.map(rowFromPrize),
      }),
    );
  }

  // True only when the buffer actually differs from the last server snapshot.
  const hasUnsavedEdits =
    seededFrom !== undefined &&
    snapshotOf({ name, enabled, drawsPerDay, rows }) !== serverSnap;
  dirtyRef.current = hasUnsavedEdits;

  const handleTierChange = (nextTier: string) => {
    if (nextTier === tier) return;
    if (
      hasUnsavedEdits &&
      !window.confirm(`Discard unsaved changes to tier ${tier.toUpperCase()}?`)
    )
      return;
    setTier(nextTier);
    setSeededFrom(undefined);
    setRows([]);
    setName('');
    setEnabled(false);
    setDrawsPerDay('1');
    setReason('');
  };

  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const { data: allCards, isError: isCardsError } = useCards();

  const setRow = (localId: string, patch: Partial<EditRow>) =>
    setRows((prev) =>
      prev.map((r) => (r.localId === localId ? { ...r, ...patch } : r)),
    );
  const setKind = (localId: string, kind: DailyBoxPrizeDTO['kind']) =>
    setRow(localId, { kind, productHandle: null });
  const removeRow = (localId: string) =>
    setRows((prev) => prev.filter((r) => r.localId !== localId));
  const addRow = () => setRows((prev) => [...prev, blankRow()]);

  // Live preview — the same rarity-weighted math the save workflow runs
  // (folded to `rarity: 'Common'` for every row, same as computeBoxWeights),
  // so the % column always matches what saving would persist.
  const oddsInputs = rows.map((r, i) => ({
    card_id: String(i),
    locked: r.locked,
    pct: Number(r.pctInput) || 0,
    rarity: 'Common',
  }));
  const odds = computeOdds(oddsInputs);
  const pctByIndex = new Map(odds.computed.map((c, i) => [i, c.pct]));

  // Locking captures the row's CURRENT live % so the operator pins what they
  // see rather than letting the even-split flatten it (same UX as the packs
  // odds editor's toggleLock).
  const toggleLock = (r: EditRow, index: number) =>
    setRow(r.localId, {
      locked: !r.locked,
      pctInput: !r.locked
        ? String(pctByIndex.get(index) ?? r.pctInput)
        : r.pctInput,
    });

  const drawsNum = Number(drawsPerDay);
  const drawsValid =
    Number.isInteger(drawsNum) && drawsNum >= 1 && drawsNum <= 10;
  const reasonValid = reason.trim().length > 0;
  const emptyEnabledGuard =
    enabled && rows.length === 0
      ? `Tier ${tier.toUpperCase()} customers would see an empty box.`
      : null;
  const rowErrors = rows.map((r) => {
    if (r.kind === 'product' && !r.productHandle) return 'Pick a product.';
    if (r.kind === 'credit' || r.kind === 'voucher') {
      const amt = Number(r.amountInput);
      if (!(amt > 0) || amt > MAX_BOX_CREDIT_MYR)
        return `RM amount must be between 0 and ${MAX_BOX_CREDIT_MYR}.`;
    }
    if (r.kind === 'product' && !(Number(r.qtyInput) >= 1))
      return 'Qty must be at least 1.';
    return null;
  });
  const firstRowError = rowErrors.find((e) => e !== null) ?? null;
  const validationError =
    odds.error ?? emptyEnabledGuard ?? firstRowError ?? null;
  const canSave =
    !saving &&
    seededFrom !== undefined &&
    drawsValid &&
    reasonValid &&
    validationError === null;

  const lockedCount = rows.filter((r) => r.locked).length;
  const totalPct = odds.computed.reduce((s, c) => s + c.pct, 0);
  const maxPayout = rows.reduce((max, r) => {
    if (r.kind !== 'credit' && r.kind !== 'voucher') return max;
    const amt = Number(r.amountInput) || 0;
    return Math.max(max, amt);
  }, 0);

  async function copyFromTier(sourceTier: string) {
    if (!sourceTier || sourceTier === tier) return;
    if (hasUnsavedEdits) {
      const ok = window.confirm(
        `Replace the current unsaved prizes for tier ${tier.toUpperCase()} with tier ${sourceTier.toUpperCase()}'s saved prizes?`,
      );
      if (!ok) return;
    }
    try {
      const source = await getDailyBox(sourceTier);
      setRows(source.prizes.map(rowFromPrize));
      toast.success(`Copied prizes from tier ${sourceTier.toUpperCase()}.`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  async function save() {
    if (!canSave) return;
    try {
      await saveBox.mutateAsync({
        tier,
        body: {
          name,
          enabled,
          draws_per_day: drawsNum,
          reason: reason.trim(),
          prizes: rows.map((r) => ({
            kind: r.kind,
            locked: r.locked,
            pct: Number(r.pctInput) || 0,
            ...(r.kind === 'credit' || r.kind === 'voucher'
              ? { amount_myr: Number(r.amountInput) || 0 }
              : {}),
            ...(r.kind === 'product'
              ? {
                  product_handle: r.productHandle ?? undefined,
                  qty: Number(r.qtyInput) || 1,
                }
              : {}),
          })),
        },
      });
      setReason('');
      // useSaveDailyBox invalidates qk.dailyBoxes + qk.dailyBox(tier) → the
      // buffer reseeds from the refetch above.
    } catch {
      // useSaveDailyBox.onError already toasts the backend message.
    }
  }

  if (isError) {
    return (
      <Container className="p-6">
        <Text className="text-ui-fg-subtle">Failed to load daily boxes.</Text>
      </Container>
    );
  }

  return (
    <div className="border-t">
      {/* Tier strip */}
      <div className="flex flex-wrap gap-2 border-b px-6 py-4">
        {TIERS.map((t) => {
          const summary = boxes.find((b) => b.tier === t);
          const dotColor = !summary?.enabled
            ? 'bg-ui-fg-disabled'
            : summary.prize_count > 0
              ? 'bg-ui-tag-green-icon'
              : 'bg-ui-tag-orange-icon';
          return (
            <button
              key={t}
              type="button"
              onClick={() => handleTierChange(t)}
              className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm ${
                tier === t
                  ? 'border-ui-border-interactive bg-ui-bg-base'
                  : 'border-ui-border-base hover:bg-ui-bg-base-hover'
              }`}
            >
              <span className={`h-2 w-2 shrink-0 rounded-full ${dotColor}`} />
              <span className="font-medium">{t.toUpperCase()}</span>
              {summary && (
                <span className="text-ui-fg-subtle">
                  · LV {summary.level_from}–{summary.level_to} ·{' '}
                  {summary.customer_count} customers
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Box config */}
      <div className="flex flex-wrap items-end gap-4 border-b px-6 py-4">
        <div className="flex flex-col gap-1">
          <Label htmlFor="box-name">Name</Label>
          <Input
            id="box-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-56"
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="box-draws">Draws per day</Label>
          <Input
            id="box-draws"
            type="number"
            min={1}
            max={10}
            value={drawsPerDay}
            onChange={(e) => setDrawsPerDay(e.target.value)}
            className="w-24 tabular-nums"
          />
        </div>
        <label className="flex items-center gap-2 pb-2 text-sm">
          <Switch checked={enabled} onCheckedChange={setEnabled} />
          <span className="text-ui-fg-subtle">Enabled</span>
        </label>
        <div className="flex flex-col gap-1">
          <Label htmlFor="copy-from-tier">Copy from tier…</Label>
          <Select value="" onValueChange={copyFromTier}>
            <Select.Trigger id="copy-from-tier" className="w-40">
              <Select.Value placeholder="Choose a tier" />
            </Select.Trigger>
            <Select.Content>
              {TIERS.filter((t) => t !== tier).map((t) => (
                <Select.Item key={t} value={t}>
                  Tier {t.toUpperCase()}
                </Select.Item>
              ))}
            </Select.Content>
          </Select>
        </div>
      </div>

      {/* Prize table */}
      <Table>
        <Table.Header>
          <Table.Row>
            <Table.HeaderCell>Kind</Table.HeaderCell>
            <Table.HeaderCell>Prize</Table.HeaderCell>
            <Table.HeaderCell className="text-center">Lock</Table.HeaderCell>
            <Table.HeaderCell>Pct</Table.HeaderCell>
            <Table.HeaderCell className="text-right">Odds</Table.HeaderCell>
            <Table.HeaderCell />
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {rows.map((r, i) => (
            <Table.Row key={r.localId}>
              <Table.Cell>
                <Select
                  value={r.kind}
                  onValueChange={(v) =>
                    setKind(r.localId, v as DailyBoxPrizeDTO['kind'])
                  }
                >
                  <Select.Trigger className="w-32">
                    <Select.Value />
                  </Select.Trigger>
                  <Select.Content>
                    {(['credit', 'product', 'voucher', 'nothing'] as const).map(
                      (k) => (
                        <Select.Item key={k} value={k}>
                          {KIND_LABEL[k]}
                        </Select.Item>
                      ),
                    )}
                  </Select.Content>
                </Select>
              </Table.Cell>
              <Table.Cell>
                {r.kind === 'credit' || r.kind === 'voucher' ? (
                  <div className="flex items-center gap-1">
                    <Text size="small" className="text-ui-fg-subtle">
                      RM
                    </Text>
                    <Input
                      type="number"
                      min={0}
                      step={0.01}
                      value={r.amountInput}
                      onChange={(e) =>
                        setRow(r.localId, { amountInput: e.target.value })
                      }
                      className="w-28 tabular-nums"
                    />
                  </div>
                ) : r.kind === 'product' ? (
                  <div className="flex items-center gap-2">
                    <Button
                      size="small"
                      variant="secondary"
                      onClick={() => setPickerFor(r.localId)}
                    >
                      {r.productHandle ? 'Change' : 'Choose product'}
                    </Button>
                    {r.productHandle &&
                      (() => {
                        const c = (allCards ?? []).find(
                          (c) => c.handle === r.productHandle,
                        );
                        return c ? (
                          <>
                            <img
                              src={resolveImageUrl(c.image)}
                              alt=""
                              className="h-9 w-7 shrink-0 rounded object-contain"
                            />
                            <span className="truncate text-sm">{c.name}</span>
                          </>
                        ) : (
                          <span className="text-ui-fg-subtle text-sm">
                            {r.productHandle}
                          </span>
                        );
                      })()}
                    <Label className="text-ui-fg-subtle text-xs">Qty</Label>
                    <Input
                      type="number"
                      min={1}
                      max={1}
                      value={r.qtyInput}
                      onChange={(e) =>
                        setRow(r.localId, { qtyInput: e.target.value })
                      }
                      className="w-16 tabular-nums"
                    />
                  </div>
                ) : (
                  <Text size="small" className="text-ui-fg-subtle">
                    Nothing — a losing draw.
                  </Text>
                )}
              </Table.Cell>
              <Table.Cell className="text-center">
                <Switch
                  checked={r.locked}
                  onCheckedChange={() => toggleLock(r, i)}
                />
              </Table.Cell>
              <Table.Cell>
                <Input
                  type="number"
                  min={0}
                  max={100}
                  step={0.01}
                  disabled={!r.locked}
                  value={r.locked ? r.pctInput : ''}
                  placeholder={r.locked ? '' : 'auto'}
                  onChange={(e) =>
                    setRow(r.localId, { pctInput: e.target.value })
                  }
                  className="w-24 tabular-nums"
                />
              </Table.Cell>
              <Table.Cell className="text-right tabular-nums">
                {fmtPct(pctByIndex.get(i) ?? 0)}
              </Table.Cell>
              <Table.Cell>
                <Button
                  size="small"
                  variant="transparent"
                  onClick={() => removeRow(r.localId)}
                >
                  Remove
                </Button>
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>

      <div className="flex flex-col gap-3 px-6 py-4">
        <Button
          size="small"
          variant="secondary"
          onClick={addRow}
          className="self-start"
        >
          Add prize
        </Button>

        <Text size="small" className="text-ui-fg-subtle">
          {rows.length} prizes · {fmtPct(totalPct)} · {lockedCount} locked · max
          payout {rm(maxPayout)}
        </Text>

        {validationError && (
          <Text size="small" className="text-ui-tag-red-text">
            {validationError}
          </Text>
        )}

        <div className="flex items-end gap-3">
          <div className="flex-1">
            <Label htmlFor="box-reason">Reason (audit trail)</Label>
            <Input
              id="box-reason"
              placeholder="e.g. Rebalance tier a odds"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          <Button
            variant="primary"
            onClick={save}
            isLoading={saving}
            disabled={!canSave}
          >
            Save
          </Button>
        </div>
      </div>

      {/* Product picker */}
      <FocusModal
        open={pickerFor !== null}
        onOpenChange={(open) => {
          if (!open) setPickerFor(null);
        }}
      >
        <FocusModal.Content>
          <FocusModal.Header>
            <Button
              size="small"
              variant="secondary"
              onClick={() => setPickerFor(null)}
            >
              Close
            </Button>
          </FocusModal.Header>
          <FocusModal.Body className="flex flex-col items-center overflow-auto p-10">
            <div className="flex w-full max-w-[640px] flex-col gap-y-4">
              <div>
                <FocusModal.Title asChild>
                  <Heading level="h2">Choose a product prize</Heading>
                </FocusModal.Title>
                <FocusModal.Description asChild>
                  <Text className="text-ui-fg-subtle mt-1" size="small">
                    Pick the card awarded when this entry is drawn.
                  </Text>
                </FocusModal.Description>
              </div>
              {isCardsError ? (
                <Text className="text-ui-fg-subtle">
                  Failed to load the product catalog.
                </Text>
              ) : allCards == null ? (
                <Text className="text-ui-fg-subtle">…</Text>
              ) : allCards.length === 0 ? (
                <Text className="text-ui-fg-subtle">No cards available.</Text>
              ) : (
                <div className="divide-y rounded-lg border">
                  {allCards.map((c) => (
                    <button
                      key={c.handle}
                      type="button"
                      className="hover:bg-ui-bg-base-hover flex w-full items-center gap-3 px-4 py-2 text-left"
                      onClick={() => {
                        if (pickerFor)
                          setRow(pickerFor, { productHandle: c.handle });
                        setPickerFor(null);
                      }}
                    >
                      <img
                        src={resolveImageUrl(c.image)}
                        alt=""
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
    </div>
  );
};

export default DailyRewardsPage;

export const config: RouteConfig = {
  label: 'Daily Rewards',
  icon: Calendar,
  nested: '/gacha',
  rank: 5,
};
