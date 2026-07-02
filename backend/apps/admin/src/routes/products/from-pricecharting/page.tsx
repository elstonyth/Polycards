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
} from '@medusajs/ui';
import type { RouteConfig } from '@mercurjs/dashboard-sdk';
import {
  searchPriceCharting,
  getPriceChartingProduct,
  type PcMatch,
  type PcProduct,
} from '../../../lib/admin-rest';
import { useFxRate, useCreateProductFromPriceCharting, useUploadImage } from '../../../lib/queries';
import { resolveImageUrl } from '../../../lib/image-url';
import { validateImageFile } from '../../../lib/image-validation';
import { rm } from '../../../lib/format';

export const config: RouteConfig = {
  label: 'Add from PriceCharting',
  nested: '/products',
  rank: 1,
};

// Client mirror of backend/packages/api/src/modules/packs/pricecharting-grades.ts
// gradeToGrader — the admin app and the Medusa backend are separate builds with
// no shared package, so this ~5-line pure function is duplicated rather than
// wired through a new workspace package. Keep in sync if the backend changes.
function gradeToGrader(label: string): { grader: string; grade: string } {
  for (const g of ['PSA', 'BGS', 'CGC', 'SGC']) {
    if (label.startsWith(g + ' ')) {
      return { grader: g, grade: label.slice(g.length + 1) };
    }
  }
  if (label.startsWith('Grade ')) return { grader: '', grade: label.slice(6) };
  return { grader: '', grade: label };
}

// Client mirror of pricing.ts displayMarketPrice — display-only preview math;
// the value actually submitted to the backend is always the raw USD grade
// price (see market_value in the payload below), never this computed number.
function displayMarketPrice(
  marketValueUsd: number,
  fxUsdMyr: number,
  multiplier: number,
): number {
  const raw = Number(marketValueUsd);
  const fx = Number(fxUsdMyr);
  const mult = Number(multiplier);
  if (![raw, fx, mult].every(Number.isFinite) || raw < 0 || fx <= 0 || mult <= 0) {
    return 0;
  }
  return Math.round(raw * fx * mult * 100) / 100;
}

const DEFAULT_MULTIPLIER_PCT = '20'; // 20% markup = 1.2x, the spec default.

