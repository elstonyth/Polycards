import { describe, expect, it, vi } from 'vitest';
import {
  autoLinkKey,
  entryNumber,
  franchiseFor,
  matchOnePieceEntry,
  onePieceSearchTerm,
  pickerDeck,
} from './sprite-franchise';
import type { PixelPokemonRow } from './admin-rest';

vi.mock('./admin-rest', () => ({ getPixelPokemon: vi.fn() }));

const op = (
  name: string,
  number: number,
  over: Partial<PixelPokemonRow> = {},
): PixelPokemonRow => ({
  id: `op_${number}_${over.variant ?? 'normal'}`,
  name,
  dex: null,
  franchise: 'one-piece',
  number,
  variant: 'normal',
  types: ['One Piece'],
  image_url: `https://cdn/${number}.gif`,
  is_custom: true,
  ...over,
});

const ROWS = [
  op('Monkey D. Luffy', 1),
  op('Monkey D. Luffy (Gear 5)', 1, { variant: 'gear-5' }),
  op('Monkey D. Luffy (Gear 4)', 1, { variant: 'gear-4' }),
  op('Monkey D. Luffy (Wano)', 1, { variant: 'wano' }),
  op('Roronoa Zoro (Wano)', 2, { variant: 'wano' }),
  op('Portgas D. Ace', 13),
  op('Nefertari Vivi', 30),
  op('Monkey D. Garp', 45),
  op('Kaidou', 21),
  op('Trafalgar D. Water Law', 44),
  op('King', 22),
  op('Bartholomew Kuma', 42),
];

describe('franchiseFor', () => {
  it('sends One Piece sets / card codes to the One Piece deck', () => {
    expect(franchiseFor('One Piece Romance Dawn')).toBe('one-piece');
    expect(franchiseFor('', 'Monkey.D.Luffy OP05-119')).toBe('one-piece');
    expect(franchiseFor('Starter Deck', 'Roronoa Zoro ST01-001')).toBe(
      'one-piece',
    );
    expect(franchiseFor('Extra Booster', 'Uta EB01-012')).toBe('one-piece');
    expect(franchiseFor('Premium Booster', 'Nami PRB01-001')).toBe('one-piece');
  });
  it('keeps everything else Pokémon', () => {
    expect(franchiseFor('Pokemon Base Set', 'Charizard #4')).toBe('pokemon');
    expect(franchiseFor(null, undefined)).toBe('pokemon');
    // word-bounded: "onepieces"-style run-ons and stray OP text don't flip it
    expect(franchiseFor('Pokemon Onepiecestyle Promo')).toBe('pokemon');
    expect(franchiseFor('Pokemon Promo', 'Charizard OP Rare')).toBe('pokemon');
  });
  it('reads hyphenated set names and codes glued to a suffix', () => {
    expect(franchiseFor('One-Piece Romance Dawn')).toBe('one-piece');
    expect(franchiseFor('', 'Monkey.D.Luffy OP05-119_p1')).toBe('one-piece');
    // a longer number is not a card code
    expect(franchiseFor('', 'Charizard OP05-1190')).toBe('pokemon');
  });
});

describe('pickerDeck', () => {
  it('keeps the operator’s deck only for the card it was chosen on', () => {
    const chosen = { deck: 'one-piece' as const, hint: 'Set A|Card A' };
    expect(pickerDeck(chosen, 'Set A|Card A', 'pokemon')).toBe('one-piece');
    // the register modal moved on to another product: back to its own deck
    expect(pickerDeck(chosen, 'Set B|Card B', 'pokemon')).toBe('pokemon');
    expect(pickerDeck(null, 'Set A|Card A', 'one-piece')).toBe('one-piece');
  });
});

