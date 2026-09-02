import { useRef, useState, type ChangeEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Checkbox,
  Container,
  Heading,
  Text,
  Table,
  Button,
  Switch,
  Input,
  Label,
  StatusBadge,
  FocusModal,
  Prompt,
  toast,
  usePrompt,
} from '@medusajs/ui';
import { Link, Sparkles } from '@medusajs/icons';
import type { RouteConfig } from '@mercurjs/dashboard-sdk';
import { type AdminCard, type AdminCardUpdate } from '../../lib/packs-api';
import {
  useCards,
  useDeleteCard,
  usePacks,
  useTierSettings,
  useUpdateCard,
  useUploadImage,
} from '../../lib/queries';
import type { TierRangeMap } from '@acme/odds-math';
import { outsideEveryRange } from '../../lib/tier-ranges';
import { resolveImageUrl } from '../../lib/image-url';
import { validateImageFile } from '../../lib/image-validation';
import { rm, timeAgo, myrToUsd } from '../../lib/format';
import { applyRangeSelect } from '../../lib/range-select';
import RegisterCardModal from './RegisterCardModal';
import CardPokemonFields from './CardPokemonFields';
import { GachaPipelineHint } from '../../components/GachaPipelineHint';
import { GraderGradeSelect } from '../../components/GraderGradeSelect';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';

export const config: RouteConfig = {
  label: 'Gacha Cards',
  icon: Sparkles,
  nested: '/products',
  rank: 2,
};

// Edit-only form state (inventory-first: NEW cards are registered from an
// existing inventory product via RegisterCardModal, never typed from scratch).
// No rarity — that is a per-pack property, edited in each pack's odds editor.
// Numbers stay strings so the operator can type freely (empty price = "use FMV").
type FormState = {
  handle: string;
  name: string;
  set: string;
  grader: string;
  grade: string;
  // Slab-label text (§8) — printed on the baked PSA composite; blank clears it.
  label_year: string;
  label_note: string;
  market_value: string;
  image: string;
  // Baked graded-slab composite (read-only here) — the thumbnail prefers it so
  // graded cards render framed; edits still target the bare `image`.
  slab_image: string | null;
  price: string;
  for_sale: boolean;
  // The picker value (a PixelPokemon library id). Sent on save ONLY when it
  // differs from the loaded value — an untouched picker sends undefined so a
  // price-only save leaves the link (and its mirrored sprite) intact.
  pixel_pokemon_id: string | null;
  // Loaded render cache (mirror of the linked entry) — preview only, not sent.
  pokemon_dex: number | null;
  sprite_image: string | null;
  // PriceCharting link (Task 5/9/11). Null pc_product_id here just means the
  // card was never linked; the "unlink" action clears an existing link by
  // setting this to null and sending it explicitly on save.
  pc_product_id: string | null;
  pc_grade: string | null;
  pc_synced_at: string | null;
  // Percent string (1.2 -> "20") so the operator edits a familiar unit.
  market_multiplier_pct: string;
  // The card's live USD→MYR rate (from priceBreakdown) — market_value is edited
  // in MYR but stored in USD, so we convert back with this on save.
  fx_rate: number;
};

const formFromCard = (c: AdminCard): FormState => ({
  handle: c.handle,
  name: c.name,
  set: c.set,
  grader: c.grader,
  grade: c.grade,
  label_year: c.label_year ?? '',
  label_note: c.label_note ?? '',
  // FMV shown/edited in MYR (priceBreakdown.marketMyr = market_value × live FX,
  // no markup); converted back to USD on save.
  market_value: String(c.priceBreakdown.marketMyr),
  image: c.image,
  slab_image: c.slab_image,
  // null price = "use FMV" → empty field (preserved on save as undefined).
  price: c.price === null ? '' : String(c.price),
  for_sale: c.for_sale,
  pixel_pokemon_id: c.pixel_pokemon_id,
  pokemon_dex: c.pokemon_dex,
  sprite_image: c.sprite_image,
  pc_product_id: c.pc_product_id,
  pc_grade: c.pc_grade,
  pc_synced_at: c.pc_synced_at,
  market_multiplier_pct: String(Math.round((c.market_multiplier - 1) * 100)),
  fx_rate: c.priceBreakdown.fxRate,
});

