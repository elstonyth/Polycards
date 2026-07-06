import { useMemo, useRef, useState, type ChangeEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Container,
  Heading,
  Text,
  Table,
  Button,
  IconButton,
  Switch,
  Input,
  Select,
  Label,
  StatusBadge,
  FocusModal,
  Prompt,
  toast,
} from '@medusajs/ui';
import { ArrowDownMini, ArrowUpMini, Gift } from '@medusajs/icons';
import type { RouteConfig } from '@mercurjs/dashboard-sdk';
import { type AdminPack, type AdminPackWrite } from '../../lib/packs-api';
import {
  useCreatePack,
  useDeletePack,
  usePacks,
  useUpdatePack,
  useUploadImage,
} from '../../lib/queries';
import { resolveImageUrl } from '../../lib/image-url';
import { validateImageFile } from '../../lib/image-validation';
import { rm } from '../../lib/format';
import { GachaPipelineHint } from '../../components/GachaPipelineHint';

// Sidebar entry. The label is literal (internal single-operator tool); switch to
// RouteConfig.translationNs if this dashboard is ever localized.
export const config: RouteConfig = {
  label: 'Gacha Packs',
  icon: Gift,
  nested: '/gacha',
  rank: 2,
};

// Known pack categories — the storefront maps these to labels + icons, so the
// editor offers them as a closed set (a new category would also need front-end art).
const CATEGORIES = [
  'pokemon',
  'one-piece',
  'basketball',
  'baseball',
  'football',
  'soccer',
  'yugioh',
  'riftbound',
] as const;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

type FormState = {
  slug: string;
  title: string;
  category: string;
  price: string;
  image: string;
  buybackPercent: string;
  boost: boolean;
  rank: string;
  status: 'active' | 'draft';
};

const EMPTY_FORM: FormState = {
  slug: '',
  title: '',
  category: 'pokemon',
  price: '',
  image: '',
  buybackPercent: '90',
  boost: false,
  rank: '0',
  // New packs start as draft: a pack has an empty prize pool until cards are
  // added, and an empty active pack would surface on /claw yet fail to open.
  // Add members, then flip to active.
  status: 'draft',
};

const formFromPack = (p: AdminPack): FormState => ({
  slug: p.slug,
  title: p.title,
  category: p.category,
  price: String(p.price),
  image: p.image,
  buybackPercent: String(p.buyback_percent),
  boost: p.boost,
  rank: String(p.rank),
  status: p.status,
});