describe('autoLinkKey', () => {
  const base = {
    name: 'Bartholomew Kuma OP07-079',
    linked: false,
    manualDeck: false,
    clearedFor: null,
    deck: 'one-piece' as const,
  };
  it('auto-links once per deck + name in the card’s own deck', () => {
    expect(autoLinkKey(base)).toBe('one-piece:Bartholomew Kuma OP07-079');
  });
  it('never over an explicit link, a hand-picked deck, or a cleared link', () => {
    expect(autoLinkKey({ ...base, linked: true })).toBeNull();
    // the operator switched decks to browse: Kuma must not become Mew
    expect(autoLinkKey({ ...base, manualDeck: true })).toBeNull();
    expect(autoLinkKey({ ...base, clearedFor: base.name })).toBeNull();
    expect(autoLinkKey({ ...base, name: '' })).toBeNull();
  });
});

describe('onePieceSearchTerm', () => {
  it('turns TCG spellings into the library name', () => {
    expect(onePieceSearchTerm('Big Mom')).toBe('Charlotte Linlin');
    expect(onePieceSearchTerm('trafalgar law')).toBe('Trafalgar D. Water Law');
    expect(onePieceSearchTerm('whiteb')).toBe('Edward Newgate');
  });
  it('searches anything else as typed', () => {
    expect(onePieceSearchTerm('Luffy')).toBe('Luffy');
    expect(onePieceSearchTerm('Bi')).toBe('Bi');
  });
});

describe('matchOnePieceEntry', () => {
  it('links a TCG title to the character’s BASE sprite, not a variant', () => {
    expect(
      matchOnePieceEntry('Monkey.D.Luffy [Alternate Art] OP05-119', ROWS)?.id,
    ).toBe('op_1_normal');
  });
  it('tells characters with a shared prefix apart', () => {
    expect(matchOnePieceEntry('Monkey.D.Garp OP02-002', ROWS)?.number).toBe(45);
  });
  it('knows the TCG spellings (Kaido, Trafalgar Law)', () => {
    expect(matchOnePieceEntry('Kaido OP04-044', ROWS)?.number).toBe(21);
    expect(matchOnePieceEntry('Trafalgar Law ST02-009', ROWS)?.number).toBe(44);
  });
  it('matches whole words only — "King" does not hit "Kingdew"', () => {
    expect(matchOnePieceEntry('Kingdew OP99-001', ROWS)).toBeNull();
    expect(matchOnePieceEntry('King OP04-019', ROWS)?.number).toBe(22);
  });
  it('prefers the character’s variant named in the title', () => {
    expect(
      matchOnePieceEntry('Monkey.D.Luffy [Gear 5] OP05-119', ROWS)?.id,
    ).toBe('op_1_gear-5');
    expect(
      matchOnePieceEntry('Monkey.D.Luffy (Wano Country) OP06-001', ROWS)?.id,
    ).toBe('op_1_wano');
    // another character's variant never wins
    expect(matchOnePieceEntry('Roronoa Zoro (Wano) OP06-118', ROWS)).toBeNull();
  });
  it('two characters in one title is no match', () => {
    expect(
      matchOnePieceEntry('Monkey.D.Luffy & Portgas.D.Ace OP02-013', ROWS),
    ).toBeNull();
  });
  it('knows the TCG spelling Nefeltari Vivi', () => {
    expect(matchOnePieceEntry('Nefeltari Vivi OP01-003', ROWS)?.number).toBe(
      30,
    );
  });
  it('never matches a Pokémon name hidden in the title (Kuma is not Mew)', () => {
    expect(matchOnePieceEntry('Bartholomew Kuma OP07-079', ROWS)?.number).toBe(
      42,
    );
    expect(matchOnePieceEntry('Mew #151', ROWS)).toBeNull();
  });
});

describe('entryNumber', () => {
  it('shows each deck’s own number', () => {
    expect(entryNumber({ franchise: 'pokemon', dex: 25, number: null })).toBe(
      '#025',
    );
    expect(entryNumber({ franchise: 'one-piece', dex: null, number: 1 })).toBe(
      'OP #001',
    );
    expect(
      entryNumber({ franchise: 'one-piece', dex: null, number: null }),
    ).toBe('');
  });
});
