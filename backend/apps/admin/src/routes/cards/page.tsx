import { useRef, useState, type ChangeEvent } from 'react';
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
  StatusBadge,
  FocusModal,
  Prompt,
  toast,
} from '@medusajs/ui';
import { Sparkles } from '@medusajs/icons';
import type { RouteConfig } from '@mercurjs/dashboard-sdk';
import { type AdminCard, type AdminCardUpdate } from '../../lib/packs-api';
import {
  useCards,
  useDeleteCard,
  useUpdateCard,
  useUploadImage,
} from '../../lib/queries';
import { resolveImageUrl } from '../../lib/image-url';
import { validateImageFile } from '../../lib/image-validation';
import { rm, timeAgo, myrToUsd } from '../../lib/format';
import RegisterCardModal from './RegisterCardModal';
import CardPokemonFields from './CardPokemonFields';
import { GachaPipelineHint } from '../../components/GachaPipelineHint';

export const config: RouteConfig = {
  label: 'Gacha Cards',
  icon: Sparkles,
  nested: '/gacha',
  rank: 1,
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
  market_value: string;
  image: string;
  price: string;
  for_sale: boolean;
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
  // FMV shown/edited in MYR (priceBreakdown.marketMyr = market_value × live FX,
  // no markup); converted back to USD on save.
  market_value: String(c.priceBreakdown.marketMyr),
  image: c.image,
  // null price = "use FMV" → empty field (preserved on save as undefined).
  price: c.price === null ? '' : String(c.price),
  for_sale: c.for_sale,
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

const GachaCardsPage = () => {
  const { t } = useTranslation();
  const { data: cards = null, isError } = useCards();
  const updateCard = useUpdateCard();
  const removeCard = useDeleteCard();
  const uploadImg = useUploadImage();
  const [registerOpen, setRegisterOpen] = useState(false);
  const [form, setForm] = useState<FormState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AdminCard | null>(null);
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<{
    key: 'name' | 'value' | 'stock';
    dir: 1 | -1;
  } | null>(null);
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
    form.image.trim() !== '' &&
    form.market_value.trim() !== '' &&
    Number(form.market_value) >= 0 &&
    !saving &&
    !uploading;

  const save = async () => {
    if (!form || !canSave) return;
    const payload: AdminCardUpdate = {
      name: form.name.trim(),
      set: form.set.trim(),
      grader: form.grader.trim(),
      grade: form.grade.trim(),
      // Edited in MYR; the backend tracks FMV in USD — convert back at the
      // card's live rate so the stored value stays PriceCharting-native.
      market_value: myrToUsd(Number(form.market_value), form.fx_rate),
      image: form.image.trim(),
      price: form.price.trim() === '' ? undefined : Number(form.price),
      for_sale: form.for_sale,
      pokemon_dex: form.pokemon_dex,
      sprite_image: form.sprite_image,
      // pc_product_id stays untouched (undefined) unless the operator hits
      // Unlink, which submits null explicitly and closes the form immediately.
      pc_product_id: undefined,
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
        pokemon_dex: card.pokemon_dex,
        sprite_image: card.sprite_image,
        pc_product_id: null,
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
            : (c.stock ?? Number.POSITIVE_INFINITY);
      const va = pick(a);
      const vb = pick(b);
      return va < vb ? -sort.dir : va > vb ? sort.dir : 0;
    });

  const sortHeader = (key: 'name' | 'value' | 'stock', label: string) => (
    <button
      type="button"
      className="inline-flex items-center gap-1 hover:text-ui-fg-base"
      onClick={() =>
        setSort((s) =>
          s?.key === key
            ? { key, dir: s.dir === 1 ? -1 : 1 }
            : { key, dir: 1 },
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
          value={q}
          onChange={(e) => setQ(e.target.value)}
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

      {isError ? (
        <div className="px-6 py-8">
          <Text className="text-ui-fg-subtle">{t('cards.list.loadError')}</Text>
        </div>
      ) : cards === null ? (
        <div className="px-6 py-8">
          <Text className="text-ui-fg-subtle">…</Text>
        </div>
      ) : cards.length === 0 ? (
        <div className="px-6 py-8">
          <Text className="text-ui-fg-subtle">{t('cards.list.empty')}</Text>
        </div>
      ) : (
        <Table>
          <Table.Header>
            <Table.Row>
              <Table.HeaderCell>
                {sortHeader('name', t('cards.list.card'))}
              </Table.HeaderCell>
              <Table.HeaderCell>{t('cards.list.grade')}</Table.HeaderCell>
              <Table.HeaderCell className="text-right">
                {sortHeader('value', t('cards.list.value'))}
              </Table.HeaderCell>
              <Table.HeaderCell className="text-right">
                {t('cards.list.price')}
              </Table.HeaderCell>
              <Table.HeaderCell className="text-right">
                {sortHeader('stock', t('cards.list.stock'))}
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
                <Table.Cell>
                  <div className="flex items-center gap-3">
                    <img
                      src={resolveImageUrl(c.image)}
                      alt=""
                      className="h-10 w-8 shrink-0 rounded object-contain"
                    />
                    <div className="flex flex-col">
                      <span className="max-w-[22rem] truncate font-medium">
                        {c.name}
                      </span>
                      <span className="text-ui-fg-subtle text-xs">{c.set}</span>
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
                <Table.Cell
                  title="Negative = units owed to winners; 0 = buyback-only; ∞ = untracked"
                  className={
                    // Negative = units OWED to winners (wins keep counting
                    // below 0 by design) — red beats orange for "act now".
                    c.stock !== null && c.stock < 0
                      ? 'text-ui-tag-red-text text-right font-medium tabular-nums'
                      : c.stock === 0
                        ? 'text-ui-tag-orange-text text-right tabular-nums'
                        : 'text-ui-fg-subtle text-right tabular-nums'
                  }
                >
                  {c.stock === null ? '∞' : c.stock.toLocaleString('en-US')}
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
      )}

      <RegisterCardModal
        open={registerOpen}
        onClose={() => setRegisterOpen(false)}
      />

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
                  <Label size="small" weight="plus">
                    {t('cards.form.image')}
                  </Label>
                  <div className="flex items-center gap-4">
                    {form.image ? (
                      <img
                        src={resolveImageUrl(form.image)}
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
                  <Label size="small" weight="plus">
                    {t('cards.form.handle')}
                  </Label>
                  <Input value={form.handle} disabled />
                </div>

                <div className="flex flex-col gap-y-2">
                  <Label size="small" weight="plus">
                    {t('cards.form.name')}
                  </Label>
                  <Input
                    value={form.name}
                    onChange={(e) => patch({ name: e.target.value })}
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="flex flex-col gap-y-2">
                    <Label size="small" weight="plus">
                      {t('cards.form.set')}
                    </Label>
                    <Input
                      value={form.set}
                      onChange={(e) => patch({ set: e.target.value })}
                    />
                  </div>
                  <div className="flex flex-col gap-y-2">
                    <Label size="small" weight="plus">
                      {t('cards.form.grader')}
                    </Label>
                    <Input
                      value={form.grader}
                      onChange={(e) => patch({ grader: e.target.value })}
                    />
                  </div>
                  <div className="flex flex-col gap-y-2">
                    <Label size="small" weight="plus">
                      {t('cards.form.grade')}
                    </Label>
                    <Input
                      value={form.grade}
                      onChange={(e) => patch({ grade: e.target.value })}
                    />
                  </div>
                  <div className="flex flex-col gap-y-2">
                    <Label size="small" weight="plus">
                      {t('cards.form.marketValue')}
                    </Label>
                    <Input
                      type="number"
                      min={0}
                      step={0.01}
                      value={form.market_value}
                      onChange={(e) => patch({ market_value: e.target.value })}
                    />
                  </div>
                  <div className="flex flex-col gap-y-2">
                    <Label size="small" weight="plus">
                      {t('cards.form.price')}
                    </Label>
                    <Input
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
                    <Label size="small" weight="plus">
                      {t('cards.form.forSale')}
                    </Label>
                    <Text className="text-ui-fg-subtle text-xs">
                      {t('cards.form.forSaleHint')}
                    </Text>
                  </div>
                  <Switch
                    checked={form.for_sale}
                    onCheckedChange={(v) => patch({ for_sale: v })}
                  />
                </div>

                {form.pc_product_id && (
                  <div className="bg-ui-bg-subtle flex flex-col gap-y-3 rounded-lg p-4">
                    <div className="flex items-center justify-between gap-4">
                      <Text size="small" weight="plus">
                        🔗{' '}
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
                      <Label size="small" weight="plus">
                        {t('cards.form.markup')}
                      </Label>
                      <Input
                        type="number"
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
                  value={{
                    pokemon_dex: form.pokemon_dex,
                    sprite_image: form.sprite_image,
                  }}
                  onChange={(p) => patch(p)}
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