const PacksListPage = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data: packs = null, isError } = usePacks();
  const createPack = useCreatePack();
  const updatePack = useUpdatePack();
  const removePack = useDeletePack();
  const uploadImg = useUploadImage();
  const [mode, setMode] = useState<'create' | 'edit' | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [deleteTarget, setDeleteTarget] = useState<AdminPack | null>(null);
  const [q, setQ] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'draft' | 'active'>(
    'all',
  );
  const filtering = q.trim() !== '' || statusFilter !== 'all';
  const fileRef = useRef<HTMLInputElement>(null);
  const uploading = uploadImg.isPending;
  const saving = createPack.isPending || updatePack.isPending;

  const patch = (p: Partial<FormState>) => setForm((f) => ({ ...f, ...p }));

  const openCreate = () => {
    setForm(EMPTY_FORM);
    setMode('create');
  };
  const openEdit = (pack: AdminPack) => {
    setForm(formFromPack(pack));
    setMode('edit');
  };

  const handleFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // Client-side gate: instant reject before the upload round-trip. The
    // server re-validates (and is authoritative).
    const problem = await validateImageFile(file, 'pack');
    if (problem) {
      toast.error(problem);
      if (fileRef.current) fileRef.current.value = '';
      return;
    }
    try {
      const url = await uploadImg.mutateAsync({ file, kind: 'pack' });
      patch({ image: url });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const handleOk =
    form.title.trim() !== '' &&
    form.image.trim() !== '' &&
    form.price.trim() !== '' &&
    Number(form.price) >= 0 &&
    form.buybackPercent.trim() !== '' &&
    Number(form.buybackPercent) >= 90 &&
    Number(form.buybackPercent) <= 100 &&
    (form.rank.trim() === '' || !Number.isNaN(Number(form.rank))) &&
    (mode === 'edit' || SLUG_RE.test(form.slug.trim()));
  const canSave = handleOk && !saving && !uploading;

  const save = async () => {
    if (!canSave) return;
    const payload: AdminPackWrite = {
      title: form.title.trim(),
      category: form.category,
      price: Number(form.price),
      image: form.image.trim(),
      buyback_percent: Math.trunc(Number(form.buybackPercent)),
      boost: form.boost,
      rank: form.rank.trim() === '' ? 0 : Math.trunc(Number(form.rank)),
      status: form.status,
    };
    try {
      if (mode === 'create') {
        await createPack.mutateAsync({ ...payload, slug: form.slug.trim() });
        toast.success(t('packs.toast.created'));
      } else {
        await updatePack.mutateAsync({ slug: form.slug, ...payload });
        toast.success(t('packs.toast.updated'));
      }
      setMode(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const slug = deleteTarget.slug;
    setDeleteTarget(null);
    try {
      await removePack.mutateAsync(slug);
      toast.success(t('packs.toast.deleted'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  // Category groups in display order (the API list is already (category, rank)
  // sorted; re-sort defensively so the arrows always match what is rendered —
  // rank ties broken by slug, same as nothing guarantees in the DB).
  const grouped = useMemo(() => {
    const m = new Map<string, AdminPack[]>();
    for (const p of packs ?? []) {
      const g = m.get(p.category) ?? [];
      g.push(p);
      m.set(p.category, g);
    }
    for (const g of m.values())
      g.sort((a, b) => a.rank - b.rank || a.slug.localeCompare(b.slug));
    return m;
  }, [packs]);

  // Render rows in the exact grouped order so the position numbers always
  // match what's on screen, even while duplicate ranks are still unnormalized.
  const rows = useMemo(() => [...grouped.values()].flat(), [grouped]);

  const visibleRows = rows.filter((p) => {
    if (statusFilter !== 'all' && p.status !== statusFilter) return false;
    const needle = q.trim().toLowerCase();
    return !needle || p.title.toLowerCase().includes(needle);
  });

  // Move a pack one position up/down within its category and persist rank =
  // position for every row that changed — this also normalizes duplicate
  // ranks (e.g. several rank-0 packs) the first time a group is reordered.
  const movePack = async (p: AdminPack, dir: -1 | 1) => {
    const group = grouped.get(p.category) ?? [];
    const i = group.findIndex((x) => x.slug === p.slug);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= group.length) return;
    const next = [...group];
    [next[i], next[j]] = [next[j], next[i]];
    const writes = next
      .map((pack, rank) => ({ pack, rank }))
      .filter(({ pack, rank }) => pack.rank !== rank);
    try {
      await Promise.all(
        writes.map(({ pack, rank }) => updatePack.mutateAsync({ ...pack, rank })),
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Container className="divide-y p-0">
      <div className="flex items-start justify-between gap-4 px-6 py-4">
        <div>
          <Heading level="h2">{t('packs.title')}</Heading>
          <Text className="text-ui-fg-subtle mt-1" size="small">
            {t('packs.subtitle')}
          </Text>
        </div>
        <Input
          className="w-56"
          placeholder="Search title…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <Select
          value={statusFilter}
          onValueChange={(v) =>
            setStatusFilter(v === 'draft' || v === 'active' ? v : 'all')
          }
        >
          <Select.Trigger className="w-44">
            <Select.Value />
          </Select.Trigger>
          <Select.Content>
            <Select.Item value="all">All statuses</Select.Item>
            <Select.Item value="draft">draft</Select.Item>
            <Select.Item value="active">active</Select.Item>
          </Select.Content>
        </Select>
        <Button size="small" variant="primary" onClick={openCreate}>
          {t('packs.new')}
        </Button>
      </div>

      <GachaPipelineHint current="pack" />

      {packs !== null && (
        <Text size="small" className="text-ui-fg-subtle px-6 pb-2">
          {filtering
            ? `${visibleRows.length} of ${rows.length} packs`
            : `${rows.length} packs`}
        </Text>
      )}

      {isError ? (
        <div className="px-6 py-8">
          <Text className="text-ui-fg-subtle">{t('packs.list.loadError')}</Text>
        </div>
      ) : packs === null ? (
        <div className="px-6 py-8">
          <Text className="text-ui-fg-subtle">…</Text>
        </div>
      ) : packs.length === 0 ? (
        <div className="px-6 py-8">
          <Text className="text-ui-fg-subtle">{t('packs.list.empty')}</Text>
        </div>
      ) : (
        <Table>
          <Table.Header>
            <Table.Row>
              <Table.HeaderCell>{t('packs.list.order')}</Table.HeaderCell>
              <Table.HeaderCell>{t('packs.list.pack')}</Table.HeaderCell>
              <Table.HeaderCell>{t('packs.list.category')}</Table.HeaderCell>
              <Table.HeaderCell>{t('packs.list.status')}</Table.HeaderCell>
              <Table.HeaderCell>Odds</Table.HeaderCell>
              <Table.HeaderCell>{t('packs.list.price')}</Table.HeaderCell>
              <Table.HeaderCell className="text-right">
                {t('packs.list.actions')}
              </Table.HeaderCell>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {visibleRows.map((p) => {
              const group = grouped.get(p.category) ?? [];
              const pos = group.findIndex((x) => x.slug === p.slug);
              return (
              <Table.Row
                key={p.slug}
                className="cursor-pointer"
                onClick={() => navigate(`/packs/${p.slug}`)}
              >
                <Table.Cell>
                  <div className="flex items-center gap-1">
                    <span className="text-ui-fg-subtle w-6 tabular-nums">
                      {pos + 1}
                    </span>
                    <IconButton
                      size="small"
                      variant="transparent"
                      aria-label={t('packs.list.moveUp')}
                      disabled={filtering || pos <= 0 || updatePack.isPending}
                      onClick={(e) => {
                        e.stopPropagation();
                        void movePack(p, -1);
                      }}
                    >
                      <ArrowUpMini />
                    </IconButton>
                    <IconButton
                      size="small"
                      variant="transparent"
                      aria-label={t('packs.list.moveDown')}
                      disabled={
                        filtering ||
                        pos >= group.length - 1 ||
                        updatePack.isPending
                      }
                      onClick={(e) => {
                        e.stopPropagation();
                        void movePack(p, 1);
                      }}
                    >
                      <ArrowDownMini />
                    </IconButton>
                  </div>
                </Table.Cell>
                <Table.Cell className="font-medium">{p.title}</Table.Cell>
                <Table.Cell className="text-ui-fg-subtle">
                  {p.category}
                </Table.Cell>
                <Table.Cell>
                  <StatusBadge color={p.status === 'active' ? 'green' : 'grey'}>
                    {p.status}
                  </StatusBadge>
                </Table.Cell>
                <Table.Cell>
                  <StatusBadge color={p.published_odds ? 'green' : 'orange'}>
                    {p.published_odds ? 'Published' : 'Not set'}
                  </StatusBadge>
                </Table.Cell>
                <Table.Cell className="tabular-nums">{rm(p.price)}</Table.Cell>
                <Table.Cell className="text-right">
                  <div className="flex justify-end gap-2">
                    <Button
                      size="small"
                      variant="secondary"
                      onClick={(e) => {
                        e.stopPropagation();
                        navigate(`/packs/${p.slug}`);
                      }}
                    >
                      {t('packs.list.winRates')}
                    </Button>
                    <Button
                      size="small"
                      variant="secondary"
                      onClick={(e) => {
                        e.stopPropagation();
                        openEdit(p);
                      }}
                    >
                      {t('packs.list.edit')}
                    </Button>
                    <Button
                      size="small"
                      variant="transparent"
                      onClick={(e) => {
                        e.stopPropagation();
                        setDeleteTarget(p);
                      }}
                    >
                      {t('packs.list.delete')}
                    </Button>
                  </div>
                </Table.Cell>
              </Table.Row>
              );
            })}
          </Table.Body>
        </Table>
      )}

      <FocusModal
        open={mode !== null}
        onOpenChange={(open) => {
          if (!open) setMode(null);
        }}
      >
        <FocusModal.Content>
          <FocusModal.Header>
            <div className="flex items-center justify-end gap-x-2">
              <Button
                size="small"
                variant="secondary"
                onClick={() => setMode(null)}
              >
                {t('packs.form.cancel')}
              </Button>
              <Button
                size="small"
                onClick={save}
                isLoading={saving}
                disabled={!canSave}
              >
                {t('packs.form.save')}
              </Button>
            </div>
          </FocusModal.Header>
          <FocusModal.Body className="flex flex-col items-center overflow-auto p-10">
            <div className="flex w-full max-w-[640px] flex-col gap-y-6">
              <div>
                <FocusModal.Title asChild>
                  <Heading level="h2">
                    {mode === 'create'
                      ? t('packs.form.createTitle')
                      : t('packs.form.editTitle')}
                  </Heading>
                </FocusModal.Title>
                <FocusModal.Description asChild>
                  <Text className="text-ui-fg-subtle mt-1" size="small">
                    {t('packs.form.subtitle')}
                  </Text>
                </FocusModal.Description>
              </div>

              {/* Image */}
              <div className="flex flex-col gap-y-2">
                <Label size="small" weight="plus">
                  {t('packs.form.image')}
                </Label>
                <div className="flex items-center gap-4">
                  {form.image ? (
                    <img
                      src={resolveImageUrl(form.image)}
                      alt=""
                      className="border-ui-border-base h-24 w-24 shrink-0 rounded border object-contain"
                    />
                  ) : (
                    <div className="border-ui-border-base bg-ui-bg-subtle text-ui-fg-muted flex h-24 w-24 shrink-0 items-center justify-center rounded border text-xs">
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
                      {t('packs.form.uploadImage')}
                    </Button>
                    <Input
                      placeholder={t('packs.form.imageUrlPlaceholder')}
                      value={form.image}
                      onChange={(e) => patch({ image: e.target.value })}
                    />
                  </div>
                </div>
              </div>

              {/* Slug (create only — immutable key) */}
              <div className="flex flex-col gap-y-2">
                <Label size="small" weight="plus">
                  {t('packs.form.slug')}
                </Label>
                {mode === 'create' ? (
                  <>
                    <Input
                      placeholder="legend-pack"
                      value={form.slug}
                      onChange={(e) =>
                        patch({ slug: e.target.value.toLowerCase() })
                      }
                    />
                    <Text className="text-ui-fg-subtle text-xs">
                      {t('packs.form.slugHint')}
                    </Text>
                  </>
                ) : (
                  <Input value={form.slug} disabled />
                )}
              </div>

              <div className="flex flex-col gap-y-2">
                <Label size="small" weight="plus">
                  {t('packs.form.titleField')}
                </Label>
                <Input
                  value={form.title}
                  onChange={(e) => patch({ title: e.target.value })}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="flex flex-col gap-y-2">
                  <Label size="small" weight="plus">
                    {t('packs.form.category')}
                  </Label>
                  <Select
                    value={form.category}
                    onValueChange={(v) => patch({ category: v })}
                  >
                    <Select.Trigger>
                      <Select.Value />
                    </Select.Trigger>
                    <Select.Content>
                      {CATEGORIES.map((c) => (
                        <Select.Item key={c} value={c}>
                          {c}
                        </Select.Item>
                      ))}
                    </Select.Content>
                  </Select>
                </div>
                <div className="flex flex-col gap-y-2">
                  <Label size="small" weight="plus">
                    {t('packs.form.statusField')}
                  </Label>
                  {/* Create is draft-only (the backend rejects an active
                      creation — the pool is empty by construction); activation
                      lives on the pack page once cards are assigned. */}
                  {mode === 'create' ? (
                    <>
                      <Input value={t('packs.form.draft')} disabled />
                      <Text className="text-ui-fg-subtle text-xs">
                        {t('packs.form.statusCreateHint')}
                      </Text>
                    </>
                  ) : (
                    <Select
                      value={form.status}
                      onValueChange={(v) =>
                        patch({ status: v === 'draft' ? 'draft' : 'active' })
                      }
                    >
                      <Select.Trigger>
                        <Select.Value />
                      </Select.Trigger>
                      <Select.Content>
                        <Select.Item value="active">
                          {t('packs.form.active')}
                        </Select.Item>
                        <Select.Item value="draft">
                          {t('packs.form.draft')}
                        </Select.Item>
                      </Select.Content>
                    </Select>
                  )}
                </div>
                <div className="flex flex-col gap-y-2">
                  <Label size="small" weight="plus">
                    {t('packs.form.price')}
                  </Label>
                  <Input
                    type="number"
                    min={0}
                    step={1}
                    value={form.price}
                    onChange={(e) => patch({ price: e.target.value })}
                  />
                </div>
                <div className="flex flex-col gap-y-2">
                  <Label size="small" weight="plus">
                    {t('packs.form.rank')}
                  </Label>
                  <Input
                    type="number"
                    step={1}
                    value={form.rank}
                    onChange={(e) => patch({ rank: e.target.value })}
                  />
                </div>
                <div className="flex flex-col gap-y-2">
                  <Label size="small" weight="plus">
                    {t('packs.form.buybackPercent')}
                  </Label>
                  <Input
                    type="number"
                    min={90}
                    max={100}
                    step={1}
                    value={form.buybackPercent}
                    onChange={(e) => patch({ buybackPercent: e.target.value })}
                  />
                  <Text className="text-ui-fg-subtle text-xs">
                    {t('packs.form.buybackHint')}
                  </Text>
                </div>
              </div>

              <div className="bg-ui-bg-subtle flex items-center justify-between rounded-lg px-4 py-3">
                <div className="flex flex-col">
                  <Label size="small" weight="plus">
                    {t('packs.form.boost')}
                  </Label>
                  <Text className="text-ui-fg-subtle text-xs">
                    {t('packs.form.boostHint')}
                  </Text>
                </div>
                <Switch
                  checked={form.boost}
                  onCheckedChange={(v) => patch({ boost: v })}
                />
              </div>

              {mode === 'create' && (
                <Text className="text-ui-fg-subtle text-xs">
                  {t('packs.form.poolHint')}
                </Text>
              )}
            </div>
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
            <Prompt.Title>{t('packs.delete.title')}</Prompt.Title>
            <Prompt.Description>
              {t('packs.delete.description', {
                title: deleteTarget?.title ?? '',
              })}
            </Prompt.Description>
          </Prompt.Header>
          <Prompt.Footer>
            <Prompt.Cancel>{t('packs.form.cancel')}</Prompt.Cancel>
            <Prompt.Action onClick={confirmDelete}>
              {t('packs.delete.confirm')}
            </Prompt.Action>
          </Prompt.Footer>
        </Prompt.Content>
      </Prompt>
    </Container>
  );
};

export default PacksListPage;
