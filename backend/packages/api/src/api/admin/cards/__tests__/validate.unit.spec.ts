import { coerceRegisterCardBody, coerceUpdateCardBody } from '../validate';

// Spec 2 §5: the card forms assign a Pokémon by a PixelPokemon library id (the
// picker), tri-state so the form can round-trip and only send it when changed —
// undefined = picker untouched (leave the link), null = cleared, string = link.
describe('coerceRegisterCardBody — pixel_pokemon_id', () => {
  const base = {
    product_id: 'prod_1',
    set: 'Base',
    grader: 'PSA',
    grade: '10',
    market_value: 100,
  };

  it('accepts a picked library id', () => {
    const out = coerceRegisterCardBody({ ...base, pixel_pokemon_id: 'pp_123' });
    expect(out.pixel_pokemon_id).toBe('pp_123');
  });

  it('is undefined when the field is omitted (picker untouched → inherit)', () => {
    const out = coerceRegisterCardBody(base);
    expect(out.pixel_pokemon_id).toBeUndefined();
  });

  it('is null on an explicit null or blank string (cleared)', () => {
    expect(
      coerceRegisterCardBody({ ...base, pixel_pokemon_id: null }).pixel_pokemon_id,
    ).toBeNull();
    expect(
      coerceRegisterCardBody({ ...base, pixel_pokemon_id: '   ' }).pixel_pokemon_id,
    ).toBeNull();
  });

  it('trims a padded id', () => {
    expect(
      coerceRegisterCardBody({ ...base, pixel_pokemon_id: '  pp_9 ' })
        .pixel_pokemon_id,
    ).toBe('pp_9');
  });

  it('rejects a non-string id with a clear message', () => {
    expect(() =>
      coerceRegisterCardBody({ ...base, pixel_pokemon_id: 123 }),
    ).toThrow(/'pixel_pokemon_id' must be a string/);
  });
});

describe('coerceUpdateCardBody — pixel_pokemon_id', () => {
  const base = {
    name: 'Charizard',
    set: 'Base',
    grader: 'PSA',
    grade: '10',
    market_value: 100,
    image: '/x.png',
    for_sale: true,
  };

  it('round-trips a picked id', () => {
    const out = coerceUpdateCardBody(
      { ...base, pixel_pokemon_id: 'pp_charizard' },
      'charizard',
    );
    expect(out.pixel_pokemon_id).toBe('pp_charizard');
  });

  it('undefined when omitted (a price-only save leaves the link untouched)', () => {
    expect(coerceUpdateCardBody(base, 'charizard').pixel_pokemon_id).toBeUndefined();
  });

  it('null on explicit null (unlink + clear the mirror)', () => {
    expect(
      coerceUpdateCardBody({ ...base, pixel_pokemon_id: null }, 'charizard')
        .pixel_pokemon_id,
    ).toBeNull();
  });
});

// market_multiplier scales the customer-facing price. The client caps display
// margin at 1000% (⇒ stored multiplier 1 + 1000/100 = 11), so the backend
// ceiling is 11: 11 is accepted, anything above is rejected. This keeps the edit
// path's UI guard from being bypassed by a direct API call.
describe('coerceUpdateCardBody — market_multiplier bounds', () => {
  const base = {
    name: 'Charizard',
    set: 'Base',
    grader: 'PSA',
    grade: '10',
    market_value: 100,
    image: '/x.png',
    for_sale: true,
  };

  it('accepts the ceiling multiplier (11)', () => {
    expect(
      coerceUpdateCardBody({ ...base, market_multiplier: 11 }, 'charizard')
        .market_multiplier,
    ).toBe(11);
  });

  it('rejects an over-ceiling multiplier with a clear message', () => {
    expect(() =>
      coerceUpdateCardBody({ ...base, market_multiplier: 12 }, 'charizard'),
    ).toThrow(/'market_multiplier' must be greater than 0 and at most 11/);
  });

  it('rejects a non-positive multiplier', () => {
    expect(() =>
      coerceUpdateCardBody({ ...base, market_multiplier: 0 }, 'charizard'),
    ).toThrow(/'market_multiplier' must be greater than 0/);
  });
});

// Dynamic-label spec §8: label_year / label_note are operator-editable text
// prefilled from pokemontcg.io. Same tri-state contract as optPcId.
describe('label fields', () => {
  const base = {
    product_id: 'prod_1',
    market_value: 10,
  };

  it('passes trimmed label_year / label_note through', () => {
    const out = coerceRegisterCardBody({
      ...base,
      label_year: ' 2024 ',
      label_note: 'SPECIAL ILLUSTRATION RARE',
    });
    expect(out.label_year).toBe('2024');
    expect(out.label_note).toBe('SPECIAL ILLUSTRATION RARE');
  });

  it('maps blank/null to null and absent to undefined', () => {
    expect(
      coerceRegisterCardBody({ ...base, label_year: '' }).label_year,
    ).toBeNull();
    expect(
      coerceRegisterCardBody({ ...base, label_year: null }).label_year,
    ).toBeNull();
    expect(coerceRegisterCardBody(base).label_year).toBeUndefined();
  });

  it('rejects non-strings and over-long values', () => {
    expect(() => coerceRegisterCardBody({ ...base, label_note: 42 })).toThrow();
    expect(() =>
      coerceRegisterCardBody({ ...base, label_note: 'x'.repeat(65) }),
    ).toThrow();
  });
});

// Hardening: grader/grade/set are optional but NOT unbounded — grade/set flow
// into the baked SVG label, so optStr caps them like reqStr.
describe('optional text fields — length cap', () => {
  const base = { product_id: 'prod_1', market_value: 10 };

  it('accepts a trimmed value at the cap', () => {
    const out = coerceRegisterCardBody({
      ...base,
      grader: `  ${'x'.repeat(512)} `,
    });
    expect(out.grader).toBe('x'.repeat(512));
  });

  it('rejects over-cap grader/grade/set with a clear message', () => {
    for (const key of ['grader', 'grade', 'set']) {
      expect(() =>
        coerceRegisterCardBody({ ...base, [key]: 'x'.repeat(513) }),
      ).toThrow(new RegExp(`'${key}' is too long`));
    }
  });
});
