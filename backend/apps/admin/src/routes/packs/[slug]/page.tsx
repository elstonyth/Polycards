import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
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
  Checkbox,
  toast,
  clx,
} from '@medusajs/ui';
import { ArrowLeft } from '@medusajs/icons';
import type { PackOddsResponse } from '../../../lib/packs-api';
import { computeOdds, RARITIES } from '@acme/odds-math';
import {
  useCards,
  usePackOdds,
  useSaveMembers,
  useSaveOdds,
} from '../../../lib/queries';
import { fmtPct } from '../../../lib/format';
import {
  mapOddsToRows,
  rowsToOddsInputs,
  type EditRow,
} from '../../../lib/odds-rows';
import { resolveImageUrl } from '../../../lib/image-url';

const PackOddsEditorPage = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { slug = '' } = useParams();

  const { data, isError: loadError } = usePackOdds(slug);
  const saveOdds = useSaveOdds();
  const saveMembersMut = useSaveMembers();
  const [rows, setRows] = useState<EditRow[] | null>(null);
  const saving = saveOdds.isPending;
  const packTitle = data?.pack.title ?? '';
  const packStatus = data?.pack.status ?? '';

  // Seed (and reseed) the editable buffer from the server snapshot, during render
  // (not an effect) per react.dev "you might not need an effect". React Query keeps
  // a stable `data` reference until the content changes, so this reseeds only on
  // initial load and after our explicit post-save-members invalidation — never
  // clobbering in-progress edits.
  const [seededFrom, setSeededFrom] = useState<PackOddsResponse | undefined>(
    undefined,
  );
  if (data && data !== seededFrom) {
    setSeededFrom(data);
    setRows(mapOddsToRows(data.odds));
  }

  // Prize-pool membership — which cards belong to this pack.
  const [poolOpen, setPoolOpen] = useState(false);
  const { data: allCards = null } = useCards({ enabled: poolOpen });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const savingMembers = saveMembersMut.isPending;

  const openPool = () => {
    setSelected(new Set((rows ?? []).map((r) => r.card_id)));
    setPoolOpen(true);
  };

  const toggleCard = (handle: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(handle)) next.delete(handle);
      else next.add(handle);
      return next;
    });

  const saveMembers = async () => {
    try {
      const res = await saveMembersMut.mutateAsync({
        slug,
        card_ids: Array.from(selected),
      });
      toast.success(
        t('packs.pool.saved', { added: res.added, removed: res.removed }),
      );
      setPoolOpen(false);
      // Invalidation (in the hook) refetches the odds → the seeding effect reseeds.
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  // Live preview — the SAME rarity-weighted math the save workflow runs, so what
  // the operator sees in "After save" is exactly what gets persisted. Changing a
  // row's rarity re-splits the unlocked share immediately.
  const { result, previewByCard } = useMemo(() => {
    const inputs = rowsToOddsInputs(rows ?? []);
    const result = computeOdds(inputs);
    const previewByCard = new Map(
      result.computed.map((c) => [c.card_id, c.pct]),
    );
    return { result, previewByCard };
  }, [rows]);

  const setRow = (cardId: string, patch: Partial<EditRow>) =>
    setRows(
      (prev) =>
        prev?.map((r) => (r.card_id === cardId ? { ...r, ...patch } : r)) ??
        null,
    );

  // Locking captures the card's CURRENT real % so the operator can pin a card to
  // preserve it (rather than letting the even-split flatten it).
  const toggleLock = (r: EditRow) =>
    setRow(r.card_id, {
      locked: !r.locked,
      pctInput: !r.locked ? String(r.currentPct) : r.pctInput,
    });

  const newTotalPct = useMemo(
    () => result.computed.reduce((s, c) => s + c.pct, 0),
    [result],
  );
  const noneLocked = !!rows && rows.length > 0 && rows.every((r) => !r.locked);

  async function save() {
    if (!rows || result.error || saving) return;
    try {
      const entries = rowsToOddsInputs(rows);
      const res = await saveOdds.mutateAsync({ slug, entries });
      const byId = new Map(res.odds.map((c) => [c.card_id, c]));
      setRows(
        (prev) =>
          prev?.map((r) => {
            const c = byId.get(r.card_id);
            return c
              ? {
                  ...r,
                  currentPct: c.pct,
                  locked: c.locked,
                  pctInput: String(c.pct),
                }
              : r;
          }) ?? null,
      );
      toast.success(t('packs.editor.saved'));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      toast.error(message);
    }
  }

  if (loadError) {
    return (
      <Container className="p-6">
        <Text className="text-ui-fg-subtle">{t('packs.editor.loadError')}</Text>
      </Container>
    );
  }

  return (
    <Container className="divide-y p-0">
      <div className="flex items-start justify-between gap-4 px-6 py-4">
        <div>
          <button
            type="button"
            onClick={() => navigate('/packs')}
            className="text-ui-fg-subtle hover:text-ui-fg-base mb-2 flex items-center gap-1 text-sm"
          >
            <ArrowLeft className="h-4 w-4" />
            {t('packs.editor.back')}
          </button>
          <div className="flex items-center gap-2">
            <Heading level="h2">{packTitle || slug}</Heading>
            {packStatus && (
              <StatusBadge color={packStatus === 'active' ? 'green' : 'grey'}>
                {packStatus}
              </StatusBadge>
            )}
          </div>
          <Text className="text-ui-fg-subtle mt-1 max-w-2xl" size="small">
            {t('packs.editor.subtitle')}
          </Text>
        </div>
        <Button
          size="small"
          variant="secondary"
          onClick={openPool}
          disabled={rows === null}
        >
          {t('packs.pool.manage')}
        </Button>
      </div>

      {rows === null ? (
        <div className="px-6 py-8">
          <Text className="text-ui-fg-subtle">…</Text>
        </div>
      ) : (
        <>
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.HeaderCell>{t('packs.editor.card')}</Table.HeaderCell>
                <Table.HeaderCell>{t('packs.editor.rarity')}</Table.HeaderCell>
                <Table.HeaderCell className="text-right">
                  {t('packs.editor.value')}
                </Table.HeaderCell>
                <Table.HeaderCell className="text-right">
                  {t('packs.editor.current')}
                </Table.HeaderCell>
                <Table.HeaderCell className="text-center">
                  {t('packs.editor.lock')}
                </Table.HeaderCell>
                <Table.HeaderCell>{t('packs.editor.winRate')}</Table.HeaderCell>
                <Table.HeaderCell className="text-right">
                  {t('packs.editor.result')}
                </Table.HeaderCell>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {rows.map((r) => {
                const preview = previewByCard.get(r.card_id) ?? 0;
                const changed = Math.abs(preview - r.currentPct) >= 0.005;
                return (
                  <Table.Row key={r.card_id}>
                    <Table.Cell>
                      <div className="flex items-center gap-3">
                        <img
                          src={resolveImageUrl(r.image)}
                          alt=""
                          className="h-10 w-8 shrink-0 rounded object-contain"
                        />
                        <div className="flex flex-col">
                          <span className="max-w-[18rem] truncate">
                            {r.name}
                          </span>
                          {r.stock === 0 && (
                            <span className="text-ui-tag-orange-text text-xs">
                              {t('packs.editor.buybackOnly')}
                            </span>
                          )}
                        </div>
                      </div>
                    </Table.Cell>
                    <Table.Cell>
                      <Select
                        size="small"
                        value={r.rarity}
                        onValueChange={(v) => setRow(r.card_id, { rarity: v })}
                      >
                        <Select.Trigger className="w-32">
                          <Select.Value />
                        </Select.Trigger>
                        <Select.Content>
                          {RARITIES.map((rarity) => (
                            <Select.Item key={rarity} value={rarity}>
                              {rarity}
                            </Select.Item>
                          ))}
                        </Select.Content>
                      </Select>
                    </Table.Cell>
                    <Table.Cell className="text-ui-fg-subtle text-right tabular-nums">
                      $
                      {r.market_value.toLocaleString('en-US', {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}
                    </Table.Cell>
                    <Table.Cell className="text-ui-fg-subtle text-right tabular-nums">
                      {fmtPct(r.currentPct)}
                    </Table.Cell>
                    <Table.Cell className="text-center">
                      <Switch
                        checked={r.locked}
                        onCheckedChange={() => toggleLock(r)}
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
                          setRow(r.card_id, { pctInput: e.target.value })
                        }
                        className="w-24 tabular-nums"
                      />
                    </Table.Cell>
                    <Table.Cell
                      className={clx(
                        'text-right tabular-nums',
                        changed
                          ? 'text-ui-fg-base font-medium'
                          : 'text-ui-fg-subtle',
                      )}
                    >
                      {fmtPct(preview)}
                    </Table.Cell>
                  </Table.Row>
                );
              })}
            </Table.Body>
          </Table>

          <div className="flex flex-col gap-3 px-6 py-4">
            {noneLocked && (
              <Text size="small" className="text-ui-tag-orange-text">
                {t('packs.editor.flattenWarning')}
              </Text>
            )}
            {result.error && (
              <Text size="small" className="text-ui-tag-red-text">
                {result.error}
              </Text>
            )}
            <div className="flex items-center justify-between">
              <div className="text-ui-fg-subtle flex gap-6 text-sm tabular-nums">
                <span>
                  {t('packs.editor.lockedTotal')}:{' '}
                  <span className="text-ui-fg-base">
                    {fmtPct(result.lockedTotalPct)}
                  </span>
                </span>
                <span>
                  {t('packs.editor.newTotal')}:{' '}
                  <span className="text-ui-fg-base">{fmtPct(newTotalPct)}</span>
                </span>
              </div>
              <Button
                variant="primary"
                onClick={save}
                isLoading={saving}
                disabled={saving || result.error !== null}
              >
                {saving ? t('packs.editor.saving') : t('packs.editor.save')}
              </Button>
            </div>
          </div>
        </>
      )}

      <FocusModal
        open={poolOpen}
        onOpenChange={(open) => {
          if (!open) setPoolOpen(false);
        }}
      >
        <FocusModal.Content>
          <FocusModal.Header>
            <div className="flex items-center justify-end gap-x-2">
              <Button
                size="small"
                variant="secondary"
                onClick={() => setPoolOpen(false)}
              >
                {t('packs.pool.cancel')}
              </Button>
              <Button
                size="small"
                onClick={saveMembers}
                isLoading={savingMembers}
              >
                {t('packs.pool.save')}
              </Button>
            </div>
          </FocusModal.Header>
          <FocusModal.Body className="flex flex-col items-center overflow-auto p-10">
            <div className="flex w-full max-w-[640px] flex-col gap-y-4">
              <div>
                <FocusModal.Title asChild>
                  <Heading level="h2">{t('packs.pool.title')}</Heading>
                </FocusModal.Title>
                <FocusModal.Description asChild>
                  <Text className="text-ui-fg-subtle mt-1" size="small">
                    {t('packs.pool.subtitle', { count: selected.size })}
                  </Text>
                </FocusModal.Description>
              </div>
              {allCards === null ? (
                <Text className="text-ui-fg-subtle">…</Text>
              ) : allCards.length === 0 ? (
                <Text className="text-ui-fg-subtle">
                  {t('packs.pool.noCards')}
                </Text>
              ) : (
                <div className="divide-y rounded-lg border">
                  {allCards.map((c) => (
                    <label
                      key={c.handle}
                      className="hover:bg-ui-bg-base-hover flex cursor-pointer items-center gap-3 px-4 py-2"
                    >
                      <Checkbox
                        checked={selected.has(c.handle)}
                        onCheckedChange={() => toggleCard(c.handle)}
                      />
                      <img
                        src={resolveImageUrl(c.image)}
                        alt=""
                        className="h-9 w-7 shrink-0 rounded object-contain"
                      />
                      <div className="flex flex-1 flex-col">
                        <span className="truncate text-sm font-medium">
                          {c.name}
                        </span>
                        <span className="text-ui-fg-subtle text-xs">
                          {[c.grader, c.grade].filter(Boolean).join(' ') || '—'}{' '}
                          · ${c.market_value.toLocaleString('en-US')}
                        </span>
                      </div>
                    </label>
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

export default PackOddsEditorPage;
