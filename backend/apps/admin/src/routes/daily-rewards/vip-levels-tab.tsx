import { useState } from "react";
import {
  Badge,
  Button,
  Input,
  Label,
  Select,
  StatusBadge,
  Switch,
  Table,
  Text,
} from "@medusajs/ui";
import {
  useVipLevels,
  useSaveVipLevels,
  useDailyBoxes,
} from "../../lib/queries";
import type { VipLevelDTO } from "../../lib/queries";
import { LoadingSkeleton } from "../../components/LoadingSkeleton";
import { RowActions } from "../../components/RowActions";
import { StickySaveBar } from "../../components/StickySaveBar";
import {
  FRAME_LEVELS,
  validateVipLevelsClient,
  type VipLevelRow,
} from "./vip-levels-validate-client";
import {
  DECADE,
  decadesWithErrors,
  groupByDecade,
  ladderShape,
} from "./vip-ladder-shape";

// One editable ladder row. `level` is NOT stored — it's the array index + 1,
// renumbered on every structural change (insert/delete/append).
interface Row extends VipLevelRow {
  localId: string;
}

let nextId = 0;
const rowFromDTO = (l: VipLevelDTO): Row => ({
  localId: `vl-${nextId++}`,
  thresholdInput: String(l.spend_threshold),
  voucherInput: String(l.voucher_amount),
  boxTier: l.box_tier,
  frameUnlock: l.frame_unlock,
  referralInput: String(l.direct_referral_pct),
});
const blankRow = (boxTier: string): Row => ({
  localId: `vl-${nextId++}`,
  thresholdInput: "0",
  voucherInput: "0",
  boxTier,
  frameUnlock: false,
  referralInput: "1",
});

const snapshotOf = (rows: Row[]): string =>
  JSON.stringify(
    rows.map((r) => [
      r.thresholdInput,
      r.voucherInput,
      r.boxTier,
      r.frameUnlock,
      r.referralInput,
    ]),
  );

// Thresholds run to seven figures; grouped digits are the difference between
// scanning the ladder and counting zeroes. Falls back to the raw string so a
// half-typed value is never rewritten under the operator.
const money = (s: string): string => {
  const n = Number(s);
  return s.trim() !== "" && Number.isFinite(n) ? n.toLocaleString() : s;
};

// Consecutive rows mostly repeat; only the rows where something *changes* carry
// information. Marked with a leading accent rather than by dimming the repeats:
// these are editable fields and must stay full-contrast.
const changeMark = (changed: boolean): string =>
  changed
    ? "border-l-2 border-ui-tag-orange-icon pl-2"
    : "border-l-2 border-transparent pl-2";

const levelInMessage = (message: string): number | null => {
  const m = /Level (\d+)/.exec(message);
  return m ? Number(m[1]) : null;
};

