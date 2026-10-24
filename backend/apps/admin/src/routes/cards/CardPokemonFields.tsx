import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { Button, Input, Label, Text, clx, toast } from '@medusajs/ui';
import { pokemonFromCard, spriteGif } from '@acme/pokemon';
import {
  useUploadImage,
  usePixelPokemon,
  useCreatePixelPokemon,
} from '../../lib/queries';
import { validateImageFile } from '../../lib/image-validation';
import { resolveImageUrl } from '../../lib/image-url';
import type { PixelPokemonRow } from '../../lib/admin-rest';
import {
  autoResolveQuery,
  fetchSeededCandidates,
  matchSeededEntry,
} from '../../lib/pixel-auto-resolve';
import {
  FRANCHISE_LABEL,
  autoLinkKey,
  entryNumber,
  fetchOnePieceRoster,
  franchiseFor,
  matchOnePieceEntry,
  onePieceSearchTerm,
  pickerDeck,
  type SpriteFranchise,
} from '../../lib/sprite-franchise';

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
  /** The card's set ("One Piece Romance Dawn", "Base Set"…) — picks the deck
   *  (Pokémon / One Piece) the picker searches and auto-links from, so a One
   *  Piece card is never offered a Pokémon. The operator can switch it. */
  setName?: string | null;
  /** Namespaces this instance's DOM ids. REQUIRED when more than one picker is
   *  on screen (the bulk collection import renders one per draft): without it
   *  every instance shares `card-pokemon-search`, so clicking any label focuses
   *  the FIRST input and every aria-controls points at the first listbox. */
  idPrefix?: string;
  /** Opt-in (from-PC flows only): while unassigned, derive the species from
   *  this product name and auto-link its seeded normal-variant library entry.
   *  Tried once per name — a manual "Clear link" is never re-overridden. NOT
   *  passed by the card edit modal, where auto-linking on open would silently
   *  mutate an intentionally-unlinked card on save. */
  autoResolveName?: string;
};

const PICKER_LIMIT = 40;

