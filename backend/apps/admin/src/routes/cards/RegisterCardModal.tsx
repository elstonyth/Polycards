import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Button,
  FocusModal,
  Heading,
  Input,
  Label,
  StatusBadge,
  Text,
  toast,
  clx,
} from '@medusajs/ui';
import {
  searchPriceCharting,
  getPriceChartingProduct,
  type EligibleProduct,
  type PcMatch,
  type PcProduct,
} from '../../lib/admin-rest';
import { useEligibleProducts, useRegisterCard } from '../../lib/queries';
import { resolveImageUrl } from '../../lib/image-url';
import { usd } from '../../lib/format';
import CardPokemonFields from './CardPokemonFields';

// Register an EXISTING inventory product as a gacha card (inventory-first: the
// item is created in the product catalog beforehand; this dialog only adds the
// gacha facts). Market value can be fetched from PriceCharting per grade, or
// typed manually when no API token is configured.
type Props = {
  open: boolean;
  onClose: () => void;
};

type Fields = {
  set: string;
  grader: string;
  grade: string;
  market_value: string; // string so the operator can type freely
  pokemon_dex: number | null;
  sprite_image: string | null;
};

const EMPTY_FIELDS: Fields = {
  set: '',
  grader: '',
  grade: '',
  market_value: '',
  pokemon_dex: null,
  sprite_image: null,
};

