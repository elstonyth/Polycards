import {
  chooseSpriteUrl,
  extractTypes,
  spriteExt,
  type PokeApiPokemon,
} from '../pixel-pokemon-seed.helpers';

const base = (over: Partial<PokeApiPokemon> = {}): PokeApiPokemon => ({
  sprites: { front_default: null, other: {} },
  types: [],
  ...over,
});

describe('chooseSpriteUrl (per-dex fallback chain)', () => {
  test('prefers the animated showdown gif', () => {
    const p = base({
      sprites: {
        front_default: 'https://x/25.png',
        other: { showdown: { front_default: 'https://x/25.gif' } },
      },
    });
    expect(chooseSpriteUrl(p)).toBe('https://x/25.gif');
  });

  test('falls back to the static png when no showdown gif', () => {
    const p = base({
      sprites: {
        front_default: 'https://x/25.png',
        other: { showdown: { front_default: null } },
      },
    });
    expect(chooseSpriteUrl(p)).toBe('https://x/25.png');
  });

  test('null when neither exists', () => {
    expect(chooseSpriteUrl(base())).toBeNull();
  });
});

describe('extractTypes', () => {
  test('capitalizes each type name', () => {
    const p = base({
      types: [{ type: { name: 'fire' } }, { type: { name: 'flying' } }],
    });
    expect(extractTypes(p)).toEqual(['Fire', 'Flying']);
  });
});

describe('spriteExt', () => {
  test('gif vs png from the url', () => {
    expect(spriteExt('https://x/25.gif')).toBe('gif');
    expect(spriteExt('https://x/25.png')).toBe('png');
  });
});