const FRANCHISES: SpriteFranchise[] = ['pokemon', 'one-piece'];

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
  setName,
  idPrefix = 'card',
  autoResolveName,
}: Props) => {
  const searchId = `${idPrefix}-pokemon-search`;
  const listboxId = `${idPrefix}-pokemon-listbox`;
  const [search, setSearch] = useState('');
  // The deck follows the card's set until the operator switches it by hand —
  // and that switch holds only for the card it was made on.
  const hint = `${setName ?? ''}|${autoResolveName ?? suggestionName}`;
  const derived = franchiseFor(setName, autoResolveName ?? suggestionName);
  const [chosen, setChosen] = useState<{
    deck: SpriteFranchise;
    hint: string;
  } | null>(null);
  const franchise = pickerDeck(chosen, hint, derived);
  const manualDeck = chosen?.hint === hint;
  // The entry chosen THIS session — drives the preview once picked. On first
  // load it's null and the preview falls back to the card's mirrored sprite.
  const [picked, setPicked] = useState<PixelPokemonRow | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const uploadImg = useUploadImage();
  const createEntry = useCreatePixelPokemon();
  const uploading = uploadImg.isPending || createEntry.isPending;

  // Escape while typing a search should dismiss the dropdown, NOT close the
  // whole edit modal. The modal's Radix DismissableLayer listens for Escape on
  // `document` in the CAPTURE phase (react-use-escape-keydown, a passive
  // useEffect), which fires before any bubble-phase onKeyDown on the input — so
  // a React stopPropagation can't stop it. Intercept the SAME capture phase:
  // when the search box is focused AND non-empty, stopImmediatePropagation()
  // the Escape and clear the search; an empty search still bubbles through → the
  // modal closes, as the "esc" hint advertises.
  //
  // ⚠️ INVARIANT — this component MUST mount in the same (or an earlier) commit
  // as its Dialog. Capture listeners on `document` fire in REGISTRATION order,
  // and this guard beats Radix's only because passive child effects run before
  // the ancestor DismissableLayer's, so ours registers first. If this picker is
  // ever mounted LAZILY/conditionally AFTER the modal is already open (behind a
  // tab, accordion, "Advanced" section, or a remount), Radix's listener
  // registers first, fires first, and Escape closes the modal again — with NO
  // type error and NO test to catch it. If that becomes necessary, switch to
  // FocusModal.Content's `onEscapeKeyDown={(e)=>{ if (focused&&value) e.preventDefault() }}`
  // (Radix skips dismiss when defaultPrevented), which is order-independent.
  useEffect(() => {
    const onCaptureKeyDown = (e: globalThis.KeyboardEvent) => {
      // Read the live value off the (controlled) input element rather than a
      // ref-mirror, so this mount-once listener sees the current search without
      // a render-time ref write.
      const el = searchRef.current;
      if (
        e.key === 'Escape' &&
        el &&
        document.activeElement === el &&
        el.value !== ''
      ) {
        e.preventDefault();
        e.stopImmediatePropagation();
        setSearch('');
      }
    };
    document.addEventListener('keydown', onCaptureKeyDown, { capture: true });
    return () =>
      document.removeEventListener('keydown', onCaptureKeyDown, {
        capture: true,
      });
  }, []);

  const q = search.trim();
  const { data, isFetching } = usePixelPokemon({
    // One Piece searches understand the TCG spellings ("Big Mom", "Law").
    q: franchise === 'one-piece' ? onePieceSearchTerm(q) : q,
    franchise,
    limit: PICKER_LIMIT,
  });
  // The query keeps the previous page while the next loads — right after a
  // deck switch that's the OTHER deck's rows, so filter them out here.
  const matches =
    q.length >= 1
      ? (data?.pixel_pokemon ?? []).filter((m) => m.franchise === franchise)
      : [];

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
  const pickedNumber = pickedForValue ? entryNumber(pickedForValue) : '';
  const previewLabel = pickedForValue
    ? `${pickedForValue.name}${pickedNumber ? ` · ${pickedNumber}` : ''}${
        pickedForValue.variant !== 'normal'
          ? ` · ${pickedForValue.variant}`
          : ''
      }`
    : linked
      ? 'Linked to a library entry'
      : franchise === 'pokemon'
        ? 'Unassigned — resolves from the card name'
        : 'Unassigned — no sprite until one is linked';

  const select = (e: PixelPokemonRow) => {
    setPicked(e);
    onChange({ pixel_pokemon_id: e.id });
    setSearch('');
  };

  // Auto-resolve (opt-in, from-PC flows): derive the species from the product
  // name and link its seeded entry. Tried once per name — the ref guard means a
  // manual "Clear link" (which flips `linked` back to false) does NOT re-link.
  // onChange rides a latest-ref (not a dep): parents pass inline arrows, and a
  // dep on an ever-new identity would cancel the in-flight fetch on every
  // parent render while autoTried blocks the retry.
  const autoTried = useRef<string | null>(null);
  // The name the operator pressed "Clear link" on — never auto-relinked, even
  // after a deck switch (the per-deck tryKey alone would re-arm it).
  const clearedFor = useRef<string | null>(null);
  // The id auto-link set, so a deck switch can take back ONLY that guess.
  const autoLinked = useRef<string | null>(null);
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });
  useEffect(() => {
    // Auto-link only ever matches in the card's own deck; once the operator
    // switches decks by hand, linking is theirs.
    const tryKey = autoLinkKey({
      name: autoResolveName,
      linked,
      manualDeck,
      clearedFor: clearedFor.current,
      deck: derived,
    });
    if (!tryKey || !autoResolveName || autoTried.current === tryKey) return;
    autoTried.current = tryKey;
    // Each deck matches its own way: Pokémon by the species hidden in the name
    // (dex-keyed, seeded rows), One Piece by the character's whole name.
    const pokemonQ =
      derived === 'pokemon' ? autoResolveQuery(autoResolveName) : null;
    if (derived === 'pokemon' && !pokemonQ) return;
    let stale = false;
    (pokemonQ ? fetchSeededCandidates(pokemonQ) : fetchOnePieceRoster())
      .then((rows) => {
        if (stale) return;
        const entry = pokemonQ
          ? matchSeededEntry(autoResolveName, rows)
          : matchOnePieceEntry(autoResolveName, rows);
        if (entry) {
          autoLinked.current = entry.id;
          setPicked(entry);
          onChangeRef.current({ pixel_pokemon_id: entry.id });
        }
      })
      .catch(() => {}); // best-effort — the operator can still link by hand
    return () => {
      stale = true;
    };
  }, [autoResolveName, linked, derived, manualDeck]);

  const switchDeck = (f: SpriteFranchise) => {
    if (f === franchise) return;
    // A guess made in the other deck is not the operator's pick — drop it.
    if (
      autoLinked.current !== null &&
      value.pixel_pokemon_id === autoLinked.current
    ) {
      autoLinked.current = null;
      setPicked(null);
      onChange({ pixel_pokemon_id: null });
    }
    setChosen({ deck: f, hint });
    setSearch('');
  };

  const clear = () => {
    clearedFor.current = autoResolveName ?? null;
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
        franchise,
        // A Pokémon upload carries its species, so the card keeps a dex
        // fallback (badge + reel) if the uploaded URL ever breaks.
        dex:
          franchise === 'pokemon' ? (pokemonFromCard(name)?.dex ?? null) : null,
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
      <div className="flex items-center justify-between gap-2">
        <Label size="small" weight="plus" htmlFor={searchId}>
          Pixel sprite
        </Label>
        {/* Deck switch — Pokémon and One Piece sprites never mix. */}
        <div role="group" aria-label="Sprite deck" className="flex gap-1">
          {FRANCHISES.map((f) => (
            <Button
              key={f}
              size="small"
              type="button"
              variant={f === franchise ? 'primary' : 'secondary'}
              aria-pressed={f === franchise}
              onClick={() => switchDeck(f)}
            >
              {FRANCHISE_LABEL[f]}
            </Button>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-4">
        {previewSrc ? (
          <img
            src={previewSrc}
            alt=""
            className="border-ui-border-base h-16 w-16 shrink-0 rounded border bg-ui-bg-component object-contain"
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

      {/* Library search — link a card to a PixelPokemon entry by id. Escape is
          guarded by the document capture-phase listener above (not onKeyDown,
          which fires too late to beat Radix's Escape-to-close). */}
      <Input
        ref={searchRef}
        id={searchId}
        placeholder={`Search the ${FRANCHISE_LABEL[franchise]} sprites by name…`}
        aria-label={`Search the ${FRANCHISE_LABEL[franchise]} sprites by name`}
        role="combobox"
        aria-expanded={q.length >= 1}
        aria-controls={listboxId}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      {q.length >= 1 && (
        <div
          id={listboxId}
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
                      className="h-8 w-8 shrink-0 bg-ui-bg-component object-contain"
                    />
                  ) : (
                    <span className="bg-ui-bg-base h-8 w-8 shrink-0 rounded" />
                  )}
                  <span className="flex-1 truncate text-sm font-medium">
                    {m.name}
                    {entryNumber(m) && (
                      <span className="text-ui-fg-subtle">
                        {' '}
                        · {entryNumber(m)}
                      </span>
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
            {franchise === 'pokemon' ? 'Clear link (use name)' : 'Clear link'}
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