const gradeLabel = (c: AdminCard): string =>
  [c.grader, c.grade].filter(Boolean).join(' ');

// Sortable columns. No 'stock' — physical units are a fulfilment concern, not a
// catalog one, and the column was dropped from this table (§2.2).
type SortKey = 'name' | 'value' | 'price' | 'created';

const GachaCardsPage = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const prompt = usePrompt();
  const { data: cards = null, isError, refetch } = useCards();
  // Tier price ranges — only the bulk "add to pack" confirm reads them. The
  // chosen pack's own override (pack.tier_ranges) wins; the global
  // /tier-defaults ladder is the fallback. {} (nothing configured, or the
  // fetch failed) skips the prompt entirely.
  const globalTierRanges = (useTierSettings().data?.ranges ??
    {}) as TierRangeMap;
  const updateCard = useUpdateCard();
  const removeCard = useDeleteCard();
  const uploadImg = useUploadImage();
  const [registerOpen, setRegisterOpen] = useState(false);
  const [form, setForm] = useState<FormState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AdminCard | null>(null);
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<{
    key: SortKey;
    dir: 1 | -1;
  } | null>(null);
  // Bulk "add to a pack's prize pool" selection, by card handle.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pickerOpen, setPickerOpen] = useState(false);
  // Only the bulk "add to pack" picker needs this list, and /admin/packs now
  // scans every odds + card row to compute EV/RTP — so it stays unfetched until
  // the picker opens (same pattern as the pool picker's useCards({ enabled })).
  const {
    data: packs = null,
    isError: packsError,
    refetch: refetchPacks,
  } = usePacks({ enabled: pickerOpen });
  const fileRef = useRef<HTMLInputElement>(null);
  const uploading = uploadImg.isPending;
  const saving = updateCard.isPending;

  const patch = (p: Partial<FormState>) =>
    setForm((f) => (f ? { ...f, ...p } : f));

  const handleFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // Client-side gate: instant reject before the upload round-trip. The
    // server re-validates (and is authoritative).
    const problem = await validateImageFile(file, 'card');
    if (problem) {
      toast.error(problem);
      if (fileRef.current) fileRef.current.value = '';
      return;
    }
    try {
      const url = await uploadImg.mutateAsync({ file, kind: 'card' });
      patch({ image: url });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const canSave =
    !!form &&
    form.name.trim() !== '' &&
    // A grade is unrepresentable without a grader (§3a) — "grader chosen" and
    // "grade chosen" must move together.
    (form.grader === '' || form.grade !== '') &&
    form.image.trim() !== '' &&
    form.market_value.trim() !== '' &&
    Number(form.market_value) >= 0 &&
    // Markup is optional on the edit form (empty = leave unchanged), but when
    // present it's bounded to [0, 1000]% — matching the register modal — so a
    // fat-fingered value can't silently multiply every price for this card.
    (form.market_multiplier_pct.trim() === '' ||
      (Number(form.market_multiplier_pct) >= 0 &&
        Number(form.market_multiplier_pct) <= 1000)) &&
    !saving &&
    !uploading;

  const save = async () => {
    if (!form || !canSave) return;
    // Send pixel_pokemon_id ONLY when the picker changed vs the loaded card —
    // an untouched picker sends undefined so the backend leaves the link and its
    // mirrored sprite as-is (a price/grade edit can't wipe a linked sprite).
    const loadedPixelId =
      cards?.find((c) => c.handle === form.handle)?.pixel_pokemon_id ?? null;
    const payload: AdminCardUpdate = {
      name: form.name.trim(),
      set: form.set.trim(),
      grader: form.grader.trim(),
      grade: form.grade.trim(),
      label_year: form.label_year.trim() || null,
      label_note: form.label_note.trim() || null,
      // Edited in MYR; the backend tracks FMV in USD — convert back at the
      // card's live rate so the stored value stays PriceCharting-native.
      market_value: myrToUsd(Number(form.market_value), form.fx_rate),
      image: form.image.trim(),
      price: form.price.trim() === '' ? undefined : Number(form.price),
      for_sale: form.for_sale,
      pixel_pokemon_id:
        form.pixel_pokemon_id !== loadedPixelId
          ? form.pixel_pokemon_id
          : undefined,
      // pc_product_id stays untouched (undefined = backend keeps the stored
      // link) unless the operator hits Unlink, which submits null explicitly
      // and closes the form immediately.
      pc_product_id: undefined,
      // undefined = backend keeps the stored markup (the input only renders
      // for a PC-linked card, so an unlinked card's custom margin survives).
      market_multiplier:
        form.pc_product_id === null || form.market_multiplier_pct.trim() === ''
          ? undefined
          : 1 + Number(form.market_multiplier_pct) / 100,
    };
    try {
      await updateCard.mutateAsync({ handle: form.handle, ...payload });
      toast.success(t('cards.toast.updated'));
      setForm(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  // Unlink clears ONLY the PC link — it must not carry the operator's
  // in-progress (possibly unsaved) edits to other fields from the open form.
  // Values below are the card's last-loaded state (from the list), not
  // `form`'s live (possibly dirty) state.
  const unlink = async () => {
    const card = cards?.find((c) => c.handle === form?.handle);
    if (!form || !card) return;
    const confirmed = await prompt({
      title: t('cards.form.unlink'),
      description:
        'Remove the PriceCharting link? Price syncs stop until the card is linked again.',
      confirmText: t('cards.form.unlink'),
      cancelText: t('cards.form.cancel'),
    });
    if (!confirmed) return;
    try {
      await updateCard.mutateAsync({
        handle: card.handle,
        name: card.name,
        set: card.set,
        grader: card.grader,
        grade: card.grade,
        market_value: card.market_value,
        image: card.image,
        price: card.price ?? undefined,
        for_sale: card.for_sale,
        // updateCardInvoke has no tri-state for label_year/label_note (same
        // round-trip convention as pc_grade — omitted defaults to null, i.e.
        // CLEARED); send the loaded values explicitly so unlinking PC can't
        // silently wipe the slab label.
        label_year: card.label_year,
        label_note: card.label_note,
        // pixel_pokemon_id and market_multiplier omitted (undefined) → the
        // pokemon link + its mirror and the stored markup stay untouched;
        // unlink only clears the PriceCharting link (both halves, explicitly).
        pc_product_id: null,
        pc_grade: null,
      });
      toast.success(t('cards.toast.unlinked'));
      setForm(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const handle = deleteTarget.handle;
    setDeleteTarget(null);
    try {
      await removeCard.mutateAsync(handle);
      toast.success(t('cards.toast.deleted'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  const visible = (cards ?? [])
    .filter((c) => {
      const needle = q.trim().toLowerCase();
      if (!needle) return true;
      return (
        c.name.toLowerCase().includes(needle) ||
        c.handle.toLowerCase().includes(needle)
      );
    })
    .sort((a, b) => {
      if (!sort) return 0;
      const pick = (c: typeof a) =>
        sort.key === 'name'
          ? c.name.toLowerCase()
          : sort.key === 'value'
            ? (c.priceBreakdown.marketMyr ?? 0)
            : sort.key === 'price'
              ? // The column shows the sale price and falls back to the FMV-
                // derived display price when none is set — sort the same number.
                (c.price ?? c.priceBreakdown?.displayPrice ?? 0)
              : Date.parse(c.created_at);
      const va = pick(a);
      const vb = pick(b);
      return va < vb ? -sort.dir : va > vb ? sort.dir : 0;
    });

  // Unpaged list: "the rows on screen" IS the filtered set. Selecting is only
  // ever offered for rows the operator can see, and the apply step intersects
  // with this again (a refetch can drop a row mid-selection).
  const pageIds = visible.map((c) => c.handle);
  const allOnPage =
    pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const someOnPage = pageIds.some((id) => selected.has(id));

  // Decide add-vs-remove from `prev` inside the updater, not from the rendered
  // `allOnPage`: a refetch can swap the rows between the click and the update,
  // and a stale flag turns "select all" into a no-op.
  const toggleAll = () =>
    setSelected((prev) => {
      const next = new Set(prev);
      const everyOnPage =
        pageIds.length > 0 && pageIds.every((id) => prev.has(id));
      for (const id of pageIds) {
        if (everyOnPage) next.delete(id);
        else next.add(id);
      }
      return next;
    });

  // Shift-click range select (the Gmail convention) — same wiring as the
  // inventory list; the range math lives in lib/range-select.ts (pure,
  // vitest-covered). pageIds is the CURRENT filter+sort order, so a range
  // always matches what is on screen.
  const anchorRef = useRef<string | null>(null);
  const handleRowCheck = (handle: string, shiftKey: boolean) => {
    const anchor = anchorRef.current;
    anchorRef.current = handle;
    setSelected((prev) =>
      applyRangeSelect(prev, pageIds, anchor, handle, shiftKey),
    );
  };

  // Stage the selected cards in a pack's win-rate editor. Nothing is written
  // here: the editor appends them as PENDING rows (rarity defaulted from the
  // /tier-defaults price ranges) and its save persists the membership + the
  // odds in one operator-reviewed step. A card whose value sits outside EVERY
  // configured tier range asks for confirmation first; cancel keeps the
  // selection so the operator can rethink it.
  const addToPack = async (slug: string) => {
    const addCards = [...selected].filter((id) => pageIds.includes(id));
    if (addCards.length === 0) {
      setPickerOpen(false);
      setSelected(new Set());
      return;
    }
    const pack = (packs ?? []).find((p) => p.slug === slug);
    const tierRanges = ((pack?.tier_ranges ?? null) ??
      globalTierRanges) as TierRangeMap;
    const outside = outsideEveryRange(cards, addCards, tierRanges);
    if (outside.length > 0) {
      const confirmed = await prompt({
        title: t('cards.bulk.outsideTitle'),
        description: t('cards.bulk.outsideDesc', { count: outside.length }),
        confirmText: t('cards.bulk.outsideConfirm'),
      });
      if (!confirmed) return;
    }
    setPickerOpen(false);
    setSelected(new Set());
    navigate(`/packs/${slug}`, { state: { addCards } });
  };

  const ariaSort = (key: SortKey) =>
    sort?.key === key
      ? sort.dir === 1
        ? ('ascending' as const)
        : ('descending' as const)
      : undefined;

  const sortHeader = (key: SortKey, label: string) => (
    <button
      type="button"
      className="inline-flex items-center gap-1 hover:text-ui-fg-base"
      onClick={() =>
        setSort((s) =>
          s?.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: 1 },
        )
      }
    >
      {label}
      {sort?.key === key ? (sort.dir === 1 ? ' ↑' : ' ↓') : ''}
    </button>
  );

  return (
    <Container className="divide-y p-0">
      <div className="flex items-start justify-between gap-4 px-6 py-4">
        <div>
          <Heading level="h2">{t('cards.title')}</Heading>
          <Text className="text-ui-fg-subtle mt-1" size="small">
            {t('cards.subtitle')}
          </Text>
        </div>
        <Input
          className="w-56"
          placeholder="Search name or handle…"
          aria-label="Search cards by name or handle"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            // Narrowing the list changes WHICH rows are on screen — drop the
            // selection so the bulk bar's count can never include a row the
            // operator can no longer see.
            setSelected(new Set());
            // A new search is a new list — a stale anchor would range-select
            // across unrelated rows on the first shift-click.
            anchorRef.current = null;
          }}
        />
        <Button
          size="small"
          variant="primary"
          onClick={() => setRegisterOpen(true)}
        >
          {t('cards.new')}
        </Button>
      </div>

      <GachaPipelineHint current="card" />

      {cards !== null && (
        <Text size="small" className="text-ui-fg-subtle px-6 pb-2">
          {q.trim()
            ? `${visible.length} of ${cards.length} cards`
            : `${cards.length} cards`}
        </Text>
      )}

      {selected.size > 0 && (
        <div
          className="bg-ui-bg-subtle flex flex-wrap items-center gap-3 px-6 py-3"
          role="region"
          aria-label="Bulk actions"
        >
          <Text size="small" weight="plus">
            {t('cards.bulk.selected', { count: selected.size })}
          </Text>
          <Button size="small" onClick={() => setPickerOpen(true)}>
            {t('cards.bulk.addToPack')}
          </Button>
        </div>
      )}

      {isError ? (
        <div className="flex flex-col items-start gap-y-3 px-6 py-8">
          <Text className="text-ui-fg-subtle">{t('cards.list.loadError')}</Text>
          <Button size="small" variant="secondary" onClick={() => refetch()}>
            Retry
          </Button>
        </div>
      ) : cards === null ? (
        <div className="px-6 py-8">
          <LoadingSkeleton />
        </div>
      ) : cards.length === 0 ? (
        <div className="px-6 py-8">
          <Text className="text-ui-fg-subtle">{t('cards.list.empty')}</Text>
        </div>
      ) : (
        <div
          className="overflow-x-auto"
          tabIndex={0}
          role="region"
          aria-label="Cards table"
        >
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.HeaderCell className="w-10">
                  <Checkbox
                    aria-label="Select all cards"
                    checked={
                      allOnPage ? true : someOnPage ? 'indeterminate' : false
                    }
                    onCheckedChange={toggleAll}
                  />
                </Table.HeaderCell>
                <Table.HeaderCell aria-sort={ariaSort('name')}>
                  {sortHeader('name', t('cards.list.card'))}
                </Table.HeaderCell>
                <Table.HeaderCell>{t('cards.list.grade')}</Table.HeaderCell>
                <Table.HeaderCell
                  aria-sort={ariaSort('value')}
                  className="text-right"
                >
                  {sortHeader('value', t('cards.list.value'))}
                </Table.HeaderCell>
                <Table.HeaderCell
                  aria-sort={ariaSort('price')}
                  className="text-right"
                >
                  {sortHeader('price', t('cards.list.price'))}
                </Table.HeaderCell>
                <Table.HeaderCell
                  aria-sort={ariaSort('created')}
                  className="text-right"
                >
                  {sortHeader('created', t('cards.list.created'))}
                </Table.HeaderCell>
                <Table.HeaderCell>{t('cards.list.status')}</Table.HeaderCell>
                <Table.HeaderCell className="text-right">
                  {t('cards.list.actions')}
                </Table.HeaderCell>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {visible.map((c) => (
                <Table.Row key={c.handle}>
                  {/* select-none: a shift-click must range-select, not smear a
                      text selection across the rows in between. */}
                  <Table.Cell className="select-none">
                    <Checkbox
                      aria-label={`Select ${c.name}`}
                      checked={selected.has(c.handle)}
                      onClick={(e) => handleRowCheck(c.handle, e.shiftKey)}
                    />
                  </Table.Cell>
                  <Table.Cell>
                    <div className="flex items-center gap-3">
                      <img
                        src={resolveImageUrl(c.slab_image || c.image)}
                        alt=""
                        loading="lazy"
                        decoding="async"
                        className="h-10 w-8 shrink-0 rounded object-contain"
                      />
                      <div className="flex flex-col">
                        <span className="max-w-[22rem] truncate font-medium">
                          {c.name}
                        </span>
                        <span className="text-ui-fg-subtle text-xs">
                          {c.set}
                        </span>
                      </div>
                    </div>
                  </Table.Cell>
                  <Table.Cell className="text-ui-fg-subtle">
                    {gradeLabel(c) || '—'}
                  </Table.Cell>
                  <Table.Cell className="text-ui-fg-subtle text-right tabular-nums">
                    {rm(c.priceBreakdown.marketMyr)}
                  </Table.Cell>
                  <Table.Cell className="text-right tabular-nums">
                    {rm(c.price ?? c.priceBreakdown.displayPrice)}
                    {c.price === null && (
                      <span className="text-ui-fg-muted ml-1 text-xs">FMV</span>
                    )}
                  </Table.Cell>
                  <Table.Cell className="text-ui-fg-subtle whitespace-nowrap text-right text-xs">
                    {timeAgo(c.created_at)}
                  </Table.Cell>
                  <Table.Cell>
                    <StatusBadge color={c.for_sale ? 'green' : 'grey'}>
                      {c.for_sale
                        ? t('cards.list.listed')
                        : t('cards.list.hidden')}
                    </StatusBadge>
                  </Table.Cell>
                  <Table.Cell className="text-right">
                    <div className="flex justify-end gap-2">
                      <Button
                        size="small"
                        variant="secondary"
                        onClick={() => setForm(formFromCard(c))}
                      >
                        {t('cards.list.edit')}
                      </Button>
                      <Button
                        size="small"
                        variant="transparent"
                        onClick={() => setDeleteTarget(c)}
                      >
                        {t('cards.list.delete')}
                      </Button>
                    </div>
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </div>
      )}

      <RegisterCardModal
        open={registerOpen}
        onClose={() => setRegisterOpen(false)}
      />

      {/* Pack picker for the bulk action — pick the destination, land in that
          pack's win-rate editor with the cards staged. */}
      <FocusModal
        open={pickerOpen}
        onOpenChange={(open) => {
          if (!open) setPickerOpen(false);
        }}
      >
        <FocusModal.Content>
          <FocusModal.Header>
            <div className="flex items-center justify-end gap-x-2">
              <Button
                size="small"
                variant="secondary"
                onClick={() => setPickerOpen(false)}
              >
                {t('cards.form.cancel')}
              </Button>
            </div>
          </FocusModal.Header>
          <FocusModal.Body className="flex flex-col items-center overflow-auto p-10">
            <div className="flex w-full max-w-[640px] flex-col gap-y-4">
              <div>
                <FocusModal.Title asChild>
                  <Heading level="h2">{t('cards.bulk.addToPack')}</Heading>
                </FocusModal.Title>
                <FocusModal.Description asChild>
                  <Text className="text-ui-fg-subtle mt-1" size="small">
                    {t('cards.bulk.pickSubtitle', { count: selected.size })}
                  </Text>
                </FocusModal.Description>
              </div>
              {packsError ? (
                <div className="flex flex-col items-start gap-y-3">
                  <Text className="text-ui-fg-subtle">
                    {t('cards.bulk.packsError')}
                  </Text>
                  <Button
                    size="small"
                    variant="secondary"
                    onClick={() => refetchPacks()}
                  >
                    Retry
                  </Button>
                </div>
              ) : packs === null ? (
                <LoadingSkeleton />
              ) : packs.length === 0 ? (
                <Text className="text-ui-fg-subtle">
                  {t('cards.bulk.noPacks')}
                </Text>
              ) : (
                <div className="divide-y rounded-lg border">
                  {packs.map((p) => (
                    <button
                      key={p.slug}
                      type="button"
                      className="hover:bg-ui-bg-base-hover flex w-full items-center gap-3 px-4 py-3 text-left"
                      onClick={() => addToPack(p.slug)}
                    >
                      <div className="flex flex-1 flex-col">
                        <span className="truncate text-sm font-medium">
                          {p.title}
                        </span>
                        <span className="text-ui-fg-subtle text-xs">
                          {p.category}
                        </span>
                      </div>
                      <StatusBadge
                        color={p.status === 'active' ? 'green' : 'grey'}
                      >
                        {p.status}
                      </StatusBadge>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </FocusModal.Body>
        </FocusModal.Content>
      </FocusModal>

      <FocusModal
        open={form !== null}
        onOpenChange={(open) => {
          if (!open) setForm(null);
        }}
      >
        <FocusModal.Content>
          <FocusModal.Header>
            <div className="flex items-center justify-end gap-x-2">
              <Button
                size="small"
                variant="secondary"
                onClick={() => setForm(null)}
              >
                {t('cards.form.cancel')}
              </Button>
              <Button
                size="small"
                onClick={save}
                isLoading={saving}
                disabled={!canSave}
              >
                {t('cards.form.save')}
              </Button>
            </div>
          </FocusModal.Header>
          <FocusModal.Body className="flex flex-col items-center overflow-auto p-10">
            {form && (
              <div className="flex w-full max-w-[640px] flex-col gap-y-6">
                <div>
                  <FocusModal.Title asChild>
                    <Heading level="h2">{t('cards.form.editTitle')}</Heading>
                  </FocusModal.Title>
                  <FocusModal.Description asChild>
                    <Text className="text-ui-fg-subtle mt-1" size="small">
                      {t('cards.form.subtitle')}
                    </Text>
                  </FocusModal.Description>
                </div>

                {/* Image */}
                <div className="flex flex-col gap-y-2">
                  <Label size="small" weight="plus" htmlFor="card-image-url">
                    {t('cards.form.image')}
                  </Label>
                  <div className="flex items-center gap-4">
                    {form.slab_image || form.image ? (
                      <img
                        src={resolveImageUrl(form.slab_image || form.image)}
                        alt=""
                        className="border-ui-border-base h-28 w-20 shrink-0 rounded border object-contain"
                      />
                    ) : (
                      <div className="border-ui-border-base bg-ui-bg-subtle text-ui-fg-muted flex h-28 w-20 shrink-0 items-center justify-center rounded border text-xs">
                        —
                      </div>
                    )}
                    <div className="flex flex-1 flex-col gap-y-2">
                      <input
                        ref={fileRef}
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={handleFile}
                      />
                      <Button
                        size="small"
                        variant="secondary"
                        type="button"
                        onClick={() => fileRef.current?.click()}
                        isLoading={uploading}
                      >
                        {t('cards.form.uploadImage')}
                      </Button>
                      <Input
                        id="card-image-url"
                        placeholder={t('cards.form.imageUrlPlaceholder')}
                        value={form.image}
                        onChange={(e) => patch({ image: e.target.value })}
                      />
                      <Text className="text-ui-fg-subtle text-xs">
                        {t('cards.form.uploadHint')}
                      </Text>
                    </div>
                  </div>
                </div>

                {/* Handle (immutable key) */}
                <div className="flex flex-col gap-y-2">
                  <Label size="small" weight="plus" htmlFor="card-handle">
                    {t('cards.form.handle')}
                  </Label>
                  <Input id="card-handle" value={form.handle} disabled />
                </div>

                <div className="flex flex-col gap-y-2">
                  <Label size="small" weight="plus" htmlFor="card-name">
                    {t('cards.form.name')}
                  </Label>
                  <Input
                    id="card-name"
                    value={form.name}
                    onChange={(e) => patch({ name: e.target.value })}
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="flex flex-col gap-y-2">
                    <Label size="small" weight="plus" htmlFor="card-set">
                      {t('cards.form.set')}
                    </Label>
                    <Input
                      id="card-set"
                      value={form.set}
                      onChange={(e) => patch({ set: e.target.value })}
                    />
                  </div>
                  <div className="col-span-2">
                    <GraderGradeSelect
                      grader={form.grader}
                      grade={form.grade}
                      onChange={(v) => patch(v)}
                      idPrefix="edit"
                    />
                  </div>
                  <div className="flex flex-col gap-y-2">
                    <Label size="small" weight="plus" htmlFor="card-label-year">
                      {t('cards.form.labelYear')}
                    </Label>
                    <Input
                      id="card-label-year"
                      value={form.label_year}
                      onChange={(e) => patch({ label_year: e.target.value })}
                    />
                  </div>
                  <div className="flex flex-col gap-y-2">
                    <Label size="small" weight="plus" htmlFor="card-label-note">
                      {t('cards.form.labelNote')}
                    </Label>
                    <Input
                      id="card-label-note"
                      value={form.label_note}
                      onChange={(e) => patch({ label_note: e.target.value })}
                    />
                  </div>
                  <Text className="text-ui-fg-subtle col-span-2 text-xs">
                    {t('cards.form.labelHint')}
                  </Text>
                  <div className="flex flex-col gap-y-2">
                    <Label size="small" weight="plus" htmlFor="card-fmv">
                      {t('cards.form.marketValue')}
                    </Label>
                    <Input
                      id="card-fmv"
                      type="number"
                      min={0}
                      step={0.01}
                      value={form.market_value}
                      onChange={(e) => patch({ market_value: e.target.value })}
                    />
                  </div>
                  <div className="flex flex-col gap-y-2">
                    <Label size="small" weight="plus" htmlFor="card-price">
                      {t('cards.form.price')}
                    </Label>
                    <Input
                      id="card-price"
                      type="number"
                      min={0}
                      step={0.01}
                      placeholder={t('cards.form.pricePlaceholder')}
                      value={form.price}
                      onChange={(e) => patch({ price: e.target.value })}
                    />
                  </div>
                </div>

                <div className="bg-ui-bg-subtle flex items-center justify-between rounded-lg px-4 py-3">
                  <div className="flex flex-col">
                    <Label size="small" weight="plus" htmlFor="card-for-sale">
                      {t('cards.form.forSale')}
                    </Label>
                    <Text className="text-ui-fg-subtle text-xs">
                      {t('cards.form.forSaleHint')}
                    </Text>
                  </div>
                  <Switch
                    id="card-for-sale"
                    checked={form.for_sale}
                    onCheckedChange={(v) => patch({ for_sale: v })}
                  />
                </div>

                {form.pc_product_id && (
                  <div className="bg-ui-bg-subtle flex flex-col gap-y-3 rounded-lg p-4">
                    <div className="flex items-center justify-between gap-4">
                      <Text
                        size="small"
                        weight="plus"
                        className="flex items-center gap-x-1.5"
                      >
                        <Link className="shrink-0" aria-hidden />
                        {t('cards.form.linked', {
                          synced: form.pc_synced_at
                            ? timeAgo(form.pc_synced_at)
                            : t('cards.form.neverSynced'),
                        })}
                      </Text>
                      <Button
                        size="small"
                        variant="danger"
                        type="button"
                        onClick={unlink}
                        isLoading={saving}
                        disabled={saving}
                      >
                        {t('cards.form.unlink')}
                      </Button>
                    </div>
                    <div className="flex flex-col gap-y-2">
                      <Label size="small" weight="plus" htmlFor="card-markup">
                        {t('cards.form.markup')}
                      </Label>
                      <Input
                        id="card-markup"
                        type="number"
                        min={0}
                        max={1000}
                        step={1}
                        value={form.market_multiplier_pct}
                        onChange={(e) =>
                          patch({ market_multiplier_pct: e.target.value })
                        }
                      />
                      <Text className="text-ui-fg-subtle text-xs">
                        {t('cards.form.markupHint')}
                      </Text>
                    </div>
                  </div>
                )}

                <CardPokemonFields
                  value={{ pixel_pokemon_id: form.pixel_pokemon_id }}
                  onChange={(p) => patch(p)}
                  currentSprite={form.sprite_image}
                  currentDex={form.pokemon_dex}
                  suggestionName={form.name}
                />
              </div>
            )}
          </FocusModal.Body>
        </FocusModal.Content>
      </FocusModal>

      <Prompt
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <Prompt.Content>
          <Prompt.Header>
            <Prompt.Title>{t('cards.delete.title')}</Prompt.Title>
            <Prompt.Description>
              {t('cards.delete.description', {
                name: deleteTarget?.name ?? '',
              })}
            </Prompt.Description>
          </Prompt.Header>
          <Prompt.Footer>
            <Prompt.Cancel>{t('cards.form.cancel')}</Prompt.Cancel>
            <Prompt.Action onClick={confirmDelete}>
              {t('cards.delete.confirm')}
            </Prompt.Action>
          </Prompt.Footer>
        </Prompt.Content>
      </Prompt>
    </Container>
  );
};

export default GachaCardsPage;
