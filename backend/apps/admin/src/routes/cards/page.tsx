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
import RegisterCardModal from './RegisterCardModal';

export const config: RouteConfig = {
  label: 'Gacha Cards',
  icon: Sparkles,
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
};

const formFromCard = (c: AdminCard): FormState => ({
  handle: c.handle,
  name: c.name,
  set: c.set,
  grader: c.grader,
  grade: c.grade,
  market_value: String(c.market_value),
  image: c.image,
  // null price = "use FMV" → empty field (preserved on save as undefined).
  price: c.price === null ? '' : String(c.price),
  for_sale: c.for_sale,
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
      market_value: Number(form.market_value),
      image: form.image.trim(),
      price: form.price.trim() === '' ? undefined : Number(form.price),
      for_sale: form.for_sale,
    };
    try {
      await updateCard.mutateAsync({ handle: form.handle, ...payload });
      toast.success(t('cards.toast.updated'));
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

  return (
    <Container className="divide-y p-0">
      <div className="flex items-start justify-between gap-4 px-6 py-4">
        <div>
          <Heading level="h2">{t('cards.title')}</Heading>
          <Text className="text-ui-fg-subtle mt-1" size="small">
            {t('cards.subtitle')}
          </Text>
        </div>
        <Button
          size="small"
          variant="primary"
          onClick={() => setRegisterOpen(true)}
        >
          {t('cards.new')}
        </Button>
      </div>

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
              <Table.HeaderCell>{t('cards.list.card')}</Table.HeaderCell>
              <Table.HeaderCell>{t('cards.list.grade')}</Table.HeaderCell>
              <Table.HeaderCell className="text-right">
                {t('cards.list.value')}
              </Table.HeaderCell>
              <Table.HeaderCell className="text-right">
                {t('cards.list.price')}
              </Table.HeaderCell>
              <Table.HeaderCell className="text-right">
                {t('cards.list.stock')}
              </Table.HeaderCell>
              <Table.HeaderCell>{t('cards.list.status')}</Table.HeaderCell>
              <Table.HeaderCell className="text-right">
                {t('cards.list.actions')}
              </Table.HeaderCell>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {cards.map((c) => (
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
                  $
                  {c.market_value.toLocaleString('en-US', {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}
                </Table.Cell>
                <Table.Cell className="text-right tabular-nums">
                  $
                  {(c.price ?? c.market_value).toLocaleString('en-US', {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}
                  {c.price === null && (
                    <span className="text-ui-fg-muted ml-1 text-xs">FMV</span>
                  )}
                </Table.Cell>
                <Table.Cell
                  className={
                    c.stock === 0
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
