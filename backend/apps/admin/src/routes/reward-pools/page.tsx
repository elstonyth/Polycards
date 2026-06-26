import { useState } from 'react';
import {
  Container,
  Heading,
  Text,
  Table,
  Button,
  Switch,
  Input,
  Select,
  StatusBadge,
  FocusModal,
  toast,
} from '@medusajs/ui';
import { Gift } from '@medusajs/icons';
import type { RouteConfig } from '@mercurjs/dashboard-sdk';
import { useCards, useRewardPool, useSaveRewardPool } from '../../lib/queries';
import type { RewardPoolResponse } from '../../lib/admin-rest';
import {
  mapPoolToRows,
  blankRow,
  rowsToBody,
  rowProbabilities,
  rowError,
  type RewardEditRow,
  type RewardKind,
} from '../../lib/reward-pool-rows';
import { fmtPct } from '../../lib/format';
import { resolveImageUrl } from '../../lib/image-url';

export const config: RouteConfig = {
  label: 'Reward Pools',
  icon: Gift,
};

// VIP box tiers (vip_level.box_tier): nine lowercase a–j + uppercase Z (level 100).
// ponytail: hardcoded ['a'..'j','Z'] (note uppercase Z); derive from
// vip_level.box_tier if the ladder grows or box_tier moves to a shared package.
const TIERS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'Z'] as const;

