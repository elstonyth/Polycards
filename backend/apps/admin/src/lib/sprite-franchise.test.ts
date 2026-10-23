import { describe, expect, it, vi } from 'vitest';
import {
  entryNumber,
  franchiseFor,
  matchOnePieceEntry,
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
