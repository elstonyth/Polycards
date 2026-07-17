import { useRef, useState, type ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import {
  Container,
  Heading,
  Text,
  Input,
  Label,
  Button,
  StatusBadge,
  toast,
  clx,
} from '@medusajs/ui';
import type { RouteConfig } from '@mercurjs/dashboard-sdk';
import {
  searchPriceCharting,
  getPriceChartingProduct,
  getTcgCardMeta,
  type PcMatch,
  type PcProduct,
} from '../../../lib/admin-rest';
import {
  useFxRate,
  useCreateProductFromPriceCharting,
  useUploadImage,
} from '../../../lib/queries';
import { resolveImageUrl } from '../../../lib/image-url';
import { validateImageFile } from '../../../lib/image-validation';
import { rm, usdToMyr, gradeToGrader } from '../../../lib/format';
import CardPokemonFields, {
  type CardPokemonValue,
} from '../../cards/CardPokemonFields';
import { GachaPipelineHint } from '../../../components/GachaPipelineHint';
import { GraderGradeSelect } from '../../../components/GraderGradeSelect';
import { LoadingSkeleton } from '../../../components/LoadingSkeleton';

export const config: RouteConfig = {
  label: 'Add from PriceCharting',
  nested: '/products',
  rank: 1,
};

// NOTE: usdToMyr is display-only preview math; the value submitted to the backend
// is always the raw USD grade price. NO markup is applied anywhere on this page —
// margin belongs to gacha-card registration.

// Client mirror of backend api/admin/media/ingest-pc-image.ts isPcImageUrl —
// PriceCharting's price API exposes no image, so the backend scrapes the photo
// URL from the PC product page and returns it as product.image (auto-filled on
// pick below); the operator can still paste/replace. On save the backend
// detects this host and ingests the bytes through the media pipeline. Keep in
// sync with the backend.
const isPcImageUrl = (url: string): boolean => {
  try {
    const u = new URL(url);
    return (
      u.protocol === 'https:' &&
      u.hostname === 'storage.googleapis.com' &&
      u.pathname.startsWith('/images.pricecharting.com/')
    );
  } catch {
    return false;
  }
};

const AddFromPriceChartingPage = () => {
  const { t } = useTranslation();
  const { data: fx, isError: fxError } = useFxRate();
  const createProduct = useCreateProductFromPriceCharting();
  const uploadImg = useUploadImage();
  const fileRef = useRef<HTMLInputElement>(null);

  // Step 1 — search.
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [matches, setMatches] = useState<PcMatch[] | null>(null);

  // Step 2 — pick a match, load per-grade prices, pick a tier.
  const [pcLoadingId, setPcLoadingId] = useState<string | null>(null);
  const [match, setMatch] = useState<PcMatch | null>(null);
  const [pcProduct, setPcProduct] = useState<PcProduct | null>(null);
  const [pcGrade, setPcGrade] = useState<string | null>(null);
  const [marketValue, setMarketValue] = useState<number | null>(null); // raw USD
  const [grader, setGrader] = useState('');
  const [grade, setGrade] = useState('');
  // Slab-label text (§8) — operator-typed, printed on the baked PSA composite.
  const [labelYear, setLabelYear] = useState('');
  const [labelNote, setLabelNote] = useState('');

  // Step 3 — stock. Default 0: units are counted when the physical slabs are
  // actually in hand, not implied by creating the listing.
  const [stock, setStock] = useState('0');

  // Step 4 — image. Auto-filled from the card photo the backend scrapes off
  // PriceCharting's product page (returned as pcProduct.image on pick); the
  // backend re-fetches it through the media pipeline on save (never hotlinked).
  // Upload/replace stays available.
  const [image, setImage] = useState('');

  // Step 5 — pixel Pokémon (staged on product.metadata; inherited when the
  // product is registered as a gacha card).
  const [pokemon, setPokemon] = useState<CardPokemonValue>({
    pixel_pokemon_id: null,
  });

  // Result.
  const [created, setCreated] = useState<{ id: string; handle: string } | null>(
    null,
  );

  const uploading = uploadImg.isPending;
  const saving = createProduct.isPending;

  const runSearch = async () => {
    const q = query.trim();
    if (!q || searching) return;
    setSearching(true);
    setMatches(null);
    setMatch(null);
    setPcProduct(null);
    setPcGrade(null);
    setMarketValue(null);
    setImage('');
    setLabelYear('');
    setLabelNote('');
    // Reset the staged Pokémon too — a pick from a PREVIOUS product must not
    // leak onto the newly searched/selected one.
    setPokemon({ pixel_pokemon_id: null });
    try {
      setMatches(await searchPriceCharting(q));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSearching(false);
    }
  };

  const pickMatch = async (m: PcMatch) => {
    if (pcLoadingId) return;
    setPcLoadingId(m.id);
    setMatch(m);
    setPcProduct(null);
    setPcGrade(null);
    setMarketValue(null);
    setImage('');
    setLabelYear('');
    setLabelNote('');
    // Reset the staged Pokémon too — a pick from a PREVIOUS product must not
    // leak onto the newly searched/selected one.
    setPokemon({ pixel_pokemon_id: null });
    try {
      const product = await getPriceChartingProduct(m.id);
      setPcProduct(product);
      if (product.image) setImage(product.image);
      // §7a prefill: year (set release) + note (rarity) from pokemontcg.io.
      // Fill-only — the fields stay editable and a lookup failure just leaves
      // them blank for the operator. The card number rides product-name
      // ("Pikachu ex #238" — PC has no separate field).
      const num = product.name.match(/#\s*([A-Za-z0-9/-]+)\s*$/)?.[1] ?? '';
      void getTcgCardMeta(product.set, num)
        .then((meta) => {
          setLabelYear((v) => v || meta.year || '');
          setLabelNote((v) => v || meta.note || '');
        })
        .catch(() => {});
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setPcLoadingId(null);
    }
  };

  const pickTier = (tierGrade: string, usd: number) => {
    setPcGrade(tierGrade);
    setMarketValue(usd);
    // Prefill ONLY when the tier names a grader ("PSA 10" → PSA/10). Generic
    // "Grade 7/8/9/9.5" tiers are price comps, not PSA claims — the operator
    // states the physical slab's grader + grade themselves (§3a).
    const derived = gradeToGrader(tierGrade);
    setGrader(derived.grader);
    setGrade(derived.grader ? derived.grade : '');
  };

  const handleFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const problem = await validateImageFile(file, 'card');
    if (problem) {
      toast.error(problem);
      if (fileRef.current) fileRef.current.value = '';
      return;
    }
    try {
      const url = await uploadImg.mutateAsync({ file, kind: 'card' });
      setImage(url);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const fxEffective = fx?.effective ?? null;
  // Non-marked-up MYR label for a grade-tier chip; raw USD until FX loads.
  const tierLabel = (usd: number): string =>
    fxEffective !== null
      ? rm(usdToMyr(usd, fxEffective))
      : `$${usd.toFixed(2)}`;

  // A pasted PC photo URL (or the rare proxy-provided one) gets the "will be
  // ingested" badge — the backend stores its own copy on save.
  const imageAutoFilled =
    image !== '' && (isPcImageUrl(image) || image === pcProduct?.image);

  const canSave =
    !!match &&
    !!pcProduct &&
    pcGrade !== null &&
    marketValue !== null &&
    image.trim() !== '' &&
    // A grade is unrepresentable without a grader (§3a) — "grader chosen" and
    // "grade chosen" must move together.
    (grader === '' || grade !== '') &&
    // Required — the backend rejects a from-PC product without a pixel link
    // (name-derivation fails on suffixed PC names like "Blastoise ex #200").
    pokemon.pixel_pokemon_id !== null &&
    stock.trim() !== '' &&
    Number.isInteger(Number(stock)) &&
    Number(stock) >= 0 &&
    !saving &&
    !uploading;

  const save = async () => {
    if (
      !canSave ||
      !match ||
      !pcProduct ||
      pcGrade === null ||
      marketValue === null ||
      pokemon.pixel_pokemon_id === null
    )
      return;
    try {
      const product = await createProduct.mutateAsync({
        pc_product_id: match.id,
        pc_grade: pcGrade,
        name: pcProduct.name,
        set: pcProduct.set,
        grader,
        grade,
        market_value: marketValue,
        image: image.trim(),
        stock: Number(stock),
        // Staged on the product's metadata; the create-card step inherits +
        // mirrors it when the product is later registered as a gacha card.
        pixel_pokemon_id: pokemon.pixel_pokemon_id,
        label_year: labelYear.trim() || null,
        label_note: labelNote.trim() || null,
      });
      setCreated(product);
      toast.success(t('pcAdd.toast.created', { name: pcProduct.name }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Container className="divide-y p-0">
      <div className="px-6 py-4">
        <Heading level="h2">{t('pcAdd.title')}</Heading>
        <Text className="text-ui-fg-subtle mt-1" size="small">
          {t('pcAdd.subtitle')}
        </Text>
      </div>

      <GachaPipelineHint current="product" />

      <div className="flex flex-col gap-y-6 px-6 py-6">
        {/* Step 1 — search */}
        <div className="flex flex-col gap-y-2">
          <Label size="small" weight="plus" htmlFor="pc-search">
            {t('pcAdd.search.label')}
          </Label>
          <div className="flex gap-2">
            <Input
              id="pc-search"
              placeholder={t('pcAdd.search.placeholder')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void runSearch();
                }
              }}
            />
            <Button
              size="small"
              variant="secondary"
              type="button"
              onClick={runSearch}
              isLoading={searching}
              disabled={query.trim() === ''}
            >
              {t('pcAdd.search.button')}
            </Button>
          </div>
          {matches !== null && matches.length === 0 && (
            <Text className="text-ui-fg-subtle" size="small">
              {t('pcAdd.search.empty')}
            </Text>
          )}
          {matches !== null && matches.length > 0 && (
            <div className="max-h-56 divide-y overflow-y-auto rounded-lg border">
              {matches.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => void pickMatch(m)}
                  disabled={pcLoadingId !== null}
                  className={clx(
                    'hover:bg-ui-bg-base-hover flex w-full flex-col px-4 py-2 text-left',
                    match?.id === m.id && 'bg-ui-bg-base-pressed',
                  )}
                >
                  <span className="truncate text-sm font-medium">{m.name}</span>
                  <span className="text-ui-fg-subtle text-xs">{m.set}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Step 2 — grade-tier picker (non-marked-up MYR via the live FX rate) */}
        {match && (
          <div className="bg-ui-bg-subtle flex flex-col gap-y-3 rounded-lg p-4">
            <Label size="small" weight="plus">
              {t('pcAdd.grade.label')}
            </Label>
            {pcLoadingId === match.id ? (
              <LoadingSkeleton rows={2} />
            ) : pcProduct === null ? (
              <Text className="text-ui-fg-subtle" size="small">
                {t('pcAdd.grade.loadError')}
              </Text>
            ) : pcProduct.prices.length === 0 ? (
              <Text className="text-ui-fg-subtle" size="small">
                {t('pcAdd.grade.empty')}
              </Text>
            ) : (
              <>
                <div className="flex flex-wrap gap-2">
                  {pcProduct.prices.map((p) => (
                    <Button
                      key={p.grade}
                      size="small"
                      variant={pcGrade === p.grade ? 'primary' : 'secondary'}
                      type="button"
                      onClick={() => pickTier(p.grade, p.usd)}
                    >
                      {p.grade}: {tierLabel(p.usd)}
                    </Button>
                  ))}
                </div>
                <Text className="text-ui-fg-subtle text-xs">
                  {t('pcAdd.grade.fxHint')}
                </Text>
              </>
            )}
            {pcGrade !== null && (
              <GraderGradeSelect
                grader={grader}
                grade={grade}
                onChange={(v) => {
                  setGrader(v.grader);
                  setGrade(v.grade);
                }}
                idPrefix="pc"
              />
            )}
          </div>
        )}

        {/* Step 2b — slab label text (§8) */}
        {pcGrade !== null && (
          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-y-2">
              <Label size="small" weight="plus" htmlFor="pc-label-year">
                {t('cards.form.labelYear')}
              </Label>
              <Input
                id="pc-label-year"
                value={labelYear}
                onChange={(e) => setLabelYear(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-y-2">
              <Label size="small" weight="plus" htmlFor="pc-label-note">
                {t('cards.form.labelNote')}
              </Label>
              <Input
                id="pc-label-note"
                value={labelNote}
                onChange={(e) => setLabelNote(e.target.value)}
              />
            </div>
            <Text className="text-ui-fg-subtle col-span-2 text-xs">
              {t('cards.form.labelHint')}
            </Text>
          </div>
        )}

        {/* Step 3 — live preview (raw USD → MYR, no markup) */}
        {pcGrade !== null && marketValue !== null && (
          <div className="bg-ui-bg-subtle rounded-lg p-4">
            {fxEffective === null ? (
              fxError ? (
                <Text className="text-ui-fg-error" size="small">
                  Exchange rate unavailable — try again later.
                </Text>
              ) : (
                <Text className="text-ui-fg-subtle" size="small">
                  {t('pcAdd.preview.loading')}
                </Text>
              )
            ) : (
              <Text size="small">
                {t('pcAdd.preview.line', {
                  raw: marketValue.toFixed(2),
                  fx: fxEffective.toFixed(4),
                  market: usdToMyr(marketValue, fxEffective).toFixed(2),
                })}
              </Text>
            )}
          </div>
        )}

        {/* Step 3b — stock quantity */}
        {pcGrade !== null && (
          <div className="flex flex-col gap-y-2">
            <Label size="small" weight="plus" htmlFor="pc-stock">
              {t('pcAdd.stock.label')}
            </Label>
            <Input
              id="pc-stock"
              type="number"
              min={0}
              step={1}
              className="max-w-[8rem]"
              value={stock}
              onChange={(e) => setStock(e.target.value)}
            />
            <Text className="text-ui-fg-subtle text-xs">
              {t('pcAdd.stock.hint')}
            </Text>
          </div>
        )}

        {/* Step 4 — image */}
        {pcGrade !== null && (
          <div className="flex flex-col gap-y-2">
            <div className="flex items-center gap-2">
              <Label size="small" weight="plus" htmlFor="pc-image-url">
                {t('pcAdd.image.label')}
              </Label>
              {imageAutoFilled && (
                <StatusBadge color="blue">
                  {t('pcAdd.image.autoFilled')}
                </StatusBadge>
              )}
            </div>
            <div className="flex items-center gap-4">
              {image ? (
                <img
                  src={resolveImageUrl(image)}
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
                  {image ? t('pcAdd.image.replace') : t('pcAdd.image.upload')}
                </Button>
                <Input
                  id="pc-image-url"
                  placeholder={t('pcAdd.image.urlPlaceholder')}
                  value={image}
                  onChange={(e) => setImage(e.target.value)}
                />
                <Text className="text-ui-fg-subtle text-xs">
                  {t('pcAdd.image.hint')}
                </Text>
              </div>
            </div>
          </div>
        )}

        {/* Step 5 — pixel Pokémon (required — see canSave) */}
        {pcGrade !== null && (
          <div className="flex flex-col gap-y-2">
            <CardPokemonFields
              value={pokemon}
              onChange={(p) => setPokemon((v) => ({ ...v, ...p }))}
              suggestionName={pcProduct?.name ?? ''}
            />
            {pokemon.pixel_pokemon_id === null && (
              <Text size="small" className="text-ui-fg-error">
                {t('pcAdd.pixel.required')}
              </Text>
            )}
          </div>
        )}

        {/* Step 6 — submit */}
        {pcGrade !== null && (
          <div className="flex items-center gap-3">
            <Button
              size="small"
              onClick={save}
              isLoading={saving}
              disabled={!canSave}
            >
              {t('pcAdd.submit')}
            </Button>
            {created && (
              <div className="flex items-center gap-2">
                <StatusBadge color="green">{t('pcAdd.created')}</StatusBadge>
                <Link
                  to={`/products/${created.id}`}
                  className="text-ui-fg-interactive text-sm hover:underline"
                >
                  {created.handle}
                </Link>
              </div>
            )}
          </div>
        )}
      </div>
    </Container>
  );
};

export default AddFromPriceChartingPage;
