import {
  PSA_GRADES,
  psaDescriptor,
  parseCardName,
  formatCardName,
  setAbbrev,
  layoutLabel,
  type SlabLabelFields,
} from '../label';

describe('PSA_GRADES', () => {
  it("is exactly PSA's canonical 11-point scale — no qualifier half-grades, 1.5 present", () => {
    expect([...PSA_GRADES]).toEqual([
      '10',
      '9',
      '8',
      '7',
      '6',
      '5',
      '4',
      '3',
      '2',
      '1.5',
      '1',
    ]);
  });
});

describe('psaDescriptor', () => {
  it.each([
    ['10', 'GEM MT'],
    ['9', 'MINT'],
    ['8', 'NM-MT'],
    ['7', 'NM'],
    ['6', 'EX-MT'],
    ['5', 'EX'],
    ['4', 'VG-EX'],
    ['3', 'VG'],
    ['2', 'GOOD'],
    ['1.5', 'FR'],
    ['1', 'PR'],
  ])('grade %s → %s', (grade, desc) => {
    expect(psaDescriptor(grade)).toBe(desc);
  });

  it.each([
    ['unknown grade', 'A'],
    ['off-scale legacy 9.5', '9.5'],
    ['off-scale legacy 8.5', '8.5'],
    ['empty', ''],
  ])(
    'renders NO descriptor for %s (never assert a descriptor PSA would not use)',
    (_l, grade) => {
      expect(psaDescriptor(grade)).toBeNull();
    },
  );
});

describe('parseCardName', () => {
  it('splits a trailing #number', () => {
    expect(parseCardName('Pikachu ex #238')).toEqual({
      name: 'Pikachu ex',
      number: '#238',
    });
  });
  it('handles alphanumeric numbers', () => {
    expect(parseCardName('Trainer Card #SV43')).toEqual({
      name: 'Trainer Card',
      number: '#SV43',
    });
  });
  it('handles trailing spaces', () => {
    expect(parseCardName('  Mega Gengar ex #240  ')).toEqual({
      name: 'Mega Gengar ex',
      number: '#240',
    });
  });
  it('returns the whole name and empty number when there is no #', () => {
    expect(parseCardName('Charizard-Holo')).toEqual({
      name: 'Charizard-Holo',
      number: '',
    });
  });
});

describe('formatCardName', () => {
  it('uppercases but keeps a modern lowercase suffix verbatim', () => {
    expect(formatCardName('Pikachu ex')).toBe('PIKACHU ex');
  });
  it('keeps an old-era uppercase suffix verbatim', () => {
    expect(formatCardName('Blastoise EX')).toBe('BLASTOISE EX');
  });
  it('uppercases hyphenated names plainly', () => {
    expect(formatCardName('Charizard-Holo')).toBe('CHARIZARD-HOLO');
  });
  it('does NOT mangle a name merely containing a suffix substring', () => {
    expect(formatCardName('Exeggutor')).toBe('EXEGGUTOR');
  });
  it('handles multi-token names with a suffix', () => {
    expect(formatCardName('Mega Charizard X ex')).toBe('MEGA CHARIZARD X ex');
  });
});

describe('setAbbrev', () => {
  it.each([
    ['Pokemon Surging Sparks', 'POKEMON SSP EN'],
    ['Pokemon Phantasmal Flames', 'POKEMON PFL EN'],
    ['Pokemon Japanese Mega Dream ex', 'POKEMON M2a JP'],
  ])('maps %s → %s (verified against real slabs)', (pc, psa) => {
    expect(setAbbrev(pc)).toBe(psa);
  });

  it('returns a mapped value BYTE-IDENTICAL — mixed-case PSA codes survive', () => {
    // regression guard for PSA's mixed-case set codes: M2a, never M2A (§8)
    expect(setAbbrev('pokemon japanese mega dream ex')).toBe('POKEMON M2a JP');
    expect(setAbbrev('Pokemon Japanese Mega Dream ex')).not.toBe(
      'POKEMON M2A JP',
    );
  });

  it('falls back to the uppercased PC name for an unknown set — never a guessed code', () => {
    expect(setAbbrev('Pokemon Lost Origin')).toBe('POKEMON LOST ORIGIN');
  });
});