export const VipLevelsTab = () => {
  const { data, isError } = useVipLevels();
  const { data: boxesData } = useDailyBoxes();
  const save = useSaveVipLevels();

  const [seededFrom, setSeededFrom] = useState<
    { levels: VipLevelDTO[] } | undefined
  >(undefined);
  const [rows, setRows] = useState<Row[]>([]);
  const [savedSnapshot, setSavedSnapshot] = useState("");
  const [reason, setReason] = useState("");
  // Which decade disclosures the operator has opened. Collapsed by default so
  // the shape of the ladder is readable before any single rung is.
  const [openDecades, setOpenDecades] = useState<ReadonlySet<number>>(
    new Set(),
  );

  // Seed the local buffer once per mount only. `data` gets a new object
  // identity on every React Query refetch (e.g. refetchOnWindowFocus), so
  // comparing `data !== seededFrom` re-seeds — and silently wipes unsaved
  // edits — on every background refetch.
  if (data && seededFrom === undefined) {
    setSeededFrom(data);
    const initial = data.levels.map(rowFromDTO);
    setRows(initial);
    setSavedSnapshot(snapshotOf(initial));
  }

  if (isError)
    return (
      <Text className="text-ui-fg-subtle p-6">
        Failed to load the VIP ladder.
      </Text>
    );
  if (!data) return <LoadingSkeleton />;

  const tiers = (boxesData?.boxes ?? []).map((b) => b.tier);
  const fallbackTier = tiers[0] ?? "a";
  const dirty = snapshotOf(rows) !== savedSnapshot;
  const errors = validateVipLevelsClient(rows);
  const reasonValid = reason.trim().length > 0;
  const canSave =
    !save.isPending && dirty && errors.length === 0 && reasonValid;
  const saveHint =
    errors.length > 0
      ? `${errors.length} validation issue${errors.length > 1 ? "s" : ""}`
      : dirty && !reasonValid
        ? "Add a reason to save"
        : undefined;

  const shape = ladderShape(rows);
  const groups = groupByDecade(rows);
  const errorDecades = decadesWithErrors(errors);
  // A collapsed decade must never hide a blocking error, so error decades are
  // forced open regardless of the operator's disclosure state.
  const isOpen = (key: number) => openDecades.has(key) || errorDecades.has(key);
  const setOpen = (key: number, open: boolean) =>
    setOpenDecades((prev) => {
      const next = new Set(prev);
      if (open) next.add(key);
      else next.delete(key);
      return next;
    });

  const setRow = (localId: string, patch: Partial<Row>) =>
    setRows((prev) =>
      prev.map((r) => (r.localId === localId ? { ...r, ...patch } : r)),
    );
  const insertAt = (index: number) =>
    setRows((prev) => {
      const next = prev.slice();
      next.splice(index, 0, blankRow(fallbackTier));
      return next;
    });
  const removeAt = (index: number) =>
    setRows((prev) => {
      const next = prev.filter((_, i) => i !== index);
      // Deleting row 1 promotes a rung whose threshold is positive into the
      // locked level-1 input — reset it to the required 0 so the ladder stays
      // saveable.
      if (index === 0 && next.length > 0)
        next[0] = { ...next[0], thresholdInput: "0" };
      return next;
    });
  const appendRow = () => {
    // Open the decade the new rung lands in, otherwise "Append level" looks
    // like it did nothing.
    setOpen(Math.floor(rows.length / DECADE), true);
    setRows((prev) => [...prev, blankRow(fallbackTier)]);
  };

  async function onSave() {
    if (!canSave) return;
    // Serialises the whole buffer, not the expanded decades — collapsing is
    // presentation only and must never truncate the whole-set replace.
    const levels: VipLevelDTO[] = rows.map((r, i) => ({
      level: i + 1,
      spend_threshold: Number(r.thresholdInput) || 0,
      voucher_amount: Number(r.voucherInput) || 0,
      box_tier: r.boxTier,
      frame_unlock: r.frameUnlock,
      direct_referral_pct: Number(r.referralInput) || 0,
    }));
    try {
      const res = await save.mutateAsync({ levels, reason: reason.trim() });
      const reseeded = res.levels.map(rowFromDTO);
      setRows(reseeded);
      setSavedSnapshot(snapshotOf(reseeded));
      setReason("");
    } catch {
      // useSaveVipLevels.onError toasts the backend message.
    }
  }

  return (
    <div className="pc-admin flex flex-col gap-y-4 px-6 py-4">
      <Text className="text-ui-fg-subtle" size="small">
        The per-user VIP ladder. Level is the row order; thresholds must start
        at 0 and strictly increase. A frame can only unlock on a decade level.
      </Text>

      {/* Overview — the shape of the ladder before any rung is opened. */}
      <div className="border-ui-border-base bg-ui-bg-subtle grid gap-x-6 gap-y-3 rounded-lg border p-3 md:grid-cols-3">
        <div>
          <Text size="small" className="text-ui-fg-subtle">
            Levels
          </Text>
          <Text weight="plus">{shape.count}</Text>
        </div>
        <div>
          <Text size="small" className="text-ui-fg-subtle">
            Top threshold
          </Text>
          <Text weight="plus">RM {money(shape.topThreshold)}</Text>
        </div>
        <div>
          <Text size="small" className="text-ui-fg-subtle">
            Frames unlocked
          </Text>
          <Text weight="plus">
            {shape.frameLevels.length} of {shape.frameSlots.length} decade slots
          </Text>
        </div>
        <div className="md:col-span-3">
          <Text size="small" className="text-ui-fg-subtle mb-1">
            Box tier runs
          </Text>
          <div className="flex flex-wrap gap-1">
            {shape.tierSegments.map((s) => (
              <Badge key={`${s.tier}-${s.from}`} size="2xsmall">
                {s.tier} · L{s.from}
                {s.to !== s.from ? `-${s.to}` : ""}
              </Badge>
            ))}
          </div>
        </div>
        <div className="md:col-span-3">
          <Text size="small" className="text-ui-fg-subtle mb-1">
            Frame slots (decade levels only)
          </Text>
          <div className="flex flex-wrap gap-1">
            {shape.frameSlots.map((l) => (
              <Badge
                key={l}
                size="2xsmall"
                color={shape.frameLevels.includes(l) ? "purple" : "grey"}
              >
                L{l} {shape.frameLevels.includes(l) ? "unlocks" : "none"}
              </Badge>
            ))}
          </div>
        </div>
      </div>

      {errors.length > 0 && (
        <div className="border-ui-border-error bg-ui-bg-base rounded-lg border p-3">
          {errors.map((e) => (
            <Text key={e} className="text-ui-fg-error" size="small">
              {e}
            </Text>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
        <Button
          variant="secondary"
          size="small"
          onClick={() => setOpenDecades(new Set(groups.map((g) => g.key)))}
        >
          Expand all
        </Button>
        <Button
          variant="secondary"
          size="small"
          onClick={() => setOpenDecades(new Set())}
        >
          Collapse all
        </Button>
        <Button variant="secondary" size="small" onClick={appendRow}>
          Append level
        </Button>
      </div>

      {groups.map((g) => {
        const issues = errors.filter((e) => {
          const level = levelInMessage(e);
          return (
            level !== null && level >= g.firstLevel && level <= g.lastLevel
          );
        }).length;
        return (
          <details
            key={g.key}
            open={isOpen(g.key)}
            onToggle={(e) => setOpen(g.key, e.currentTarget.open)}
            className="border-ui-border-base rounded-lg border"
          >
            <summary className="hover:bg-ui-bg-base-hover flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 rounded-lg px-3 py-2">
              <Text weight="plus">
                Levels {g.firstLevel}-{g.lastLevel}
              </Text>
              <Text size="small" className="text-ui-fg-subtle">
                RM {money(g.thresholdFrom)} → RM {money(g.thresholdTo)}
              </Text>
              <div className="flex flex-wrap gap-1">
                {g.tiers.map((t) => (
                  <Badge key={t} size="2xsmall">
                    tier {t}
                  </Badge>
                ))}
              </div>
              {g.frameLevels.length > 0 && (
                <Badge size="2xsmall" color="purple">
                  frame @ L{g.frameLevels.join(", L")}
                </Badge>
              )}
              {issues > 0 && (
                <StatusBadge color="red">
                  {issues} issue{issues > 1 ? "s" : ""}
                </StatusBadge>
              )}
            </summary>

            <Table>
              <Table.Header>
                <Table.Row>
                  <Table.HeaderCell>Level</Table.HeaderCell>
                  <Table.HeaderCell>Threshold (RM)</Table.HeaderCell>
                  <Table.HeaderCell>Voucher (RM)</Table.HeaderCell>
                  <Table.HeaderCell>Box tier</Table.HeaderCell>
                  <Table.HeaderCell>Frame</Table.HeaderCell>
                  <Table.HeaderCell>Referral %</Table.HeaderCell>
                  <Table.HeaderCell>Actions</Table.HeaderCell>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {g.rows.map((r, j) => {
                  const i = g.startIndex + j;
                  const level = i + 1;
                  const prev = i > 0 ? rows[i - 1] : undefined;
                  // FRAME_LEVELS is the authority, not level % 10: it caps at 100, so an
                  // appended level 110 must not advertise a slot the validator rejects.
                  const frameSlot = FRAME_LEVELS.includes(level);
                  return (
                    <Table.Row key={r.localId}>
                      <Table.Cell>
                        <div className="flex items-center gap-x-2">
                          <Text weight={frameSlot ? "plus" : "regular"}>
                            {level}
                          </Text>
                          {frameSlot && (
                            <Badge size="2xsmall" color="purple">
                              frame slot
                            </Badge>
                          )}
                        </div>
                      </Table.Cell>
                      <Table.Cell>
                        <Input
                          aria-label={`Level ${level} threshold`}
                          value={r.thresholdInput}
                          disabled={i === 0}
                          onChange={(e) =>
                            setRow(r.localId, {
                              thresholdInput: e.target.value,
                            })
                          }
                        />
                      </Table.Cell>
                      <Table.Cell>
                        <div
                          className={changeMark(
                            !!prev && prev.voucherInput !== r.voucherInput,
                          )}
                        >
                          <Input
                            aria-label={`Level ${level} voucher`}
                            value={r.voucherInput}
                            onChange={(e) =>
                              setRow(r.localId, {
                                voucherInput: e.target.value,
                              })
                            }
                          />
                        </div>
                      </Table.Cell>
                      <Table.Cell>
                        <div
                          className={changeMark(
                            !!prev && prev.boxTier !== r.boxTier,
                          )}
                        >
                          <Select
                            value={r.boxTier}
                            onValueChange={(v) =>
                              setRow(r.localId, { boxTier: v })
                            }
                          >
                            <Select.Trigger
                              aria-label={`Level ${level} box tier`}
                            >
                              <Select.Value />
                            </Select.Trigger>
                            <Select.Content>
                              {tiers.map((t) => (
                                <Select.Item key={t} value={t}>
                                  {t}
                                </Select.Item>
                              ))}
                            </Select.Content>
                          </Select>
                        </div>
                      </Table.Cell>
                      <Table.Cell>
                        {/* Off-decade frames are illegal, but legacy data may
                            already carry one - never trap it as unclearable. */}
                        <Switch
                          aria-label={`Level ${level} frame unlock`}
                          checked={r.frameUnlock}
                          disabled={!frameSlot && !r.frameUnlock}
                          onCheckedChange={(v) =>
                            setRow(r.localId, { frameUnlock: v })
                          }
                        />
                      </Table.Cell>
                      <Table.Cell>
                        <div
                          className={changeMark(
                            !!prev && prev.referralInput !== r.referralInput,
                          )}
                        >
                          <Input
                            aria-label={`Level ${level} referral percent`}
                            value={r.referralInput}
                            onChange={(e) =>
                              setRow(r.localId, {
                                referralInput: e.target.value,
                              })
                            }
                          />
                        </div>
                      </Table.Cell>
                      <Table.Cell>
                        <div className="pc-row-actions">
                          <RowActions
                            subject={`VIP level ${level}`}
                            actions={[
                              {
                                label: "Insert level above",
                                onSelect: () => insertAt(i),
                              },
                              {
                                label: "Insert level below",
                                onSelect: () => insertAt(i + 1),
                              },
                              {
                                label: "Delete level",
                                danger: true,
                                onSelect: () => removeAt(i),
                              },
                            ]}
                          />
                        </div>
                      </Table.Cell>
                    </Table.Row>
                  );
                })}
              </Table.Body>
            </Table>
          </details>
        );
      })}

      <StickySaveBar
        dirty={dirty}
        saving={save.isPending}
        canSave={errors.length === 0 && reasonValid}
        onSave={onSave}
        label="Save ladder"
        message={saveHint}
      >
        <div className="min-w-64 flex-1">
          <Label htmlFor="vip-levels-reason" size="small">
            Reason (audit trail)
          </Label>
          <Input
            id="vip-levels-reason"
            placeholder="e.g. Rebalance mid-tier thresholds"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
      </StickySaveBar>
    </div>
  );
};

export default VipLevelsTab;
