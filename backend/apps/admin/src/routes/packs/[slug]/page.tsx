import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Alert,
  Badge,
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
  AdminCard,
  AdminPack,
  PackOddsResponse,
  PublishedOdds,
} from '../../../lib/packs-api';
import {
  MIN_PCT,
  proposeRarities,
  RARITIES,
  solveOddsForRtp,
} from '@acme/odds-math';
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
  applyRarityProposals,
  applySolveResult,
  mapOddsToRows,
  previewSets,
  publishedEvPreview,
  rowsToSetEntries,
  rowsToSolveInput,
  setEvRtp,
  type EditRow,
} from '../../../lib/odds-rows';
import { resolveImageUrl } from '../../../lib/image-url';
import { shouldSeedBuffer } from '../../../lib/seed-buffer';
import { LoadingSkeleton } from '../../../components/LoadingSkeleton';

// A card staged by the cards list's bulk "Add to gacha pack" — NOT a pool
// member yet. It enters as an UNLOCKED COMMON, which is exactly how
// set-pack-members admits a new member (it becomes a balancer and absorbs a
// share of the remainder), so the live preview here matches what the save
// persists. `currentPct` 0 = "no saved rate yet".
const pendingRow = (c: AdminCard): EditRow => ({
  card_id: c.handle,
  name: c.name,
  image: c.image,
  slab_image: c.slab_image,
  rarity: 'Common',
  // DISPLAY price (FMV × fx × the card's markup) — the same number the odds
  // route puts on a saved row, so the EV/RTP chips stay honest while pending.
  market_value: c.priceBreakdown.displayPrice,
  stock: c.stock,
  currentPct: 0,
  locked: false,
  pctInput: '0',
  pctInput2: '',
  pctInput3: '',
  topHitInput: '',
  pending: true,
});

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

  // Auto-split (target-RTP) staging — local only until Save. `targetRtpInput`
  // seeds from the pack's stored target_rtp_bps; the report says which chase
  // cards got pinned at the storable floor and why, since that is how an
  // operator learns a pack is mispriced.
  const [targetRtpInput, setTargetRtpInput] = useState('70');
  const [autoSplitError, setAutoSplitError] = useState<string | null>(null);
  const [autoSplitReport, setAutoSplitReport] = useState<{
    achievedRtp: number;
    floored: { name: string; fairPct: number }[];
    tierCollapse: string[];
  } | null>(null);
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

  // ── Cards staged from the Gacha Cards list ──────────────────────────────
  // The bulk "Add to gacha pack" action navigates here with the picked handles
  // on router state. Latched into state at mount because the effect below
  // clears that history entry immediately: a browser refresh replays the entry
  // (state included), and an unlatched read would re-append the same rows on
  // every reload. Consumed (emptied) by the seed below, so a pool save's
  // reseed can't re-stage cards the operator has since dealt with.
  const { state: navState } = useLocation();
  const navAddCards = (navState as { addCards?: string[] } | null)?.addCards;
  const [pendingAdd, setPendingAdd] = useState<string[]>(
    () => navAddCards ?? [],
  );
  // Keyed off the ROUTER STATE, not the latch: the seed below empties
  // pendingAdd DURING render, and React commits only the re-render — so when
  // usePackOdds is a cache hit (the primary flow: editor → cards list → back to
  // the same pack, inside React Query's gcTime) the first COMMITTED render
  // already has an empty latch, and an effect keyed on it would never clear the
  // history entry. Re-runs harmlessly once the state is null.
  useEffect(() => {
    if (navAddCards) navigate('.', { replace: true, state: null });
  }, [navAddCards, navigate]);

  // Prize-pool membership — which cards belong to this pack. The same catalog
  // query supplies the display fields for staged rows, so it also loads when
  // cards arrived to be staged (the cards list just warmed this cache).
  const [poolOpen, setPoolOpen] = useState(false);
  const cardsQuery = useCards({ enabled: poolOpen || pendingAdd.length > 0 });
  const allCards = cardsQuery.data ?? null;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const savingMembers = saveMembersMut.isPending;

  // Staged rows need the catalog for their name/image/price, so hold the seed
  // until that query SETTLES — gating on "loaded" would leave the whole editor
  // on the skeleton forever if the catalog fetch fails.
  const catalogSettled = cardsQuery.isSuccess || cardsQuery.isError;
  // Same render-phase hazard as the clear above, plus the router state is
  // already null by the time a later catalog error lands — so latch "cards
  // arrived" once, at mount, and let the error itself trigger the toast.
  const stagedAtMount = useRef(pendingAdd.length > 0);
  useEffect(() => {
    if (stagedAtMount.current && cardsQuery.isError) {
      toast.error(t('packs.pool.loadError'));
    }
  }, [cardsQuery.isError, t]);

  if (
    shouldSeedBuffer(data, seededFrom, (s) => s.pack.slug !== slug) &&
    (pendingAdd.length === 0 || catalogSettled)
  ) {
    setSeededFrom(data);
    // Read off `data` (the type guard above narrows it), not `seededFrom` —
    // that state var will not reflect this `setSeededFrom` call until the
    // NEXT render, so testing it here would silently skip the seed on the
    // very first load (`shouldSeedBuffer` also re-gates false by then).
    if (data.pack.target_rtp_bps != null) {
      setTargetRtpInput(String(data.pack.target_rtp_bps / 100));
    }
    // Reseeding means a different snapshot is now authoritative (new pack,
    // or membership just changed) — a report/error from the previous buffer
    // no longer describes these rows.
    setAutoSplitError(null);
    setAutoSplitReport(null);
    const seeded = mapOddsToRows(data.odds);
    if (pendingAdd.length === 0) {
      setRows(seeded);
    } else {
      // Only handles that are NOT already members become pending rows — adding
      // a card the pack already holds is a no-op, not a duplicate row.
      const inPool = new Set(seeded.map((r) => r.card_id));
      const byHandle = new Map((allCards ?? []).map((c) => [c.handle, c]));
      const staged = pendingAdd
        .filter((h) => !inPool.has(h))
        .map((h) => byHandle.get(h))
        .filter((c): c is AdminCard => c !== undefined)
        .map(pendingRow);
      setRows([...seeded, ...staged]);
      setPendingAdd([]);
    }
  }

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

  // Live preview of ALL THREE odds sets — the SAME math the save workflow runs
  // (computeSetWeights), so what the operator sees in "After save" is exactly
  // what gets persisted. Changing a rate or a rarity re-splits the unlocked
  // Common balancer's share immediately, in every set that resolves through it.
  const preview = useMemo(() => previewSets(rows ?? []), [rows]);

  // Per-set readouts: Σ (100% when valid) and the theoretical EV/RTP that set
  // pays. All null while the preview is errored — nothing would be saved, so a
  // number here would be a lie (see previewSets).
  const sets = useMemo(
    () =>
      ([1, 2, 3] as const).map((n) => {
        const pct = preview.pct[n];
        const money = setEvRtp(rows ?? [], pct, data?.pack.price ?? 0);
        const sum = [...pct.values()].reduce((s, p) => s + p, 0);
        return {
          n,
          total: pct.size === 0 ? null : Math.round(sum * 100) / 100,
          ev: money?.ev ?? null,
          rtp: money?.rtp ?? null,
        };
      }),
    [preview, rows, data],
  );

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

  // Auto-split: propose value-banded rarities, solve the chase budget for the
  // target RTP, and stage BOTH as unsaved edits. Nothing is persisted until
  // the operator hits save — the report is how they learn the pack is
  // mispriced. Set 1 ONLY: rowsToSolveInput always pins locked rows at their
  // SET-1 rate regardless of which set is passed, so auto-splitting set 2/3
  // would compute EV off the wrong pinned rate (see odds-rows.ts).
  const autoSplit = (set: 1 | 2 | 3) => {
    if (!rows || !seededFrom) return;
    setAutoSplitError(null);
    setAutoSplitReport(null);

    const price = seededFrom.pack.price;
    const target = Number(targetRtpInput) / 100;

    const proposals = proposeRarities(
      rows.map((r) => ({ card_id: r.card_id, value: r.market_value })),
      price,
    );
    const retiered = applyRarityProposals(rows, proposals);

    const result = solveOddsForRtp(rowsToSolveInput(retiered), price, target);
    if (result.error) {
      setAutoSplitError(result.error);
      return;
    }

    setRows(applySolveResult(retiered, result, set));
    setAutoSplitReport({
      achievedRtp: result.achievedRtp ?? 0,
      floored: result.floored.map((f) => ({
        name: rows.find((r) => r.card_id === f.card_id)?.name ?? f.card_id,
        fairPct: f.fairPct,
      })),
      tierCollapse: result.tierCollapse,
    });
  };

  async function save() {
    if (!rows || preview.error || saving || savingMembers) return;
    try {
      // TWO-PHASE when cards were staged from the cards list — membership MUST
      // land first. save-pack-odds rejects any submission whose card set does
      // not match the pack's saved pool ("Submitted cards do not match this
      // pack's prize pool"), so an odds POST carrying staged rows would 400.
      // The members step admits them as unlocked Commons (balancers) — exactly
      // the shape the pending rows preview — and only then does the odds save
      // below write every row's tuned rate, set-equality guard satisfied.
      if (rows.some((r) => r.pending)) {
        await saveMembersMut.mutateAsync({
          slug,
          card_ids: rows.map((r) => r.card_id),
        });
        // The cards are real pool members now: drop the flags immediately so a
        // failing odds save can't leave badges claiming otherwise, and a retry
        // goes straight to the odds phase.
        setRows((prev) => prev?.map((r) => ({ ...r, pending: false })) ?? null);
      }
      const entries = rowsToSetEntries(rows);
      // Blank/invalid target must not silently 400 the whole save — omit it
      // (the server keeps the pack's stored target) rather than send a value
      // it will reject.
      const targetBps = Math.round(Number(targetRtpInput) * 100);
      const res = await saveOdds.mutateAsync({
        slug,
        entries,
        ...(Number.isFinite(targetBps) && targetBps >= 1
          ? { target_rtp_bps: targetBps }
          : {}),
      });
      const byId = new Map(res.odds.map((c) => [c.card_id, c]));
      // Set 1 only — that is all the response carries. The set-2/3 inputs are
      // deliberately left as typed: they ARE what was just saved, and the save
      // also materializes weight_2/weight_3 on the unlocked Common balancer,
      // which would show up here as an override the operator never entered.
      // That materialization surfaces on the next load instead (mapOddsToRows).
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
          rows={rows ?? []}
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
          {/* What each odds set actually pays back, live against the buffer —
              the same figures the packs list shows per pack, one click away. */}
          <div className="flex flex-wrap items-center gap-2 px-6 py-4">
            {sets.map((s) => (
              <div
                key={s.n}
                className="bg-ui-bg-subtle flex flex-col rounded-lg px-3 py-2"
              >
                <Text size="xsmall" className="text-ui-fg-subtle">
                  {t('packs.editor.set', { n: s.n })} · {t('packs.editor.evRtp')}
                </Text>
                <Text size="small" className="tabular-nums">
                  {s.ev === null || s.rtp === null
                    ? '—'
                    : `${rm(s.ev)} · ${fmtPct(s.rtp)}`}
                </Text>
              </div>
            ))}
            <Text size="small" className="text-ui-fg-subtle ml-2 max-w-md">
              {t('packs.editor.setsHint')}
            </Text>
            <div className="ml-auto flex items-end gap-x-2">
              <div>
                <Label htmlFor="target-rtp" size="xsmall">
                  {t('packs.editor.targetRtp')}
                </Label>
                <Input
                  id="target-rtp"
                  className="w-24"
                  type="number"
                  min={0.01}
                  step={0.01}
                  value={targetRtpInput}
                  onChange={(e) => setTargetRtpInput(e.target.value)}
                />
              </div>
              <Button
                size="small"
                variant="secondary"
                disabled={!rows || saving}
                onClick={() => autoSplit(1)}
              >
                {t('packs.editor.autoSplit')}
              </Button>
            </div>
          </div>

          {autoSplitError && (
            <Alert variant="error" className="mx-6 mb-4">
              {autoSplitError}
            </Alert>
          )}
          {autoSplitReport && (
            <Alert variant="warning" className="mx-6 mb-4">
              <Text size="small" weight="plus">
                {t('packs.editor.autoSplitDone')}
              </Text>
              <Text size="small" className="mt-1">
                {t('packs.editor.autoSplitRtp', {
                  rtp: (autoSplitReport.achievedRtp * 100).toFixed(2),
                  target: targetRtpInput,
                })}
              </Text>
              {autoSplitReport.floored.length > 0 && (
                <>
                  <Text size="small" className="mt-1">
                    {t('packs.editor.autoSplitFloored', {
                      count: autoSplitReport.floored.length,
                    })}
                  </Text>
                  <ul className="mt-1 list-disc pl-5">
                    {autoSplitReport.floored.map((f) => (
                      <li key={f.name}>
                        <Text size="small">
                          {t('packs.editor.autoSplitFlooredRow', {
                            name: f.name,
                            fair: Math.round(100 / f.fairPct).toLocaleString(),
                            actual: Math.round(100 / MIN_PCT).toLocaleString(),
                          })}
                        </Text>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {autoSplitReport.tierCollapse.length > 0 && (
                <Text size="small" className="mt-1">
                  {t('packs.editor.autoSplitCollapse', {
                    tiers: autoSplitReport.tierCollapse.join(', '),
                  })}
                </Text>
              )}
            </Alert>
          )}

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
                {([1, 2, 3] as const).map((n) => (
                  <Table.HeaderCell key={n}>
                    {t('packs.editor.set', { n })}
                  </Table.HeaderCell>
                ))}
                <Table.HeaderCell className="text-right">
                  {t('packs.editor.result')}
                </Table.HeaderCell>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {rows.map((r) => {
                const next = preview.pct[1].get(r.card_id) ?? null;
                const changed =
                  next !== null && Math.abs(next - r.currentPct) >= 0.005;
                return (
                  <Table.Row key={r.card_id}>
                    <Table.Cell>
                      <div className="flex items-center gap-3">
                        <img
                          src={resolveImageUrl(r.slab_image || r.image)}
                          alt=""
                          className="h-10 w-8 shrink-0 rounded object-contain"
                        />
                        <div className="flex flex-col items-start gap-y-0.5">
                          <span className="max-w-[18rem] truncate">
                            {r.name}
                          </span>
                          {r.pending && (
                            <Badge size="2xsmall" color="orange">
                              {t('packs.editor.pendingRow')}
                            </Badge>
                          )}
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
                    {([1, 2, 3] as const).map((n) => (
                      <SetRateCell
                        key={n}
                        set={n}
                        row={r}
                        effective={preview.pct[n].get(r.card_id) ?? null}
                        onChange={(v) =>
                          setRow(
                            r.card_id,
                            n === 1
                              ? { pctInput: v }
                              : n === 2
                                ? { pctInput2: v }
                                : { pctInput3: v },
                          )
                        }
                      />
                    ))}
                    <Table.Cell
                      className={clx(
                        'text-right tabular-nums',
                        changed
                          ? 'text-ui-fg-base font-medium'
                          : 'text-ui-fg-subtle',
                      )}
                    >
                      {next === null ? '—' : fmtPct(next)}
                    </Table.Cell>
                  </Table.Row>
                );
              })}
            </Table.Body>
          </Table>
          </div>

          <div className="flex flex-col gap-3 px-6 py-4">
            {preview.error && (
              <Text size="small" className="text-ui-tag-red-text">
                {preview.error}
              </Text>
            )}
            <div className="flex items-center justify-between">
              {/* Every set must total 100% — the balancer guarantees it, so a
                  reading that is not 100 means the preview refused to resolve. */}
              <div className="text-ui-fg-subtle flex gap-6 text-sm tabular-nums">
                {sets.map((s) => (
                  <span key={s.n}>
                    {t('packs.editor.set', { n: s.n })}:{' '}
                    <span
                      className={
                        s.total === 100
                          ? 'text-ui-fg-base'
                          : 'text-ui-tag-orange-text'
                      }
                    >
                      {s.total === null ? '—' : fmtPct(s.total)}
                    </span>
                  </span>
                ))}
              </div>
              <Button
                variant="primary"
                onClick={save}
                isLoading={saving || savingMembers}
                disabled={saving || savingMembers || preview.error !== null}
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

// ── One win-rate cell ────────────────────────────────────────────────────────
// A pack carries THREE odds tables; a customer's group decides which one their
// spin rolls against (set 1 = default).
//
//   - An UNLOCKED COMMON is the balancer (§2.4): its rate is whatever the other
//     rows leave over, in every set. Typing into it would do nothing, so it
//     renders as the derived value with a badge instead of an input.
//   - Set 1 stays lock-gated (lock a row to type an exact rate). Sets 2/3 take
//     an override on any pinned row; BLANK means "inherit the previous set"
//     (3 → 2 → 1) and shows the resolved % as the placeholder.
const SetRateCell = ({
  set,
  row,
  effective,
  onChange,
}: {
  set: 1 | 2 | 3;
  row: EditRow;
  /** Resolved % for this card in this set; null while the preview is errored. */
  effective: number | null;
  onChange: (value: string) => void;
}) => {
  const { t } = useTranslation();
  const label = `${t('packs.editor.set', { n: set })} ${t('packs.editor.winRate')}: ${row.name}`;

  if (!row.locked && row.rarity === 'Common') {
    return (
      <Table.Cell>
        <div className="flex items-center gap-x-1.5">
          <span className="text-ui-fg-subtle tabular-nums">
            {effective === null ? '—' : fmtPct(effective)}
          </span>
          {set === 1 && (
            <Badge size="2xsmall">{t('packs.editor.balancer')}</Badge>
          )}
        </div>
      </Table.Cell>
    );
  }

  const value =
    set === 1 ? row.pctInput : set === 2 ? row.pctInput2 : row.pctInput3;
  return (
    <Table.Cell>
      <Input
        type="number"
        min={0}
        max={100}
        step={0.01}
        disabled={set === 1 && !row.locked}
        aria-label={label}
        value={value}
        placeholder={set === 1 || effective === null ? '' : String(effective)}
        onChange={(e) => onChange(e.target.value)}
        className="w-20 tabular-nums"
      />
    </Table.Cell>
  );
};

// ── Published odds (PUBLIC) ──────────────────────────────────────────────────
// The percentages players see on the storefront pack page ({ overall, per-tier }).
// Display-only: saving here never touches the per-card win-rate weights.
// Mounted with key={slug}, only once fullPack is loaded, so the initial state
// can seed straight from props.
const PublishedOddsSection = ({
  pack,
  rows,
  saving,
  onSave,
}: {
  pack: AdminPack;
  /** The pool, for the live Published EV readout (tier average × tier %). */
  rows: EditRow[];
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
  // What the PUBLISHED percentages promise the player, priced off the pool the
  // operator is looking at — live against the tier inputs being typed (the
  // packs list carries the saved figure). The gap against the per-set EV chips
  // above is the whole point of showing both.
  const pubEv = useMemo(() => publishedEvPreview(rows, tiers), [rows, tiers]);

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

      <div className="mt-2 flex flex-wrap items-center gap-x-4">
        <Text
          size="small"
          className={
            sum === 100 ? 'text-ui-fg-subtle' : 'text-ui-tag-orange-text'
          }
        >
          {t('packs.published.sum', { sum })}
        </Text>
        <Text size="small" className="text-ui-fg-subtle tabular-nums">
          {t('packs.published.ev')}: {pubEv === null ? '—' : rm(pubEv)}
        </Text>
      </div>
      {!pack.published_odds && (
        <Text size="small" className="text-ui-fg-subtle mt-1">
          {t('packs.published.notSet')}
        </Text>
      )}
    </div>
  );
};

export default PackOddsEditorPage;
