import { useRef, useState, type ChangeEvent } from 'react';
import {
  Container,
  Heading,
  Text,
  Input,
  Label,
  Badge,
  Button,
  clx,
  toast,
} from '@medusajs/ui';
import type { RouteConfig } from '@mercurjs/dashboard-sdk';
import {
  usePixelPokemon,
  useUploadImage,
  useCreatePixelPokemon,
} from '../../lib/queries';
import { validateImageFile } from '../../lib/image-validation';
import { resolveImageUrl } from '../../lib/image-url';
import { Pager } from '../../components/Pager';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';

export const config: RouteConfig = {
  label: 'pcNav.sprites',
  translationNs: 'translation',
  rank: 2,
  nested: '/packs',
};

const PAGE_SIZE = 60;

// Admin Pokédex — browse every pixel-Pokémon in the library (the entries cards
// link to by id) and upload custom ones. Server filters + paginates the list.
const PixelPokedexPage = () => {
  const [q, setQ] = useState('');
  const [type, setType] = useState('');
  const [custom, setCustom] = useState<'' | 'true'>('');
  const [page, setPage] = useState(0);

  const { data, isError } = usePixelPokemon({
    q,
    type,
    custom,
    page,
    limit: PAGE_SIZE,
  });

  // Any filter change resets to the first page (stale offsets show nothing).
  const setFilter = (fn: () => void) => {
    fn();
    setPage(0);
  };

  const chip = (active: boolean) =>
    clx(
      'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
      active
        ? 'bg-ui-bg-base-pressed border-ui-border-strong'
        : 'bg-ui-bg-subtle border-ui-border-base hover:bg-ui-bg-base-hover',
    );

  // ── Upload custom pixel-pokémon ──────────────────────────────────────────
  const [showUpload, setShowUpload] = useState(false);
  const [name, setName] = useState('');
  const [dex, setDex] = useState('');
  const [variant, setVariant] = useState('');
  const [types, setTypes] = useState('');
  const [spriteUrl, setSpriteUrl] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const uploadImg = useUploadImage();
  const createMut = useCreatePixelPokemon();

  const resetForm = () => {
    setName('');
    setDex('');
    setVariant('');
    setTypes('');
    setSpriteUrl('');
  };

  const handleSprite = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const problem = await validateImageFile(file, 'sprite');
    if (problem) {
      toast.error(problem);
      if (fileRef.current) fileRef.current.value = '';
      return;
    }
    try {
      const url = await uploadImg.mutateAsync({ file, kind: 'sprite' });
      setSpriteUrl(url);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const submit = async () => {
    if (!name.trim()) {
      toast.error('Name is required.');
      return;
    }
    if (!spriteUrl) {
      toast.error('Upload a sprite image first.');
      return;
    }
    const dexNum = dex.trim() ? Number(dex) : null;
    if (
      dexNum !== null &&
      (!Number.isInteger(dexNum) || dexNum < 1 || dexNum > 1025)
    ) {
      toast.error('Dex # must be a whole number 1–1025, or left blank.');
      return;
    }
    try {
      await createMut.mutateAsync({
        name: name.trim(),
        dex: dexNum,
        variant: variant.trim() || 'custom',
        types: types
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
        image_url: spriteUrl,
      });
      resetForm();
      setShowUpload(false);
    } catch {
      // useCreatePixelPokemon.onError already toasted; keep the form open.
    }
  };

  return (
    <div className="flex flex-col gap-y-3">
      <Container className="p-0">
        <div className="flex flex-col gap-3 px-6 py-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <Heading level="h2">Pixel Pokédex</Heading>
              <Text className="text-ui-fg-subtle mt-1" size="small">
                Browse the pixel-Pokémon library
                {data
                  ? ` (${data.total.toLocaleString('en-US')} entries)`
                  : ''}
                . Cards link to these by id.
              </Text>
            </div>
            <Button
              size="small"
              variant={showUpload ? 'secondary' : 'primary'}
              onClick={() => setShowUpload((v) => !v)}
            >
              {showUpload ? 'Close' : 'Upload pixel Pokémon'}
            </Button>
          </div>

          {showUpload && (
            <div className="border-ui-border-base bg-ui-bg-subtle flex flex-col gap-3 rounded-lg border p-4">
              <Text size="small" weight="plus">
                New custom pixel Pokémon
              </Text>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="flex flex-col gap-1">
                  <Label size="small" htmlFor="pp-name">
                    Name
                  </Label>
                  <Input
                    id="pp-name"
                    placeholder="e.g. Pikachu (Shiny)"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <Label size="small" htmlFor="pp-dex">
                    Dex # (optional)
                  </Label>
                  <Input
                    id="pp-dex"
                    inputMode="numeric"
                    placeholder="1–1025, or blank"
                    value={dex}
                    onChange={(e) => setDex(e.target.value)}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <Label size="small" htmlFor="pp-variant">
                    Variant
                  </Label>
                  <Input
                    id="pp-variant"
                    placeholder="custom"
                    value={variant}
                    onChange={(e) => setVariant(e.target.value)}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <Label size="small" htmlFor="pp-types">
                    Types (comma-separated)
                  </Label>
                  <Input
                    id="pp-types"
                    placeholder="e.g. Fire, Flying"
                    value={types}
                    onChange={(e) => setTypes(e.target.value)}
                  />
                </div>
              </div>

              <div className="flex items-center gap-3">
                {spriteUrl ? (
                  <img
                    src={resolveImageUrl(spriteUrl)}
                    alt=""
                    className="border-ui-border-base h-16 w-16 shrink-0 rounded border bg-ui-bg-component object-contain"
                  />
                ) : (
                  <div className="border-ui-border-base bg-ui-bg-base text-ui-fg-muted flex h-16 w-16 shrink-0 items-center justify-center rounded border text-xs">
                    —
                  </div>
                )}
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={handleSprite}
                />
                <Button
                  size="small"
                  variant="secondary"
                  type="button"
                  isLoading={uploadImg.isPending}
                  onClick={() => fileRef.current?.click()}
                >
                  {spriteUrl ? 'Replace sprite' : 'Upload sprite'}
                </Button>
              </div>

              <div className="flex justify-end gap-2">
                <Button
                  size="small"
                  variant="secondary"
                  onClick={() => {
                    resetForm();
                    setShowUpload(false);
                  }}
                >
                  Cancel
                </Button>
                <Button
                  size="small"
                  onClick={submit}
                  isLoading={createMut.isPending}
                >
                  Add to library
                </Button>
              </div>
            </div>
          )}

          <Input
            placeholder="Search by name or #dex…"
            aria-label="Search pixel pokémon by name or dex"
            value={q}
            onChange={(e) => setFilter(() => setQ(e.target.value))}
          />

          {data && data.all_types.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                className={chip(type === '')}
                onClick={() => setFilter(() => setType(''))}
              >
                All types
              </button>
              {data.all_types.map((t) => (
                <button
                  key={t}
                  type="button"
                  className={chip(type === t)}
                  onClick={() => setFilter(() => setType(type === t ? '' : t))}
                >
                  {t}
                </button>
              ))}
              <span className="bg-ui-border-base mx-1 h-4 w-px" aria-hidden />
              <button
                type="button"
                className={chip(custom === 'true')}
                onClick={() =>
                  setFilter(() => setCustom(custom === 'true' ? '' : 'true'))
                }
              >
                Custom only
              </button>
            </div>
          )}
        </div>

        {isError ? (
          <div className="border-t px-6 py-8">
            <Text className="text-ui-fg-subtle">
              Couldn’t load the pixel-Pokémon library.
            </Text>
          </div>
        ) : !data ? (
          <div className="border-t px-6 py-8">
            <LoadingSkeleton />
          </div>
        ) : data.pixel_pokemon.length === 0 ? (
          <div className="border-t px-6 py-8">
            <Text className="text-ui-fg-subtle">No matches.</Text>
          </div>
        ) : (
          <div
            data-testid="pokedex-grid"
            className="grid grid-cols-2 gap-3 border-t p-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6"
          >
            {data.pixel_pokemon.map((p) => (
              <div
                key={p.id}
                className="border-ui-border-base bg-ui-bg-subtle flex flex-col items-center gap-2 rounded-lg border p-3"
              >
                {p.image_url ? (
                  <img
                    src={resolveImageUrl(p.image_url)}
                    alt={p.name}
                    loading="lazy"
                    className="h-16 w-16 shrink-0 rounded bg-ui-bg-component object-contain"
                  />
                ) : (
                  <div className="border-ui-border-base bg-ui-bg-base text-ui-fg-muted flex h-16 w-16 shrink-0 items-center justify-center rounded border text-xs">
                    —
                  </div>
                )}
                <div className="text-center">
                  <Text size="small" className="font-medium leading-tight">
                    {p.name}
                  </Text>
                  <Text size="xsmall" className="text-ui-fg-subtle">
                    {p.dex !== null ? `#${p.dex}` : 'custom'} · {p.variant}
                  </Text>
                </div>
                {p.types.length > 0 && (
                  <div className="flex flex-wrap justify-center gap-1">
                    {p.types.map((t) => (
                      <Badge key={t} size="2xsmall">
                        {t}
                      </Badge>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {data && (
          <Pager
            page={page}
            onPage={setPage}
            pageSize={data.limit}
            count={data.pixel_pokemon.length}
            total={data.total}
          />
        )}
      </Container>
    </div>
  );
};

export default PixelPokedexPage;
