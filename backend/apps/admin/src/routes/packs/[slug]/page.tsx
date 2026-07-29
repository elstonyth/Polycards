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
  DEFAULT_TIER_PCT,
  MIN_PCT,
  RARITIES,
  type OddsRarity,
  type TierSplitResult,
  type TierSplitTier,
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
  applyTierSplit,
  mapOddsToRows,
  previewSets,
  publishedEvByTier,
  publishedEvPreview,
  rowsToSetEntries,
  setEvByTier,
  setEvRtp,
  tierSplit,
  type EditRow,
  type TierEv,
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

/** The house recipe as free-typed strings — the editor's starting point and
 *  what "Reset to house default" restores. */
const houseDefaults = (): Record<string, string> =>
  Object.fromEntries(RARITIES.map((r) => [r, String(DEFAULT_TIER_PCT[r])]));

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

  // The house odds recipe: each tier's share of the 100%, free-typed so the
  // operator can retune it per pack. Feeds the win rates below AND the public
  // published-odds inputs — the two used to be filled in by hand and drift
  // apart. Local to the editor: every pack opens on the house default.
  const [defaults, setDefaults] =
    useState<Record<string, string>>(houseDefaults);

  // The recipe belongs to a PACK, so it resets on a pack change and ONLY on a
  // pack change. It cannot live in the seeding block below: saveMembers clears
  // `seededFrom` to force a reseed of the SAME pack, so resetting there would
  // wipe a tuned recipe the instant the operator adds a card — and because
  // unlocked rows derive live, every rate in the table would jump with no
  // notice. Keyed off `slug` rather than the snapshot for the same reason.
  const [defaultsFor, setDefaultsFor] = useState(slug);
  if (defaultsFor !== slug) {
    setDefaultsFor(slug);
    setDefaults(houseDefaults());
  }

  // A half-typed field ('' or '1.') is NaN — coerced to 0 here rather than
  // asserted away, so the Record<OddsRarity, number> type stays honest.
  const defaultsNum = useMemo(
    () =>
      Object.fromEntries(
        RARITIES.map((r) => {
          const n = Number(defaults[r]);
          return [r, Number.isFinite(n) ? n : 0];
        }),
      ) as Record<OddsRarity, number>,
    [defaults],
  );
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
    // NOTE: the tier recipe is deliberately NOT reset here — this block also
    // runs after a pool save on the same pack. See `defaultsFor` above.
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

  // The default-odds split against the pool's CURRENT rarities. Null until the
  // pool loads — an empty buffer would report every tier as "no cards".
  const split = useMemo(
    () => (rows === null ? null : tierSplit(rows, defaultsNum)),
    [rows, defaultsNum],
  );

  // THE rows: unlocked non-Common cards take their tier's default share, live.
  // There is no "apply" step — an unlocked card simply follows the recipe, the
  // same way an unlocked Common simply balances. Lock is the ONLY way a rate
  // gets typed by hand, which makes the switch mean one thing instead of two.
  //
  // Everything downstream (preview, EV/RTP, save) reads THIS, never `rows`, so
  // what the table shows is exactly what gets persisted.
  const effective = useMemo(
    () => (rows && split ? applyTierSplit(rows, split) : (rows ?? [])),
    [rows, split],
  );

  // Live preview of ALL THREE odds sets — the SAME math the save workflow runs
  // (computeSetWeights), so the rates on screen are exactly what gets persisted.
  // Editing a share or a rarity re-splits every dependent row immediately.
  const preview = useMemo(() => previewSets(effective), [effective]);

  // Per-set readouts: Σ (100% when valid) and the theoretical EV/RTP that set
  // pays. All null while the preview is errored — nothing would be saved, so a
  // number here would be a lie (see previewSets).
  const sets = useMemo(
    () =>
      ([1, 2, 3] as const).map((n) => {
        const pct = preview.pct[n];
        const money = setEvRtp(effective, pct, data?.pack.price ?? 0);
        const sum = [...pct.values()].reduce((s, p) => s + p, 0);
        return {
          n,
          total: pct.size === 0 ? null : Math.round(sum * 100) / 100,
          ev: money?.ev ?? null,
          rtp: money?.rtp ?? null,
          // Whether this set has a table of its OWN, rather than inheriting
          // 3 → 2 → 1. Keyed off materialization, never off "its EV matches
          // set 1" — EV is rounded to the ringgit, so two genuinely different
          // tables can collide there and a live alternate set would go unlisted.
          materialized:
            n === 1 ||
            effective.some((r) => (n === 2 ? r.pctInput2 : r.pctInput3) !== ''),
        };
      }),
    [preview, effective, data],
  );

  const setRow = (cardId: string, patch: Partial<EditRow>) =>
    setRows(
      (prev) =>
        prev?.map((r) => (r.card_id === cardId ? { ...r, ...patch } : r)) ??
        null,
    );

  // Locking hands the operator the wheel, pre-filled with the rate the card has
  // right now — rounded to the 2dp the 1 bps storage floor can actually hold, so
  // a derived 0.0333 does not land in the input as an out-of-step value.
  const toggleLock = (r: EditRow) => {
    // While the preview is errored `previewSets` returns empty maps, so fall
    // back to the card's last SAVED rate. Without this the newly editable field
    // would open on whatever stale text `pctInput` still held — a number the
    // operator never typed and the table never showed.
    const derived = preview.pct[1].get(r.card_id) ?? r.currentPct;
    setRow(r.card_id, {
      locked: !r.locked,
      ...(r.locked
        ? {}
        : { pctInput: String(Math.round(derived * 100) / 100) }),
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
      // `effective`, not `rows` — unlocked non-Common rows carry no hand-typed
      // rate any more, so submitting the raw buffer would persist whatever
      // stale text was last in `pctInput` instead of the derived share on
      // screen. This is the one line that keeps preview and storage identical.
      const entries = rowsToSetEntries(effective);
      const res = await saveOdds.mutateAsync({ slug, entries });
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

      {/* The recipe. Drives every unlocked row below, live, and seeds the
          public odds. */}
      <DefaultOddsSection
        defaults={defaults}
        onChange={(rarity, value) =>
          setDefaults((m) => ({ ...m, [rarity]: value }))
        }
        onReset={() => setDefaults(houseDefaults())}
        split={split}
      />

      {/* The PUBLIC percentages players see. Display-only: saving here never
          touches the per-card win rates in the table below. */}
      {fullPack && (
        <PublishedOddsSection
          key={fullPack.slug}
          pack={fullPack}
          rows={rows ?? []}
          defaults={defaults}
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
          {/* What each set pays back, broken out by tier — rates and prices
              side by side don't reveal that a 22% Rare outspends a 0.1%
              Immortal on a card worth twice as much. Inherited sets are
              omitted: they ARE set 1. */}
          <TierEvBreakdown
            columns={sets
              .filter((s) => s.materialized)
              .map((s) => ({
                key: t('packs.editor.set', { n: s.n }),
                rows: setEvByTier(effective, preview.pct[s.n]),
                total:
                  s.ev === null || s.rtp === null
                    ? '—'
                    : `${rm(s.ev)} · ${fmtPct(s.rtp)}`,
              }))}
          />

          <div
            className="overflow-x-auto"
            tabIndex={0}
            role="region"
            aria-label="Pack odds table"
          >
            <Table>
              <Table.Header>
                <Table.Row>
                  <Table.HeaderCell>{t('packs.editor.card')}</Table.HeaderCell>
                  <Table.HeaderCell>
                    {t('packs.editor.rarity')}
                  </Table.HeaderCell>
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
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {/* `effective`, not `rows` — the preview, the EV tiles and the
                    save all read it, so the body must too or the table is one
                    derivation behind them. Same card_ids either way; edits
                    still write through `setRow` to `rows`. */}
                {effective.map((r) => {
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
                          onValueChange={(v) =>
                            setRow(r.card_id, { rarity: v })
                          }
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
                  reading that is not 100 means the preview refused to resolve.
                  Inherited sets are omitted: they are set 1 by definition. */}
              <div className="text-ui-fg-subtle flex gap-5 text-sm tabular-nums">
                {sets
                  .filter((s) => s.materialized)
                  .map((s) => (
                    <span key={s.n}>
                      {t('packs.editor.set', { n: s.n })}{' '}
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
                      setSelected(
                        new Set((allCards ?? []).map((c) => c.handle)),
                      )
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

// ── Per-tier EV breakdown ────────────────────────────────────────────────────
// One tier per row, one odds SET per column, so "where does the payout come
// from" is a glance instead of arithmetic. The published (public) EV gets the
// same per-tier split, but printed under its own inputs rather than here — that
// section already has a labelled tier grid, and repeating the labels to reuse
// this component would cost more space than it saves.
//
// Tiers with no card in the pool are dropped entirely rather than rendered as
// '—': an empty ladder rung is noise, and the Default odds panel above already
// says which tiers are empty.
const TierEvBreakdown = ({
  columns,
}: {
  columns: { key: string; rows: TierEv[]; total: string }[];
}) => {
  const { t } = useTranslation();
  if (columns.length === 0) return null;
  const live = RARITIES.filter((r) =>
    columns.some((c) => c.rows.find((x) => x.rarity === r)?.ev != null),
  );
  if (live.length === 0) return null;

  return (
    <div className="px-6 py-3">
      {/* CSS grid for the layout, ARIA table roles for the semantics — without
          them a screen reader reads the cells as one flat run with no idea
          which tier or which set a figure belongs to. */}
      <div
        role="table"
        aria-label={t('packs.editor.evByTier')}
        className="grid w-fit gap-x-6 gap-y-0.5 text-sm tabular-nums"
        style={{
          gridTemplateColumns: `auto repeat(${columns.length}, minmax(0, 1fr))`,
        }}
      >
        {columns.length > 1 && (
          <div role="row" className="contents">
            <span role="columnheader" />
            {columns.map((c) => (
              <span
                key={c.key}
                role="columnheader"
                className="text-ui-fg-muted text-right text-xs uppercase"
              >
                {c.key}
              </span>
            ))}
          </div>
        )}
        {live.map((rarity) => (
          <div role="row" className="contents" key={rarity}>
            <span role="rowheader" className="text-ui-fg-subtle">
              {rarity}
            </span>
            {columns.map((c) => {
              const ev = c.rows.find((x) => x.rarity === rarity)?.ev ?? null;
              return (
                <span key={c.key} role="cell" className="text-right">
                  {ev === null ? '—' : rm(ev)}
                </span>
              );
            })}
          </div>
        ))}
        <div role="row" className="contents">
          <span
            role="rowheader"
            className="text-ui-fg-base border-ui-border-base mt-1 border-t pt-1"
          >
            {t('packs.editor.evRtp')}
          </span>
          {columns.map((c) => (
            <span
              key={c.key}
              role="cell"
              className="text-ui-fg-base border-ui-border-base mt-1 border-t pt-1 text-right font-medium"
            >
              {c.total}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
};

// ── Default odds (the recipe) ────────────────────────────────────────────────
// Each tier owns a fixed share of the 100%; the cards in a tier split it evenly
// (2 Immortals → 0.05% each). There is no apply step — every unlocked row in the
// table below follows these numbers live. The same numbers seed the published
// odds, so the secret rates and the public ones start in sync.
const DefaultOddsSection = ({
  defaults,
  onChange,
  onReset,
  split,
}: {
  defaults: Record<string, string>;
  onChange: (rarity: OddsRarity, value: string) => void;
  onReset: () => void;
  /** Live preview of the split against the pool's CURRENT rarities. Null while
   *  the pool is still loading — the shares stay editable, the explanation of
   *  where they land waits until there are cards to explain. */
  split: TierSplitResult | null;
}) => {
  const { t } = useTranslation();
  const total =
    Math.round(
      RARITIES.reduce((s, r) => s + (Number(defaults[r]) || 0), 0) * 100,
    ) / 100;
  const byRarity = new Map((split?.tiers ?? []).map((x) => [x.rarity, x]));
  const noBalancer =
    split !== null && (byRarity.get('Common')?.balancerCount ?? 0) === 0;
  const floored = (split?.tiers ?? []).filter((x) => x.floored);
  const zeroed = (split?.tiers ?? []).filter((x) => x.zeroed);
  const overspent = (split?.tiers ?? []).filter((x) => x.overspent);

  /** The per-tier line under each input. Says what the tier's cards actually
   *  get, including when locks have eaten the share — the panel contradicting
   *  the table below is worse than no panel. */
  const tierNote = (r: OddsRarity, tier: TierSplitTier | undefined) => {
    if (split === null || r === 'Common') return null;
    if (!tier || (tier.count === 0 && tier.lockedCount === 0)) {
      return t('packs.defaults.perCardEmpty');
    }
    if (tier.count === 0) {
      return t('packs.defaults.allLocked', { n: tier.lockedCount });
    }
    const each = t('packs.defaults.perCard', {
      n: tier.count,
      pct: fmtPct(tier.perCardPct),
    });
    return tier.lockedCount > 0
      ? `${each} · ${t('packs.defaults.plusLocked', {
          n: tier.lockedCount,
          pct: fmtPct(Math.round(tier.lockedPct * 100) / 100),
        })}`
      : each;
  };

  return (
    <div className="px-6 py-4">
      <div className="flex items-center justify-between gap-4">
        <Heading level="h3">{t('packs.defaults.title')}</Heading>
        <Button size="small" variant="transparent" onClick={onReset}>
          {t('packs.defaults.reset')}
        </Button>
      </div>

      {/* One row of shares. The per-card result lives under each field so the
          "0.1% across 3 cards" arithmetic never has to be done by hand. */}
      <div className="mt-3 grid grid-cols-3 gap-x-3 gap-y-2 lg:grid-cols-6">
        {RARITIES.map((r) => {
          const tier = byRarity.get(r);
          const each = tierNote(r, tier);
          return (
            <div key={r} className="flex flex-col gap-y-1">
              <Label size="xsmall" htmlFor={`default-tier-${r}`}>
                {r}
              </Label>
              <Input
                id={`default-tier-${r}`}
                size="small"
                type="number"
                min={0}
                max={100}
                step={0.01}
                value={defaults[r] ?? ''}
                onChange={(e) => onChange(r, e.target.value)}
                className="tabular-nums"
              />
              <Text size="xsmall" className="text-ui-fg-muted">
                {r === 'Common' ? t('packs.editor.balancer') : (each ?? ' ')}
              </Text>
            </div>
          );
        })}
      </div>

      {/* One status line, not four. Everything that needs saying about where
          the shares actually landed says it here. */}
      <Text size="xsmall" className="text-ui-fg-subtle mt-2">
        <span className={total === 100 ? undefined : 'text-ui-tag-orange-text'}>
          {t('packs.defaults.total', { total })}
        </span>
        {(split?.unusedPct ?? 0) > 0 &&
          ` · ${t('packs.defaults.unused', {
            pct: fmtPct(Math.round((split?.unusedPct ?? 0) * 100) / 100),
          })}`}
      </Text>

      {/* Everything that makes a tier NOT do what its number says, in one
          place: a floored tier costs more than its share, a zeroed one makes
          its cards unpullable, an overspent one has locks past its budget, and
          without a balancer nothing absorbs the remainder. */}
      {(floored.length > 0 ||
        zeroed.length > 0 ||
        overspent.length > 0 ||
        noBalancer) && (
        <Alert variant="warning" className="mt-3">
          {[
            floored.length > 0 &&
              t('packs.defaults.floored', {
                tiers: floored.map((x) => x.rarity).join(', '),
                min: fmtPct(MIN_PCT),
              }),
            zeroed.length > 0 &&
              t('packs.defaults.zeroed', {
                tiers: zeroed.map((x) => x.rarity).join(', '),
              }),
            overspent.length > 0 &&
              t('packs.defaults.overspent', {
                tiers: overspent.map((x) => x.rarity).join(', '),
              }),
            noBalancer && t('packs.defaults.noBalancer'),
          ]
            .filter(Boolean)
            .join(' ')}
        </Alert>
      )}
    </div>
  );
};

// ── One win-rate cell ────────────────────────────────────────────────────────
// A pack carries THREE odds tables; a customer's group decides which one their
// spin rolls against (set 1 = default).
//
// Rates are DERIVED unless the row is locked — that is the whole model:
//   - An UNLOCKED COMMON is the balancer (§2.4): it takes whatever the other
//     rows leave over, in every set.
//   - Any other UNLOCKED row takes its tier's default share, split evenly with
//     its tier-mates.
//   - LOCKED rows are the only hand-typed ones. Lock a card to override it.
// So an unlocked row shows a value with a tag and no input; locking swaps in
// the field, pre-filled with the rate the card had.
//   - Sets 2/3 take an override on any locked row; BLANK means "inherit the
//     previous set" (3 → 2 → 1) and shows the resolved % as the placeholder.
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

  // The lock gate applies to SET 1 ONLY. An unlocked Common balances in every
  // set, so it is never typed. But an unlocked non-Common row must still accept
  // a set-2/3 override: those are alternate tables for other customer groups,
  // and gating them behind set 1's lock would mean changing set 1 just to edit
  // set 2 — and would leave an already-stored override visible nowhere while it
  // kept driving that set's payout.
  const derived = !row.locked && (set === 1 || row.rarity === 'Common');
  if (derived) {
    const isBalancer = row.rarity === 'Common';
    return (
      <Table.Cell>
        <div className="flex items-center gap-x-1.5">
          <span className="text-ui-fg-subtle tabular-nums">
            {effective === null ? '—' : fmtPct(effective)}
          </span>
          {set === 1 && (
            <Badge size="2xsmall">
              {isBalancer
                ? t('packs.editor.balancer')
                : t('packs.editor.fromDefault')}
            </Badge>
          )}
        </div>
      </Table.Cell>
    );
  }

  const value =
    set === 1 ? row.pctInput : set === 2 ? row.pctInput2 : row.pctInput3;
  // Weights store as whole basis points, so a typed 7.567 persists as 7.57.
  // The input keeps what the operator is typing (clobbering it mid-keystroke is
  // worse), and the resolved rate shows beside it ONLY when the two differ —
  // otherwise "what you see is what's saved" quietly stops being true.
  const typed = Number(value);
  // A rate under half a basis point rounds to weight 0 — the card can never be
  // pulled, and nothing else in the editor would say so. Called out separately
  // from ordinary rounding because it is a different kind of wrong.
  const unpullable =
    effective === 0 &&
    value.trim() !== '' &&
    Number.isFinite(typed) &&
    typed > 0;
  const rounds =
    effective !== null &&
    value.trim() !== '' &&
    Math.abs(effective - typed) >= 0.005;
  return (
    <Table.Cell>
      <div className="flex items-center gap-x-1.5">
        <Input
          type="number"
          min={0}
          max={100}
          step={0.01}
          aria-label={label}
          value={value}
          placeholder={set === 1 || effective === null ? '' : String(effective)}
          onChange={(e) => onChange(e.target.value)}
          className="w-20 tabular-nums"
        />
        {(rounds || unpullable) && (
          <span
            className={clx(
              'whitespace-nowrap text-xs tabular-nums',
              unpullable ? 'text-ui-tag-orange-text' : 'text-ui-fg-muted',
            )}
            title={unpullable ? t('packs.editor.unpullable') : undefined}
          >
            {unpullable ? t('packs.editor.never') : fmtPct(effective)}
          </span>
        )}
      </div>
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
  defaults,
  saving,
  onSave,
}: {
  pack: AdminPack;
  /** The pool, for the live Published EV readout (tier average × tier %). */
  rows: EditRow[];
  /** The default-odds table above — seeds a pack that has never published, and
   *  backs "Fill from default odds". Nothing is written until Save, so this
   *  cannot change what the storefront shows on its own. */
  defaults: Record<string, string>;
  saving: boolean;
  onSave: (po: PublishedOdds) => Promise<void>;
}) => {
  const { t } = useTranslation();
  const [overall, setOverall] = useState<string>(
    pack.published_odds ? String(pack.published_odds.overall) : '100',
  );
  // Seeded once (the section is mounted with key={slug}); a pack that HAS
  // published odds keeps them verbatim — the preset must never silently
  // overwrite live public numbers.
  //
  // The seed reads the HOUSE constant, not the editable `defaults` prop. This
  // section remounts on `fullPack.slug` (the `usePacks` query) while `defaults`
  // resets on the separate `usePackOdds` query, so during a pack A → B
  // navigation with one cache warm and the other cold, the prop can still hold
  // pack A's edited recipe for a render or two. `defaults` is still what the
  // "Use defaults" button copies — that is an explicit click, never a race.
  const [tiers, setTiers] = useState<Record<string, string>>(() => {
    const house = houseDefaults();
    return Object.fromEntries(
      RARITIES.map((r) => [
        r,
        pack.published_odds?.tiers[r] !== undefined
          ? String(pack.published_odds.tiers[r])
          : pack.published_odds
            ? ''
            : (house[r] ?? ''),
      ]),
    );
  });

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
  // Same number, split per tier — which advertised rate is actually carrying
  // the promise. Sits under each input rather than in its own grid so the tier
  // labels are not printed twice.
  const pubEvTiers = useMemo(
    () => publishedEvByTier(rows, tiers),
    [rows, tiers],
  );

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
      <div className="flex items-center justify-between gap-4">
        <div>
          <Heading level="h3">{t('packs.published.title')}</Heading>
          <Text className="text-ui-fg-subtle" size="xsmall">
            {t('packs.published.subtitle')}
          </Text>
        </div>
        <div className="flex shrink-0 items-center gap-x-2">
          <Button
            size="small"
            variant="transparent"
            onClick={() => setTiers({ ...defaults })}
          >
            {t('packs.published.fillFromDefaults')}
          </Button>
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
      </div>

      <div className="mt-3 grid grid-cols-3 gap-x-3 gap-y-2 lg:grid-cols-7">
        <div className="flex flex-col gap-y-1">
          <Label size="xsmall" htmlFor="published-overall">
            {t('packs.published.overall')}
          </Label>
          <Input
            id="published-overall"
            size="small"
            type="number"
            min={0}
            max={100}
            step={0.1}
            value={overall}
            onChange={(e) => setOverall(e.target.value)}
            className="tabular-nums"
          />
        </div>
        {RARITIES.map((r) => {
          const ev = pubEvTiers.find((x) => x.rarity === r)?.ev ?? null;
          return (
            <div key={r} className="flex flex-col gap-y-1">
              <Label size="xsmall" htmlFor={`published-tier-${r}`}>
                {r}
              </Label>
              <Input
                id={`published-tier-${r}`}
                size="small"
                type="number"
                min={0}
                max={100}
                step={0.1}
                placeholder="—"
                value={tiers[r] ?? ''}
                onChange={(e) =>
                  setTiers((m) => ({ ...m, [r]: e.target.value }))
                }
                className="tabular-nums"
              />
              <Text size="xsmall" className="text-ui-fg-muted tabular-nums">
                {ev === null ? ' ' : rm(ev)}
              </Text>
            </div>
          );
        })}
      </div>

      <Text size="xsmall" className="text-ui-fg-subtle mt-1 tabular-nums">
        <span className={sum === 100 ? undefined : 'text-ui-tag-orange-text'}>
          {t('packs.published.sum', { sum })}
        </span>
        {` · ${t('packs.published.ev')} ${pubEv === null ? '—' : rm(pubEv)}`}
        {!pack.published_odds && ` · ${t('packs.published.notSet')}`}
      </Text>
    </div>
  );
};

export default PackOddsEditorPage;