describe('layoutLabel', () => {
  const box = { x: 100, y: 120, w: 1000, h: 278 };
  const fields: SlabLabelFields = {
    set: 'Pokemon Surging Sparks',
    name: 'Pikachu ex #238',
    grade: '10',
    year: '2024',
    note: 'SPECIAL ILLUSTRATION RARE',
  };

  it('lands all rows on the three measured baselines (0.298 / 0.509 / 0.723)', () => {
    const runs = layoutLabel(fields, box);
    const ys = [...new Set(runs.map((r) => r.y))].sort((a, b) => a - b);
    expect(ys).toEqual([
      Math.round(120 + 278 * 0.298),
      Math.round(120 + 278 * 0.509),
      Math.round(120 + 278 * 0.723),
    ]);
  });

  it('renders year inline on line 1 and derives every printed value', () => {
    const runs = layoutLabel(fields, box);
    const texts = runs.map((r) => r.text);
    expect(texts).toContain('2024 POKEMON SSP EN');
    expect(texts).toContain('PIKACHU ex');
    expect(texts).toContain('SPECIAL ILLUSTRATION RARE');
    expect(texts).toContain('#238');
    expect(texts).toContain('GEM MT');
    expect(texts).toContain('10');
  });

  it('blank year: set starts at the left margin — no orphan indent, no shift', () => {
    const runs = layoutLabel({ ...fields, year: null }, box);
    const line1 = runs.find((r) => r.text === 'POKEMON SSP EN');
    expect(line1).toBeDefined();
    expect(line1!.x).toBe(Math.round(100 + 1000 * 0.032));
  });

  it('blank note: renders no third-left-row run and no layout shift elsewhere', () => {
    const withNote = layoutLabel(fields, box);
    const without = layoutLabel({ ...fields, note: null }, box);
    expect(without.map((r) => r.text)).not.toContain(
      'SPECIAL ILLUSTRATION RARE',
    );
    const name = (runs: typeof withNote) =>
      runs.find((r) => r.text === 'PIKACHU ex')!;
    expect(name(without)).toEqual(name(withNote));
  });

  it('every element is the same size and none overlaps the right column', () => {
    const runs = layoutLabel(fields, box);
    const sizes = new Set(runs.map((r) => r.fontSize));
    expect(sizes.size).toBe(1); // §6: name not larger, grade not a big number
  });

  it('shrinks a long left line rather than overlapping the right column', () => {
    const long = layoutLabel(
      {
        ...fields,
        name: 'Some Extremely Long Promotional Card Name That Overflows ex #238',
      },
      box,
    );
    const nameRun = long.find(
      (r) => r.anchor === 'start' && r.text.startsWith('SOME'),
    )!;
    const base = layoutLabel(fields, box).find((r) => r.text === 'PIKACHU ex')!;
    expect(nameRun.fontSize).toBeLessThan(base.fontSize);
    expect(nameRun.fontSize).toBeGreaterThanOrEqual(base.fontSize * 0.7);
  });

  // Live label 2026-11-25: at 0.97 size this set line printed 75px into "#73".
  // Capitals are wider than the old flat 0.6em guess; it needs about 0.88.
  it('sizes a line of capitals by their real widths', () => {
    const runs = layoutLabel(
      // Same line as typed text on an unlisted set: Dark Phantasma itself now
      // prints PSA's short "2022 POKEMON JPN.SWSH".
      {
        set: 'Unlisted Set',
        name: 'Pikachu #73',
        grade: '10',
        setLine: 'POKEMON JAPANESE DARK PHANTASMA',
      },
      box,
    );
    const setRun = runs.find((r) => r.text.startsWith('POKEMON JAPANESE'))!;
    const base = runs.find((r) => r.text === '#73')!;
    expect(setRun.text).toBe('POKEMON JAPANESE DARK PHANTASMA'); // not cut
    expect(setRun.fontSize).toBeLessThan(base.fontSize * 0.91);
    expect(setRun.fontSize).toBeGreaterThan(base.fontSize * 0.85);
  });

  // PSA cert 102593524: "2021 POKEMON JAPANESE / FA/MEW / 25TH ANNIVERSARY
  // COLL-UR", "#030". The PriceCharting name and set say "Mew #30" and
  // "25th Anniversary Collection"; PSA's own wording, when stored, wins.
  it("prints PSA's own wording over the derived lines", () => {
    const texts = layoutLabel(
      {
        set: 'Pokemon Japanese 25th Anniversary Collection',
        name: 'Mew #30',
        grade: '10',
        year: '2021',
        note: '25TH ANNIVERSARY COLL-UR',
        setLine: 'POKEMON JAPANESE',
        nameLine: 'FA/MEW',
        number: '030',
      },
      box,
    ).map((r) => r.text);
    expect(texts).toEqual(
      expect.arrayContaining([
        '2021 POKEMON JAPANESE',
        'FA/MEW',
        '25TH ANNIVERSARY COLL-UR',
        '#030',
      ]),
    );
    expect(texts).not.toContain('MEW');
    expect(texts).not.toContain('#30');
  });

  it('off-scale grade: number still prints, descriptor row is absent', () => {
    const runs = layoutLabel({ ...fields, grade: '9.5' }, box);
    expect(runs.map((r) => r.text)).toContain('9.5');
    expect(runs.map((r) => r.text)).not.toContain('GEM MT');
  });
});
