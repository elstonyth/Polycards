import { useEffect, useMemo, useRef, useState } from 'react';
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
  Label,
  Select,
  StatusBadge,
  FocusModal,
  Checkbox,
  toast,
  clx,
} from '@medusajs/ui';
import { ArrowLeft } from '@medusajs/icons';
import type {
  AdminPack,
  PackOddsResponse,
  PublishedOdds,
} from '../../../lib/packs-api';
import { computeOdds, RARITIES } from '@acme/odds-math';
import {
  useCards,
  usePackOdds,
  usePacks,
  useSaveMembers,
  useSaveOdds,
  useSaveTopHits,
  useUpdatePack,
} from '../../../lib/queries';
import { fmtPct, rm } from '../../../lib/format';
import {
  mapOddsToRows,
  rowsToOddsInputs,
  type EditRow,
} from '../../../lib/odds-rows';
import { resolveImageUrl } from '../../../lib/image-url';
import { shouldSeedBuffer } from '../../../lib/seed-buffer';
import { LoadingSkeleton } from '../../../components/LoadingSkeleton';

/**
 * Pack odds editor (`/packs/:slug`): edit a pack's prize-pool membership and
 * per-card odds. The odds buffer seeds once per slug and reseeds after a pool
 * save; the router reuses this component across `:slug` changes.
 */
