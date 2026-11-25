import { labelLines } from '../label';
import { pokemonLabel } from '../pokemon-label';

// Expected text = the real PSA certificate (cert number in each name), read on
// psacard.com/cert 2026-11-25. All 211 certs read reproduce through
// docs/research/slab-case/check-pokemon-label.ts; these cover each rule.
const lines = (set: string, name: string) =>
  labelLines({ set, name, grade: '10' }).left;

describe('pokemonLabel', () => {
  it('modern Japanese: code line, padded number, rarity by range, ex lower case', () => {
    // cert 137543746
    expect(lines('Pokemon Japanese Black Bolt', 'Zekrom Ex #169')).toEqual([
      '2025 POKEMON SV11B JP',
      'ZEKROM ex',
      'SPECIAL ART RARE',
    ]);
    expect(
      pokemonLabel({ set: 'Pokemon Japanese Black Bolt', name: 'Snivy #87' }),
    ).toMatchObject({
      number: '#087',
      variety: 'ART RARE',
    });
  });

  it('fills numbers we do not own from the set list', () => {
    // White Flare 165 is a Super Rare in PSA's list; none of ours
    expect(
      pokemonLabel({
        set: 'Pokemon Japanese White Flare',
        name: 'Anything ex #165',
      })?.variety,
    ).toBe('SUPER RARE');
  });

  it('Master Ball bracket is the variety', () => {
    // cert 142352792
    expect(
      lines('Pokemon Japanese Black Bolt', 'Simisage [Master Ball] #5'),
    ).toEqual([
      '2025 POKEMON SV11B JP',
      'SIMISAGE',
      'MASTER BALL REVERSE HOLO',
    ]);
  });

  it('Sword & Shield Japanese full art: FA/ prefix, set name as variety', () => {
    // cert 173680690
    expect(lines('Pokemon Japanese VMAX Climax', 'Zekrom #195')).toEqual([
      '2021 POKEMON JPN.SWSH',
      'FA/ZEKROM',
      'VMAX CLIMAX',
    ]);
  });

  it('per-card range wording and FA/', () => {
    // cert 123597688
    expect(
      lines('Pokemon Japanese 25th Anniversary Collection', 'Mew #30'),
    ).toEqual(['2021 POKEMON JAPANESE', 'FA/MEW', '25TH ANNIVERSARY COLL-UR']);
  });

  it('drops FA/ when the variety already says full art', () => {
    // cert 177553220
    expect(
      lines('Pokemon Japanese Tag Bolt', 'Magikarp & Wailord GX #99')[1],
    ).toBe('MAGIKARP & WAILORD GX');
  });

  it('XY-era EX stays upper case', () => {
    // cert 167160581
    expect(
      lines('Pokemon Japanese Phantom Gate', 'Gengar EX [1st Edition] #90'),
    ).toEqual([
      '2014 P.M. JAPANESE XY',
      'FA/GENGAR EX',
      'PHANTOM GATE-1ST ED.',
    ]);
  });

  it('long Team Rocket names lose TEAM', () => {
    // certs 170249265, 153354289
    expect(
      lines(
        'Pokemon Japanese Glory of Team Rocket',
        "Team Rocket's Moltres ex #124",
      )[1],
    ).toBe("ROCKET'S MOLTRES ex");
    expect(
      lines('Pokemon Japanese Mega Dream ex', "Team Rocket's Dugtrio #206")[1],
    ).toBe("TEAM ROCKET'S DUGTRIO");
  });

  it('promo suffix picks the promo line and its year; hand-typed names come from the exceptions', () => {
    // cert 165308463
    expect(
      lines('Pokemon Japanese Promo', 'Poncho-Wearing Pikachu #38/SM-P'),
    ).toEqual([
      '2017 P.M. JPN. SM PROMO',
      'PONCHO-WEAR.PIKACHU',
      'SM A.V/V PIKACHU SPC. BOX',
    ]);
  });

  it('English modern sets keep their own numbers', () => {
    // cert 141592061
    expect(
      labelLines({
        set: 'Pokemon Prismatic Evolutions',
        name: 'Roaring Moon ex #162',
        grade: '10',
      }),
    ).toEqual({
      left: [
        '2025 POKEMON PRE EN',
        'ROARING MOON ex',
        'SPECIAL ILLUSTRATION RARE',
      ],
      right: ['#162', 'GEM MT', '10'],
    });
  });

  it('typed PSA fields still win; unknown sets keep the old fallback', () => {
    expect(
      labelLines({
        set: 'Pokemon Japanese Black Bolt',
        name: 'Zekrom Ex #169',
        grade: '10',
        nameLine: 'ZEKROM EX',
      }).left[1],
    ).toBe('ZEKROM EX');
    expect(
      pokemonLabel({ set: 'Pokemon Made Up Set', name: 'Pikachu #1' }),
    ).toBeNull();
    expect(lines('Pokemon Surging Sparks', 'Pikachu ex #238')[0]).toBe(
      'POKEMON SSP EN',
    );
  });
});