const RewardPoolsPage = () => {
  const [tier, setTier] = useState<string>('a');
  const { data, isError } = useRewardPool(tier);
  const savePool = useSaveRewardPool();
  const saving = savePool.isPending;

  // Seed the editable buffer from the server snapshot during render (not an
  // effect) — same pattern as the pack odds editor. Reseeds on tier switch and
  // after a post-save invalidation; never clobbers in-progress edits.
  const [seededFrom, setSeededFrom] = useState<RewardPoolResponse | undefined>(
    undefined,
  );
  const [rows, setRows] = useState<RewardEditRow[]>([]);
  const [drawsPerDay, setDrawsPerDay] = useState<string>('0');
  const [poolEnabled, setPoolEnabled] = useState<boolean>(false);
  if (data && data !== seededFrom) {
    setSeededFrom(data);
    setRows(mapPoolToRows(data.entries));
    setDrawsPerDay(String(data.pool?.draws_per_day ?? 0));
    setPoolEnabled(data.pool?.pool_enabled ?? false);
  }

  // Switching tiers must reset the buffer immediately. The reseed above only runs
  // once the NEW tier's data arrives, so without this the previous tier's rows
  // stay editable during the fetch — and a Save in that window would POST the old
  // tier's entries to the new tier's pool. Clearing rows also disables Save until
  // fresh data reseeds the buffer.
  const handleTierChange = (nextTier: string) => {
    setTier(nextTier);
    setSeededFrom(undefined);
    setRows([]);
    setDrawsPerDay('0');
    setPoolEnabled(false);
  };

  // Product picker. allCards is loaded for BOTH the read-only product display
  // join AND the picker, so it fetches on load (not lazily). isCardsError lets the
  // UI tell a failed catalog fetch apart from an in-flight one.
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const { data: allCards, isError: isCardsError } = useCards();
  const cardByHandle = new Map((allCards ?? []).map((c) => [c.handle, c]));

  const probs = rowProbabilities(rows);
  const dpd = Number(drawsPerDay);
  const dpdValid = Number.isInteger(dpd) && dpd >= 0;
  const errors = rows.map(rowError);
  const empty = rows.length === 0;
  const canSave =
    !saving && !empty && !errors.some((e) => e !== null) && dpdValid;

  const setRow = (localId: string, patch: Partial<RewardEditRow>) =>
    setRows((prev) =>
      prev.map((r) => (r.localId === localId ? { ...r, ...patch } : r)),
    );
  const setKind = (localId: string, kind: RewardKind) =>
    setRow(localId, { kind, product_handle: null, credit_amount: '' });
  const removeRow = (localId: string) =>
    setRows((prev) => prev.filter((r) => r.localId !== localId));
  const addRow = () => setRows((prev) => [...prev, blankRow()]);

  async function save() {
    if (!canSave) return;
    try {
      await savePool.mutateAsync({
        tier,
        body: rowsToBody(rows, dpd, poolEnabled),
      });
      toast.success('Reward pool saved.');
      // The hook invalidates qk.rewardPool(tier) → refetch → buffer reseeds.
    } catch {
      // useSaveRewardPool.onError already toasts the backend message.
    }
  }

  if (isError) {
    return (
      <Container className="p-6">
        <Text className="text-ui-fg-subtle">
          Failed to load the reward pool.
        </Text>
      </Container>
    );
  }

  return (
    <Container className="divide-y p-0">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 px-6 py-4">
        <div>
          <Heading level="h2">Reward Pools</Heading>
          <Text className="text-ui-fg-subtle mt-1 max-w-2xl" size="small">
            Configure the daily reward box for each VIP tier: the prize entries,
            their odds, the daily draw count, and whether the pool is live.
          </Text>
        </div>
        <div className="flex items-center gap-2">
          {data?.pool ? (
            <StatusBadge
              color={data.pool.status === 'active' ? 'green' : 'grey'}
            >
              {data.pool.status}
            </StatusBadge>
          ) : (
            <StatusBadge color="grey">Not authored</StatusBadge>
          )}
          <Select value={tier} onValueChange={handleTierChange}>
            <Select.Trigger className="w-32">
              <Select.Value />
            </Select.Trigger>
            <Select.Content>
              {TIERS.map((t) => (
                <Select.Item key={t} value={t}>
                  Tier {t.toUpperCase()}
                </Select.Item>
              ))}
            </Select.Content>
          </Select>
        </div>
      </div>

      {/* Pool controls */}
      <div className="flex flex-col gap-3 px-6 py-4">
        <div className="flex items-center gap-6">
          <label className="flex items-center gap-2 text-sm">
            <span className="text-ui-fg-subtle">Draws per day</span>
            <Input
              type="number"
              min={0}
              value={drawsPerDay}
              onChange={(e) => setDrawsPerDay(e.target.value)}
              className="w-24 tabular-nums"
            />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={poolEnabled} onCheckedChange={setPoolEnabled} />
            <span className="text-ui-fg-subtle">Pool enabled</span>
          </label>
        </div>
        {poolEnabled && dpd === 0 && (
          <Text size="small" className="text-ui-tag-orange-text">
            Pool is enabled but draws per day is 0 — players can&apos;t draw.
            Set a positive number, or turn the pool off to pause it.
          </Text>
        )}
        {!dpdValid && (
          <Text size="small" className="text-ui-tag-red-text">
            Draws per day must be a whole number (0 or more).
          </Text>
        )}
      </div>

      {/* Entries */}
      <Table>
        <Table.Header>
          <Table.Row>
            <Table.HeaderCell>Kind</Table.HeaderCell>
            <Table.HeaderCell>Prize</Table.HeaderCell>
            <Table.HeaderCell className="text-right">Weight</Table.HeaderCell>
            <Table.HeaderCell className="text-right">Odds</Table.HeaderCell>
            <Table.HeaderCell />
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {rows.map((r, i) => {
            const card = r.product_handle
              ? cardByHandle.get(r.product_handle)
              : undefined;
            const err = errors[i];
            return (
              <Table.Row key={r.localId}>
                <Table.Cell>
                  <Select
                    size="small"
                    value={r.kind}
                    onValueChange={(v) => setKind(r.localId, v as RewardKind)}
                  >
                    <Select.Trigger className="w-32">
                      <Select.Value />
                    </Select.Trigger>
                    <Select.Content>
                      <Select.Item value="product">Product</Select.Item>
                      <Select.Item value="credit">Credit</Select.Item>
                      <Select.Item value="nothing">Nothing</Select.Item>
                    </Select.Content>
                  </Select>
                </Table.Cell>
                <Table.Cell>
                  {r.kind === 'product' ? (
                    <div className="flex items-center gap-3">
                      {card ? (
                        <>
                          <img
                            src={resolveImageUrl(card.image)}
                            alt=""
                            className="h-10 w-8 shrink-0 rounded object-contain"
                          />
                          <span className="max-w-[14rem] truncate">
                            {card.name}
                          </span>
                        </>
                      ) : (
                        <span className="text-ui-fg-subtle text-sm">
                          {r.product_handle
                            ? `${r.product_handle} (not in card catalog)`
                            : 'No product chosen'}
                        </span>
                      )}
                      <Button
                        size="small"
                        variant="secondary"
                        onClick={() => setPickerFor(r.localId)}
                      >
                        Choose
                      </Button>
                    </div>
                  ) : r.kind === 'credit' ? (
                    <Input
                      type="number"
                      min={0}
                      step={0.01}
                      placeholder="MYR"
                      value={r.credit_amount}
                      onChange={(e) =>
                        setRow(r.localId, { credit_amount: e.target.value })
                      }
                      className="w-32 tabular-nums"
                    />
                  ) : (
                    <span className="text-ui-fg-subtle">—</span>
                  )}
                  {err && (
                    <Text size="small" className="text-ui-tag-red-text mt-1">
                      {err}
                    </Text>
                  )}
                </Table.Cell>
                <Table.Cell className="text-right">
                  <Input
                    type="number"
                    min={1}
                    value={r.weight}
                    onChange={(e) =>
                      setRow(r.localId, { weight: e.target.value })
                    }
                    className="w-20 tabular-nums"
                  />
                </Table.Cell>
                <Table.Cell className="text-ui-fg-subtle text-right tabular-nums">
                  {fmtPct(probs.get(r.localId) ?? 0)}
                </Table.Cell>
                <Table.Cell className="text-right">
                  <Button
                    size="small"
                    variant="transparent"
                    onClick={() => removeRow(r.localId)}
                  >
                    Remove
                  </Button>
                </Table.Cell>
              </Table.Row>
            );
          })}
        </Table.Body>
      </Table>

      {/* Footer */}
      <div className="flex flex-col gap-3 px-6 py-4">
        <div>
          <Button size="small" variant="secondary" onClick={addRow}>
            Add entry
          </Button>
        </div>
        {empty && (
          <Text size="small" className="text-ui-tag-orange-text">
            A pool needs at least one entry. Turn Pool enabled off to pause
            draws instead of clearing it.
          </Text>
        )}
        <div className="flex items-center justify-end">
          <Button
            variant="primary"
            onClick={save}
            isLoading={saving}
            disabled={!canSave}
          >
            {saving ? 'Saving…' : 'Save pool'}
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
                          setRow(pickerFor, { product_handle: c.handle });
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
    </Container>
  );
};

export default RewardPoolsPage;