const PackOddsEditorPage = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { slug = '' } = useParams();

  const { data, isError: loadError, refetch } = usePackOdds(slug);
  const saveOdds = useSaveOdds();
  const saveMembersMut = useSaveMembers();
  const saveTopHits = useSaveTopHits();
  const [rows, setRows] = useState<EditRow[] | null>(null);
  const saving = saveOdds.isPending;
  const packTitle = data?.pack.title ?? '';
  const packStatus = data?.pack.status ?? '';

  // Full pack row (the status toggle must send the complete write payload —
  // the odds snapshot only carries slug/title/category/status).
  const { data: packsList = null } = usePacks();
  const fullPack = packsList?.find((p) => p.slug === slug) ?? null;
  const updatePack = useUpdatePack();
  // Mirror of the backend activation guard (hasRollablePool: ≥1 card row with
  // weight > 0 ⟺ a row with a positive saved %), for the disabled state only —
  // the server remains authoritative (rejects an empty/zero-weight pool).
  const canActivate = (rows ?? []).some((r) => r.currentPct > 0);

  const toggleStatus = async () => {
    if (!fullPack || updatePack.isPending) return;
    const next = packStatus === 'active' ? 'draft' : 'active';
    try {
      await updatePack.mutateAsync({ ...fullPack, status: next });
      toast.success(
        next === 'active'
          ? t('packs.editor.activated')
          : t('packs.editor.deactivated'),
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  // Seed the editable buffer from the server snapshot during render (not an
  // effect) per react.dev "you might not need an effect". Seed once per slug:
  // the router reuses this route component across `:slug` changes (no remount),
  // so reseed when the seeded snapshot's slug no longer matches. saveMembers
  // resets seededFrom so a pool save reseeds. This cannot loop — usePackOdds
  // sets no keepPreviousData, so `data` is either undefined or the requested
  // slug's payload and the route echoes the exact slug back; once seeded,
  // `seededFrom.pack.slug === slug` and the stale check goes quiet. See
  // shouldSeedBuffer for why a plain identity check would wipe edits on refetch.
  const [seededFrom, setSeededFrom] = useState<PackOddsResponse | undefined>(
    undefined,
  );
  if (shouldSeedBuffer(data, seededFrom, (s) => s.pack.slug !== slug)) {
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

  // Top-hit ORDER (1 = leftmost on the pack page; empty = not a Top Hit).
  // Typed freely into the row buffer, saved on blur/Enter as the complete
  // ordered list (sorted by the typed numbers; gaps/ties normalize to 1..n
  // server-side by list index — displayed numbers resync on next load, NOT
  // after save, so an order field the operator is currently typing in never
  // gets clobbered). Deliberately no query invalidation (see useSaveTopHits)
  // so in-progress win-rate edits survive.
  const setTopHitInput = (cardId: string, value: string) =>
    setRows(
      (cur) =>
        cur?.map((x) =>
          x.card_id === cardId ? { ...x, topHitInput: value } : x,
        ) ?? null,
    );
  // Ref-mirror of rows so a queued re-commit reads the LATEST buffer, not the
  // render that scheduled it; topHitRecommit queues (rather than drops) a
  // blur/Enter that lands while a save is still in flight — the follow-up
  // save runs once the current one settles, so no edit is ever lost and two
  // saves can't race out of order.
  const rowsRef = useRef<EditRow[] | null>(null);
  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);
  const topHitRecommit = useRef(false);
  const commitTopHits = async () => {
    const cur = rowsRef.current;
    if (!cur) return;
    if (saveTopHits.isPending) {
      topHitRecommit.current = true;
      return;
    }
    const card_ids = cur
      .filter((x) => {
        const n = Number(x.topHitInput.trim());
        return x.topHitInput.trim() !== '' && Number.isFinite(n) && n > 0;
      })
      .sort((a, b) => Number(a.topHitInput) - Number(b.topHitInput))
      .map((x) => x.card_id);
    try {
      await saveTopHits.mutateAsync({ slug, card_ids });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      if (topHitRecommit.current) {
        topHitRecommit.current = false;
        void commitTopHits();
      }
    }
  };

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
      // The hook's onSuccess returns the packOdds invalidation promise, so
      // mutateAsync resolves only after the refetch — the cache is fresh
      // here. Reset the seed so the render-time seeding reseeds the rows
      // from the new membership.
      setSeededFrom(undefined);
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
      <Container className="flex flex-col items-start gap-3 p-6">
        <Text className="text-ui-fg-subtle">{t('packs.editor.loadError')}</Text>
        <Button size="small" variant="secondary" onClick={() => refetch()}>
          Retry
        </Button>
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
        <div className="flex items-center gap-x-2">
          <Button
            size="small"
            variant="secondary"
            onClick={openPool}
            disabled={rows === null}
          >
            {t('packs.pool.manage')}
          </Button>
          {packStatus === 'draft' ? (
            <Button
              size="small"
              variant="primary"
              onClick={toggleStatus}
              isLoading={updatePack.isPending}
              disabled={!fullPack || !canActivate}
              title={!canActivate ? t('packs.editor.activateNeedsPool') : ''}
            >
              {t('packs.editor.activate')}
            </Button>
          ) : (
            packStatus === 'active' && (
              <Button
                size="small"
                variant="secondary"
                onClick={toggleStatus}
                isLoading={updatePack.isPending}
                disabled={!fullPack}
              >
                {t('packs.editor.deactivate')}
              </Button>
            )
          )}
        </div>
      </div>

      {/* Draft banner — a draft pack is invisible to customers; say so, and
          say what unblocks activation, right where the operator is working. */}
      {packStatus === 'draft' && (
        <div className="bg-ui-tag-orange-bg text-ui-tag-orange-text px-6 py-2.5 text-sm">
          {canActivate
            ? t('packs.editor.draftReadyBanner')
            : t('packs.editor.draftBanner')}
        </div>
      )}

      {/* Published odds — the PUBLIC percentages players see. Display-only,
          fully decoupled from the per-card win rates in the table below. */}
      {fullPack && (
        <PublishedOddsSection
          key={fullPack.slug}
          pack={fullPack}
          saving={updatePack.isPending}
          onSave={async (po) => {
            try {
              await updatePack.mutateAsync({ ...fullPack, published_odds: po });
              toast.success(t('packs.published.saved'));
            } catch (err) {
              toast.error(err instanceof Error ? err.message : String(err));
            }
          }}
        />
      )}

      {rows === null ? (
        <div className="px-6 py-8">
          <LoadingSkeleton />
        </div>
      ) : (
        <>
          <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Pack odds table">
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.HeaderCell>{t('packs.editor.card')}</Table.HeaderCell>
                <Table.HeaderCell>{t('packs.editor.rarity')}</Table.HeaderCell>
                <Table.HeaderCell className="text-center">
                  {t('packs.editor.topHit')}
                </Table.HeaderCell>
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
                          src={resolveImageUrl(r.slab_image || r.image)}
                          alt=""
                          className="h-10 w-8 shrink-0 rounded object-contain"
                        />
                        <div className="flex flex-col">
                          <span className="max-w-[18rem] truncate">
                            {r.name}
                          </span>
                          {r.stock !== null && r.stock < 0 ? (
                            // Wins keep counting below 0 — this is how many
                            // physical units the operator owes winners.
                            <span className="text-ui-tag-red-text text-xs font-medium">
                              {t('packs.editor.unitsOwed', {
                                count: Math.abs(r.stock),
                              })}
                            </span>
                          ) : (
                            r.stock === 0 && (
                              <span className="text-ui-tag-orange-text text-xs">
                                {t('packs.editor.buybackOnly')}
                              </span>
                            )
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
                        <Select.Trigger
                          className="w-32"
                          aria-label={`${t('packs.editor.rarity')}: ${r.name}`}
                        >
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
                    <Table.Cell className="text-center">
                      <Input
                        size="small"
                        inputMode="numeric"
                        placeholder="—"
                        className="mx-auto w-14 text-center tabular-nums"
                        value={r.topHitInput}
                        aria-label={`${t('packs.editor.topHit')}: ${r.name}`}
                        onChange={(e) =>
                          setTopHitInput(r.card_id, e.target.value)
                        }
                        onBlur={() => void commitTopHits()}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') e.currentTarget.blur();
                        }}
                      />
                    </Table.Cell>
                    <Table.Cell className="text-ui-fg-subtle text-right tabular-nums">
                      {rm(r.market_value)}
                    </Table.Cell>
                    <Table.Cell className="text-ui-fg-subtle text-right tabular-nums">
                      {fmtPct(r.currentPct)}
                    </Table.Cell>
                    <Table.Cell className="text-center">
                      <Switch
                        checked={r.locked}
                        aria-label={`${t('packs.editor.lock')}: ${r.name}`}
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
                        aria-label={`${t('packs.editor.winRate')}: ${r.name}`}
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
          </div>

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
              <div className="flex items-start justify-between gap-4">
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
                <div className="flex gap-2">
                  <Button
                    size="small"
                    variant="secondary"
                    onClick={() =>
                      setSelected(new Set((allCards ?? []).map((c) => c.handle)))
                    }
                  >
                    Select all
                  </Button>
                  <Button
                    size="small"
                    variant="secondary"
                    onClick={() => setSelected(new Set())}
                  >
                    Clear all
                  </Button>
                </div>
              </div>
              {allCards === null ? (
                <LoadingSkeleton />
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
                        src={resolveImageUrl(c.slab_image || c.image)}
                        alt=""
                        loading="lazy"
                        decoding="async"
                        className="h-9 w-7 shrink-0 rounded object-contain"
                      />
                      <div className="flex flex-1 flex-col">
                        <span className="truncate text-sm font-medium">
                          {c.name}
                        </span>
                        <span className="text-ui-fg-subtle text-xs">
                          {[c.grader, c.grade].filter(Boolean).join(' ') || '—'}{' '}
                          · {rm(c.priceBreakdown.marketMyr)}
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

// ── Published odds (PUBLIC) ──────────────────────────────────────────────────
// The percentages players see on the storefront pack page ({ overall, per-tier }).
// Display-only: saving here never touches the per-card win-rate weights.
// Mounted with key={slug}, only once fullPack is loaded, so the initial state
// can seed straight from props.
const PublishedOddsSection = ({
  pack,
  saving,
  onSave,
}: {
  pack: AdminPack;
  saving: boolean;
  onSave: (po: PublishedOdds) => Promise<void>;
}) => {
  const { t } = useTranslation();
  const [overall, setOverall] = useState<string>(
    pack.published_odds ? String(pack.published_odds.overall) : '100',
  );
  const [tiers, setTiers] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      RARITIES.map((r) => [
        r,
        pack.published_odds?.tiers[r] !== undefined
          ? String(pack.published_odds.tiers[r])
          : '',
      ]),
    ),
  );

  const validPct = (v: string) =>
    v.trim() === '' ||
    (Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 100);
  const allValid =
    overall.trim() !== '' &&
    validPct(overall) &&
    RARITIES.every((r) => validPct(tiers[r] ?? ''));
  const sum =
    Math.round(
      RARITIES.reduce((s, r) => s + (Number(tiers[r]) || 0), 0) * 100,
    ) / 100;

  const save = () =>
    onSave({
      overall: Number(overall),
      tiers: Object.fromEntries(
        RARITIES.filter((r) => (tiers[r] ?? '').trim() !== '').map((r) => [
          r,
          Number(tiers[r]),
        ]),
      ),
    });

  return (
    <div className="px-6 py-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <Heading level="h3">{t('packs.published.title')}</Heading>
          <Text className="text-ui-fg-subtle mt-1 max-w-2xl" size="small">
            {t('packs.published.subtitle')}
          </Text>
        </div>
        <Button
          size="small"
          variant="secondary"
          onClick={save}
          isLoading={saving}
          disabled={!allValid}
        >
          {t('packs.published.save')}
        </Button>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
        <div className="flex flex-col gap-y-1">
          <Label size="xsmall" weight="plus" htmlFor="published-overall">
            {t('packs.published.overall')}
          </Label>
          <Input
            id="published-overall"
            type="number"
            min={0}
            max={100}
            step={0.1}
            value={overall}
            onChange={(e) => setOverall(e.target.value)}
          />
        </div>
        {RARITIES.map((r) => (
          <div key={r} className="flex flex-col gap-y-1">
            <Label size="xsmall" weight="plus" htmlFor={`published-tier-${r}`}>
              {r}
            </Label>
            <Input
              id={`published-tier-${r}`}
              type="number"
              min={0}
              max={100}
              step={0.1}
              placeholder="—"
              value={tiers[r] ?? ''}
              onChange={(e) =>
                setTiers((m) => ({ ...m, [r]: e.target.value }))
              }
            />
          </div>
        ))}
      </div>

      <Text
        size="small"
        className={clx(
          'mt-2',
          sum === 100 ? 'text-ui-fg-subtle' : 'text-ui-tag-orange-text',
        )}
      >
        {t('packs.published.sum', { sum })}
      </Text>
      {!pack.published_odds && (
        <Text size="small" className="text-ui-fg-subtle mt-1">
          {t('packs.published.notSet')}
        </Text>
      )}
    </div>
  );
};

export default PackOddsEditorPage;
