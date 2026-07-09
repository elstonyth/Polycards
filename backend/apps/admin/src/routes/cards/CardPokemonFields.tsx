import {
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from 'react';
import { Button, Input, Label, Text, clx, toast } from '@medusajs/ui';
import { spriteGif } from '@acme/pokemon';
import {
  useUploadImage,
  usePixelPokemon,
  useCreatePixelPokemon,
} from '../../lib/queries';
import { validateImageFile } from '../../lib/image-validation';
import { resolveImageUrl } from '../../lib/image-url';
import type { PixelPokemonRow } from '../../lib/admin-rest';

// Spec 2 §5 — the card's Pokémon is assigned by LINKING a PixelPokemon library
// entry by id (id-only). The picker replaces the old dex combobox: search the
// library, select an entry (its dex + sprite are mirrored onto the card by the
// backend), or upload a custom sprite which creates + links a new entry.
export type CardPokemonValue = { pixel_pokemon_id: string | null };

type Props = {
  value: CardPokemonValue;
  onChange: (patch: Partial<CardPokemonValue>) => void;
  /** The card's currently-linked render cache (mirrored sprite/dex) so the
   *  preview shows what's linked on first load — we hold only the id, so the
   *  parent passes what it already knows instead of forcing a fetch. */
  currentSprite?: string | null;
  currentDex?: number | null;
  /** Card/product title — the default name for a custom-uploaded entry. */
  suggestionName: string;
};

const PICKER_LIMIT = 40;

function entrySprite(e: {
  image_url: string | null;
  dex: number | null;
}): string | null {
  if (e.image_url && e.image_url.trim() !== '')
    return resolveImageUrl(e.image_url);
  if (e.dex != null) return spriteGif(e.dex);
  return null;
}

const CardPokemonFields = ({
  value,
  onChange,
  currentSprite,
  currentDex,
  suggestionName,
}: Props) => {
  const [search, setSearch] = useState('');
  // The entry chosen THIS session — drives the preview once picked. On first
  // load it's null and the preview falls back to the card's mirrored sprite.
  const [picked, setPicked] = useState<PixelPokemonRow | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const uploadImg = useUploadImage();
  const createEntry = useCreatePixelPokemon();
  const uploading = uploadImg.isPending || createEntry.isPending;

  const q = search.trim();
  const { data, isFetching } = usePixelPokemon({ q, limit: PICKER_LIMIT });
  const matches = q.length >= 1 ? (data?.pixel_pokemon ?? []) : [];

  const linked = value.pixel_pokemon_id !== null;
  // Only let this session's pick drive the preview while it still matches the
  // parent value — a form reset/unlink changes value.pixel_pokemon_id without
  // clearing `picked`, which would otherwise show a stale linked Pokémon over an
  // unassigned payload.
  const pickedForValue =
    picked && picked.id === value.pixel_pokemon_id ? picked : null;
  const previewSrc = pickedForValue
    ? entrySprite(pickedForValue)
    : linked
      ? entrySprite({
          image_url: currentSprite ?? null,
          dex: currentDex ?? null,
        })
      : null;
  const previewLabel = pickedForValue
    ? `${pickedForValue.name}${pickedForValue.dex != null ? ` · #${pickedForValue.dex}` : ''}${
        pickedForValue.is_custom ? ' · custom' : ''
      }`
    : linked
      ? 'Linked to a library entry'
      : 'Unassigned — resolves from the card name';

  const select = (e: PixelPokemonRow) => {
    setPicked(e);
    onChange({ pixel_pokemon_id: e.id });
    setSearch('');
  };

  const clear = () => {
    setPicked(null);
    onChange({ pixel_pokemon_id: null });
  };

  // Upload a custom sprite → create a library entry from it → link that entry.
  const handleUpload = async (ev: ChangeEvent<HTMLInputElement>) => {
    const file = ev.target.files?.[0];
    if (!file) return;
    const problem = await validateImageFile(file, 'sprite');
    if (problem) {
      toast.error(problem);
      if (fileRef.current) fileRef.current.value = '';
      return;
    }
    let url: string;
    try {
      url = await uploadImg.mutateAsync({ file, kind: 'sprite' });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      if (fileRef.current) fileRef.current.value = '';
      return;
    }
    try {
      const name =
        suggestionName.trim() !== '' ? suggestionName.trim() : 'Custom sprite';
      const res = await createEntry.mutateAsync({
        name,
        image_url: url,
        variant: 'custom',
      });
      select(res.pixel_pokemon);
    } catch {
      // useCreatePixelPokemon already surfaces the error via its own toast.
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <div className="bg-ui-bg-subtle flex flex-col gap-y-3 rounded-lg p-4">
      <Label size="small" weight="plus" htmlFor="card-pokemon-search">
        Pixel Pokémon
      </Label>

      <div className="flex items-center gap-4">
        {previewSrc ? (
          <img
            src={previewSrc}
            alt=""
            className="border-ui-border-base h-16 w-16 shrink-0 rounded border bg-white object-contain"
          />
        ) : (
          <div className="border-ui-border-base bg-ui-bg-base text-ui-fg-muted flex h-16 w-16 shrink-0 items-center justify-center rounded border text-xs">
            —
          </div>
        )}
        <div className="flex flex-col">
          <Text size="small" className="font-medium">
            {previewLabel}
          </Text>
          <Text size="small" className="text-ui-fg-subtle">
            {linked
              ? 'The reel + card show this entry’s sprite.'
              : 'Link an entry below, or upload a custom sprite.'}
          </Text>
        </div>
      </div>

      {/* Library search — link a card to a PixelPokemon entry by id */}
      <Input
        id="card-pokemon-search"
        placeholder="Search the Pokédex library by name…"
        aria-label="Search the Pokédex library by name"
        role="combobox"
        aria-expanded={q.length >= 1}
        aria-controls="card-pokemon-listbox"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
          // Consume Escape ONLY when it clears a non-empty search — otherwise it
          // bubbles to the enclosing FocusModal (base-ui Dialog closes on Escape
          // at the document level) and discards the whole in-progress card edit.
          if (e.key === 'Escape' && search !== '') {
            e.preventDefault();
            e.stopPropagation();
            setSearch('');
          }
        }}
      />
      {q.length >= 1 && (
        <div
          id="card-pokemon-listbox"
          role="listbox"
          aria-label="Library matches"
          aria-busy={isFetching}
          className="max-h-52 divide-y overflow-y-auto rounded-lg border"
        >
          {matches.length === 0 ? (
            <div className="text-ui-fg-muted px-4 py-3 text-sm">
              {isFetching ? 'Searching…' : 'No matching entries.'}
            </div>
          ) : (
            matches.map((m) => {
              const selected = value.pixel_pokemon_id === m.id;
              const src = entrySprite(m);
              return (
                <button
                  key={m.id}
                  role="option"
                  aria-selected={selected}
                  type="button"
                  onClick={() => select(m)}
                  className={clx(
                    'flex w-full items-center gap-3 px-4 py-2 text-left',
                    'hover:bg-ui-bg-base-hover',
                    selected && 'bg-ui-bg-base-pressed',
                  )}
                >
                  {src ? (
                    <img
                      src={src}
                      alt=""
                      className="h-8 w-8 shrink-0 bg-white object-contain"
                    />
                  ) : (
                    <span className="bg-ui-bg-base h-8 w-8 shrink-0 rounded" />
                  )}
                  <span className="flex-1 truncate text-sm font-medium">
                    {m.name}
                    {m.dex != null && (
                      <span className="text-ui-fg-subtle"> · #{m.dex}</span>
                    )}
                    {m.variant !== 'normal' && (
                      <span className="text-ui-fg-subtle"> · {m.variant}</span>
                    )}
                  </span>
                </button>
              );
            })
          )}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {linked && (
          <Button
            size="small"
            variant="secondary"
            type="button"
            onClick={clear}
          >
            Clear link (use name)
          </Button>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={handleUpload}
        />
        <Button
          size="small"
          variant="secondary"
          type="button"
          onClick={() => fileRef.current?.click()}
          isLoading={uploading}
        >
          Upload + link custom sprite
        </Button>
      </div>
    </div>
  );
};

export default CardPokemonFields;