const RegisterCardModal = ({ open, onClose }: Props) => {
  const { t } = useTranslation();

  // Product picker — the eligible list is a cached query, refetched on each open.
  const { data: products = null, isError: loadError } =
    useEligibleProducts(open);
  const registerCard = useRegisterCard();
  const [filter, setFilter] = useState('');
  const [productId, setProductId] = useState<string | null>(null);

  // Gacha facts.
  const [fields, setFields] = useState<Fields>(EMPTY_FIELDS);
  const saving = registerCard.isPending;

  // PriceCharting lookup.
  const [pcQuery, setPcQuery] = useState('');
  const [pcSearching, setPcSearching] = useState(false);
  const [pcMatches, setPcMatches] = useState<PcMatch[] | null>(null);
  const [pcProduct, setPcProduct] = useState<PcProduct | null>(null);
  const [pcLoadingId, setPcLoadingId] = useState<string | null>(null);

  // Reset the local form state on the open transition. Done during render (not
  // an effect) per react.dev "you might not need an effect" — the eligible list
  // is owned by useEligibleProducts(open) and refetches on its own.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setFilter('');
      setProductId(null);
      setFields(EMPTY_FIELDS);
      setPcQuery('');
      setPcMatches(null);
      setPcProduct(null);
    }
  }

  const selected = useMemo(
    () => products?.find((p) => p.id === productId) ?? null,
    [products, productId],
  );

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return products ?? [];
    return (products ?? []).filter((p) => p.title.toLowerCase().includes(q));
  }, [products, filter]);

  const pick = (p: EligibleProduct) => {
    setProductId(p.id);
    // Seed the lookup query with the product title — usually the card name.
    setPcQuery(p.title);
    setPcMatches(null);
    setPcProduct(null);
  };

  const patch = (p: Partial<Fields>) => setFields((f) => ({ ...f, ...p }));

  const runPcSearch = async () => {
    const q = pcQuery.trim();
    if (!q || pcSearching) return;
    setPcSearching(true);
    setPcMatches(null);
    setPcProduct(null);
    try {
      setPcMatches(await searchPriceCharting(q));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setPcSearching(false);
    }
  };

  const pickPcMatch = async (m: PcMatch) => {
    if (pcLoadingId) return;
    setPcLoadingId(m.id);
    try {
      const product = await getPriceChartingProduct(m.id);
      setPcProduct(product);
      // The match's "console" is the card's set on PriceCharting — prefill if empty.
      if (!fields.set.trim() && product.set) patch({ set: product.set });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setPcLoadingId(null);
    }
  };

  // Fill FMV from the picked grade; the grade label doubles as a sensible
  // default for the (still editable) grade field when it is empty.
  const applyPrice = (grade: string, usd: number) =>
    setFields((f) => ({
      ...f,
      market_value: String(usd),
      grade: f.grade.trim() ? f.grade : grade,
    }));

  const canSave =
    !!productId &&
    fields.market_value.trim() !== '' &&
    Number(fields.market_value) >= 0 &&
    !saving;

  const save = async () => {
    if (!canSave || !productId) return;
    try {
      await registerCard.mutateAsync({
        product_id: productId,
        set: fields.set.trim(),
        grader: fields.grader.trim(),
        grade: fields.grade.trim(),
        market_value: Number(fields.market_value),
        pokemon_dex: fields.pokemon_dex,
        sprite_image: fields.sprite_image,
      });
      toast.success(t('cards.toast.created'));
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <FocusModal
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <FocusModal.Content>
        <FocusModal.Header>
          <div className="flex items-center justify-end gap-x-2">
            <Button size="small" variant="secondary" onClick={onClose}>
              {t('cards.form.cancel')}
            </Button>
            <Button
              size="small"
              onClick={save}
              isLoading={saving}
              disabled={!canSave}
            >
              {t('cards.register.save')}
            </Button>
          </div>
        </FocusModal.Header>
        <FocusModal.Body className="flex flex-col items-center overflow-auto p-10">
          <div className="flex w-full max-w-[640px] flex-col gap-y-6">
            <div>
              <FocusModal.Title asChild>
                <Heading level="h2">{t('cards.register.title')}</Heading>
              </FocusModal.Title>
              <FocusModal.Description asChild>
                <Text className="text-ui-fg-subtle mt-1" size="small">
                  {t('cards.register.subtitle')}
                </Text>
              </FocusModal.Description>
            </div>

            {/* 1 — pick the inventory product */}
            <div className="flex flex-col gap-y-2">
              <Label size="small" weight="plus">
                {t('cards.register.product')}
              </Label>
              <Input
                placeholder={t('cards.register.searchPlaceholder')}
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
              {loadError ? (
                <Text className="text-ui-fg-subtle" size="small">
                  {t('cards.register.loadError')}
                </Text>
              ) : products === null ? (
                <Text className="text-ui-fg-subtle" size="small">
                  …
                </Text>
              ) : products.length === 0 ? (
                <Text className="text-ui-fg-subtle" size="small">
                  {t('cards.register.noEligible')}
                </Text>
              ) : (
                <div className="max-h-64 divide-y overflow-y-auto rounded-lg border">
                  {visible.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => pick(p)}
                      className={clx(
                        'hover:bg-ui-bg-base-hover flex w-full items-center gap-3 px-4 py-2 text-left',
                        p.id === productId && 'bg-ui-bg-base-pressed',
                      )}
                    >
                      {p.thumbnail ? (
                        <img
                          src={resolveImageUrl(p.thumbnail)}
                          alt=""
                          className="h-9 w-7 shrink-0 rounded object-contain"
                        />
                      ) : (
                        <div className="border-ui-border-base bg-ui-bg-subtle h-9 w-7 shrink-0 rounded border" />
                      )}
                      <span className="flex-1 truncate text-sm font-medium">
                        {p.title}
                      </span>
                      <StatusBadge
                        color={p.status === 'published' ? 'green' : 'grey'}
                      >
                        {p.status}
                      </StatusBadge>
                    </button>
                  ))}
                  {visible.length === 0 && (
                    <div className="text-ui-fg-subtle px-4 py-3 text-sm">
                      {t('cards.register.noMatch')}
                    </div>
                  )}
                </div>
              )}
              {selected && (
                <Text className="text-ui-fg-subtle" size="small">
                  {t('cards.register.selectedHint', { title: selected.title })}
                </Text>
              )}
            </div>

            {/* 2 — market value via PriceCharting (or manual) */}
            <div className="bg-ui-bg-subtle flex flex-col gap-y-3 rounded-lg p-4">
              <Label size="small" weight="plus">
                {t('cards.register.pcTitle')}
              </Label>
              <div className="flex gap-2">
                <Input
                  placeholder={t('cards.register.pcPlaceholder')}
                  value={pcQuery}
                  onChange={(e) => setPcQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void runPcSearch();
                    }
                  }}
                />
                <Button
                  size="small"
                  variant="secondary"
                  type="button"
                  onClick={runPcSearch}
                  isLoading={pcSearching}
                  disabled={pcQuery.trim() === ''}
                >
                  {t('cards.register.pcSearch')}
                </Button>
              </div>
              {pcMatches !== null && pcMatches.length === 0 && (
                <Text className="text-ui-fg-subtle" size="small">
                  {t('cards.register.pcNoMatches')}
                </Text>
              )}
              {pcMatches !== null && pcMatches.length > 0 && (
                <div className="max-h-44 divide-y overflow-y-auto rounded-lg border">
                  {pcMatches.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => void pickPcMatch(m)}
                      disabled={pcLoadingId !== null}
                      className={clx(
                        'hover:bg-ui-bg-base-hover flex w-full flex-col px-4 py-2 text-left',
                        pcProduct?.id === m.id && 'bg-ui-bg-base-pressed',
                      )}
                    >
                      <span className="truncate text-sm font-medium">
                        {m.name}
                      </span>
                      <span className="text-ui-fg-subtle text-xs">{m.set}</span>
                    </button>
                  ))}
                </div>
              )}
              {pcProduct && (
                <div className="flex flex-wrap gap-2">
                  {pcProduct.prices.length === 0 ? (
                    <Text className="text-ui-fg-subtle" size="small">
                      {t('cards.register.pcNoPrices')}
                    </Text>
                  ) : (
                    pcProduct.prices.map((p) => (
                      <Button
                        key={p.grade}
                        size="small"
                        variant="secondary"
                        type="button"
                        onClick={() => applyPrice(p.grade, p.usd)}
                      >
                        {p.grade}: {usd(p.usd)}
                      </Button>
                    ))
                  )}
                </div>
              )}
              <Text className="text-ui-fg-subtle text-xs">
                {t('cards.register.pcHint')}
              </Text>
            </div>

            {/* 3 — gacha facts */}
            <div className="grid grid-cols-2 gap-4">
              <div className="flex flex-col gap-y-2">
                <Label size="small" weight="plus">
                  {t('cards.form.marketValue')}
                </Label>
                <Input
                  type="number"
                  min={0}
                  step={0.01}
                  value={fields.market_value}
                  onChange={(e) => patch({ market_value: e.target.value })}
                />
              </div>
              <div className="flex flex-col gap-y-2">
                <Label size="small" weight="plus">
                  {t('cards.form.set')}
                </Label>
                <Input
                  value={fields.set}
                  onChange={(e) => patch({ set: e.target.value })}
                />
              </div>
              <div className="flex flex-col gap-y-2">
                <Label size="small" weight="plus">
                  {t('cards.form.grader')}
                </Label>
                <Input
                  value={fields.grader}
                  onChange={(e) => patch({ grader: e.target.value })}
                />
              </div>
              <div className="flex flex-col gap-y-2">
                <Label size="small" weight="plus">
                  {t('cards.form.grade')}
                </Label>
                <Input
                  value={fields.grade}
                  onChange={(e) => patch({ grade: e.target.value })}
                />
              </div>
            </div>

            <CardPokemonFields
              value={{
                pokemon_dex: fields.pokemon_dex,
                sprite_image: fields.sprite_image,
              }}
              onChange={(p) => patch(p)}
              suggestionName={selected?.title ?? ''}
            />

            <Text className="text-ui-fg-subtle text-xs">
              {t('cards.register.rarityHint')}
            </Text>
          </div>
        </FocusModal.Body>
      </FocusModal.Content>
    </FocusModal>
  );
};

export default RegisterCardModal;