const AddFromPriceChartingPage = () => {
  const { t } = useTranslation();
  const { data: fx } = useFxRate();
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

  // Step 3 — markup.
  const [multiplierPct, setMultiplierPct] = useState(DEFAULT_MULTIPLIER_PCT);

  // Step 3b — stock. Tracked units seeded at creation (default a single slab).
  const [stock, setStock] = useState('1');

  // Step 4 — image (auto-pull seam for Task 15: no prefill wired yet — the
  // Prices API returns no image, so this always starts empty and relies on
  // upload/replace until a prefill endpoint lands).
  const [image, setImage] = useState('');

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
    try {
      setPcProduct(await getPriceChartingProduct(m.id));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setPcLoadingId(null);
    }
  };

  const pickTier = (tierGrade: string, usd: number) => {
    setPcGrade(tierGrade);
    setMarketValue(usd);
    const derived = gradeToGrader(tierGrade);
    setGrader(derived.grader);
    setGrade(derived.grade);
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

  const multiplier = 1 + Number(multiplierPct) / 100;
  const fxEffective = fx?.effective ?? null;
  const preview =
    marketValue !== null && fxEffective !== null && Number.isFinite(multiplier) && multiplier > 0
      ? {
          marketMyr: displayMarketPrice(marketValue, fxEffective, 1),
          customerMyr: displayMarketPrice(marketValue, fxEffective, multiplier),
          marginMyr: displayMarketPrice(marketValue, fxEffective, Math.max(multiplier - 1, 0)),
        }
      : null;

  const canSave =
    !!match &&
    !!pcProduct &&
    pcGrade !== null &&
    marketValue !== null &&
    image.trim() !== '' &&
    Number.isFinite(multiplier) &&
    multiplier > 0 &&
    Number.isInteger(Number(stock)) &&
    Number(stock) >= 0 &&
    !saving &&
    !uploading;

  const save = async () => {
    if (!canSave || !match || !pcProduct || pcGrade === null || marketValue === null) return;
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
        market_multiplier: multiplier,
        stock: Number(stock),
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

      <div className="flex flex-col gap-y-6 px-6 py-6">
        {/* Step 1 — search */}
        <div className="flex flex-col gap-y-2">
          <Label size="small" weight="plus">
            {t('pcAdd.search.label')}
          </Label>
          <div className="flex gap-2">
            <Input
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
                  className={`hover:bg-ui-bg-base-hover flex w-full flex-col px-4 py-2 text-left ${
                    match?.id === m.id ? 'bg-ui-bg-base-pressed' : ''
                  }`}
                >
                  <span className="truncate text-sm font-medium">{m.name}</span>
                  <span className="text-ui-fg-subtle text-xs">{m.set}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Step 2 — grade-tier picker */}
        {match && (
          <div className="bg-ui-bg-subtle flex flex-col gap-y-3 rounded-lg p-4">
            <Label size="small" weight="plus">
              {t('pcAdd.grade.label')}
            </Label>
            {pcLoadingId === match.id ? (
              <Text className="text-ui-fg-subtle" size="small">
                …
              </Text>
            ) : pcProduct === null ? (
              <Text className="text-ui-fg-subtle" size="small">
                {t('pcAdd.grade.loadError')}
              </Text>
            ) : pcProduct.prices.length === 0 ? (
              <Text className="text-ui-fg-subtle" size="small">
                {t('pcAdd.grade.empty')}
              </Text>
            ) : (
              <div className="flex flex-wrap gap-2">
                {pcProduct.prices.map((p) => (
                  <Button
                    key={p.grade}
                    size="small"
                    variant={pcGrade === p.grade ? 'primary' : 'secondary'}
                    type="button"
                    onClick={() => pickTier(p.grade, p.usd)}
                  >
                    {p.grade}: {rm(p.usd)}
                  </Button>
                ))}
              </div>
            )}
            {pcGrade !== null && (
              <Text className="text-ui-fg-subtle text-xs">
                {t('pcAdd.grade.derivedHint', {
                  grader: grader || '—',
                  grade,
                })}
              </Text>
            )}
          </div>
        )}

        {/* Step 3 — markup + live preview */}
        {pcGrade !== null && marketValue !== null && (
          <div className="flex flex-col gap-y-3">
            <div className="flex flex-col gap-y-2">
              <Label size="small" weight="plus">
                {t('pcAdd.markup.label')}
              </Label>
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  min={0}
                  step={1}
                  className="max-w-[8rem]"
                  value={multiplierPct}
                  onChange={(e) => setMultiplierPct(e.target.value)}
                />
                <Text className="text-ui-fg-subtle" size="small">
                  %
                </Text>
              </div>
            </div>

            <div className="bg-ui-bg-subtle rounded-lg p-4">
              {fxEffective === null || preview === null ? (
                <Text className="text-ui-fg-subtle" size="small">
                  {t('pcAdd.preview.loading')}
                </Text>
              ) : (
                <Text size="small">
                  {t('pcAdd.preview.line', {
                    raw: marketValue.toFixed(2),
                    fx: fxEffective.toFixed(4),
                    market: preview.marketMyr.toFixed(2),
                    customer: preview.customerMyr.toFixed(2),
                    margin: preview.marginMyr.toFixed(2),
                  })}
                </Text>
              )}
            </div>
          </div>
        )}

        {/* Step 3b — stock quantity */}
        {pcGrade !== null && (
          <div className="flex flex-col gap-y-2">
            <Label size="small" weight="plus">
              {t('pcAdd.stock.label')}
            </Label>
            <Input
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
            <Label size="small" weight="plus">
              {t('pcAdd.image.label')}
            </Label>
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

        {/* Step 5 — submit */}
        {pcGrade !== null && (
          <div className="flex items-center gap-3">
            <Button size="small" onClick={save} isLoading={saving} disabled={!canSave}>
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
