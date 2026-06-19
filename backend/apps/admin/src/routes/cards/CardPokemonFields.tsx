import { useMemo, useRef, useState, type ChangeEvent } from 'react';
import { Button, Input, Label, Text, clx, toast } from '@medusajs/ui';
import { POKEDEX_NAMES, pokemonFromCard, spriteGif } from '@acme/pokemon';
import { useUploadImage } from '../../lib/queries';
import { validateImageFile } from '../../lib/image-validation';
import { resolveImageUrl } from '../../lib/image-url';

// The pixel-Pokémon assignment value for a card: an explicit national-dex number
// and/or a custom uploaded sprite. Both null → the card resolves via its name.
export type CardPokemonValue = {
  pokemon_dex: number | null;
  sprite_image: string | null;
};

type Props = {
  value: CardPokemonValue;
  onChange: (patch: Partial<CardPokemonValue>) => void;
  /** Card/product title used to compute the default name-derived suggestion. */
  suggestionName: string;
};

const PICKER_LIMIT = 60;

const CardPokemonFields = ({ value, onChange, suggestionName }: Props) => {
  const [filter, setFilter] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const uploadImg = useUploadImage();
  const uploading = uploadImg.isPending;

  const suggestion = useMemo(
    () => pokemonFromCard(suggestionName),
    [suggestionName],
  );

  // Effective dex shown in the preview: explicit wins, else the name suggestion.
  const effectiveDex = value.pokemon_dex ?? suggestion?.dex ?? null;
  const effectiveName =
    value.pokemon_dex !== null
      ? (POKEDEX_NAMES[value.pokemon_dex - 1] ?? null)
      : (suggestion?.name ?? null);

  const matches = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return [] as { dex: number; name: string }[];
    const out: { dex: number; name: string }[] = [];
    for (let i = 0; i < POKEDEX_NAMES.length && out.length < PICKER_LIMIT; i++) {
      if (POKEDEX_NAMES[i].toLowerCase().includes(q)) {
        out.push({ dex: i + 1, name: POKEDEX_NAMES[i] });
      }
    }
    return out;
  }, [filter]);

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
      onChange({ sprite_image: url });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  // Preview: custom sprite wins, else the effective dex gif, else nothing.
  const previewSrc = value.sprite_image
    ? resolveImageUrl(value.sprite_image)
    : effectiveDex !== null
      ? spriteGif(effectiveDex)
      : null;

  return (
    <div className="bg-ui-bg-subtle flex flex-col gap-y-3 rounded-lg p-4">
      <Label size="small" weight="plus">
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
            {value.pokemon_dex !== null
              ? `#${value.pokemon_dex} ${effectiveName ?? ''}`
              : suggestion
                ? `Auto: #${suggestion.dex} ${suggestion.name}`
                : 'Unassigned'}
          </Text>
          <Text size="small" className="text-ui-fg-subtle">
            {value.sprite_image
              ? 'Custom sprite uploaded'
              : value.pokemon_dex !== null
                ? 'Showdown gif for the chosen dex'
                : 'Falls back to the card name'}
          </Text>
        </div>
      </div>

      {/* Dex picker — search by name, click to assign */}
      <Input
        placeholder="Search a Pokémon by name to assign…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      {matches.length > 0 && (
        <div className="max-h-44 divide-y overflow-y-auto rounded-lg border">
          {matches.map((m) => (
            <button
              key={m.dex}
              type="button"
              onClick={() => {
                onChange({ pokemon_dex: m.dex });
                setFilter('');
              }}
              className={clx(
                'hover:bg-ui-bg-base-hover flex w-full items-center gap-3 px-4 py-2 text-left',
                value.pokemon_dex === m.dex && 'bg-ui-bg-base-pressed',
              )}
            >
              <img
                src={spriteGif(m.dex)}
                alt=""
                className="h-8 w-8 shrink-0 bg-white object-contain"
              />
              <span className="flex-1 truncate text-sm font-medium">
                #{m.dex} {m.name}
              </span>
            </button>
          ))}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {value.pokemon_dex !== null && (
          <Button
            size="small"
            variant="secondary"
            type="button"
            onClick={() => onChange({ pokemon_dex: null })}
          >
            Clear dex (use name)
          </Button>
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
          onClick={() => fileRef.current?.click()}
          isLoading={uploading}
        >
          Upload custom sprite
        </Button>
        {value.sprite_image && (
          <Button
            size="small"
            variant="transparent"
            type="button"
            onClick={() => onChange({ sprite_image: null })}
          >
            Remove sprite
          </Button>
        )}
      </div>
    </div>
  );
};

export default CardPokemonFields;
