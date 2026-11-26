import { labelLines } from '../label';
import { onePieceLabel } from '../one-piece-label';

// Every case is a REAL PSA 10 slab (eBay listing photo, read 2026-10-25) and
// the card's REAL PriceCharting name + console-name (via the admin proxy). The
// label must come out exactly as PSA printed it. Cert numbers where visible.
type Case = [cert: string, pcName: string, pcSet: string, left: string[], number: string];

const CASES: Case[] = [
  // --- English boosters
  ['168858816', 'Monkey.D.Luffy [Alternate Art] OP01-024', 'One Piece Romance Dawn', ['2022 ONE PIECE OP01 EN', 'MONKEY D. LUFFY', 'ALTERNATE ART'], '#024'],
  ['168979127', 'Shanks [Alternate Art] OP01-120', 'One Piece Romance Dawn', ['2022 ONE PIECE OP01 EN', 'SHANKS', 'ALTERNATE ART'], '#120'],
  ['137419797', 'Kaido [Alternate Art Errata] OP01-061', 'One Piece Romance Dawn', ['2022 ONE PIECE OP01 EN', 'KAIDO', 'ALTERNATE ART-ERRATA'], '#061'],
  ['164678061', 'Donquixote Doflamingo [Alternate Art] OP01-060', 'One Piece Romance Dawn', ['2022 ONE PIECE OP01 EN', 'DONQUIXOTE DOFLAMINGO', 'ALTERNATE ART'], '#060'],
  ['157473531', 'Portgas.D.Ace [Alternate Art] OP02-013', 'One Piece Paramount War', ['2023 ONE PIECE OP02 EN', 'PORTGAS D. ACE', 'ALTERNATE ART'], '#013'],
  ['161294290', 'Nefeltari Vivi [Alt Art] OP04-118', 'One Piece Kingdoms of Intrigue', ['2023 ONE PIECE OP04 EN', 'NEFELTARI VIVI', 'ALTERNATE ART'], '#118'],
  ['161508846', 'Monkey.D.Luffy OP05-119', 'One Piece Awakening of the New Era', ['2023 ONE PIECE OP05 EN', 'MONKEY D. LUFFY', ''], '#119'],
  ['154586047', 'Enel [SP] OP05-100', 'One Piece Awakening of the New Era', ['2023 ONE PIECE OP05 EN', 'ENEL', 'SPECIAL ALTERNATE ART'], '#100'],
  ['152131695', 'Monkey.D.Luffy [Alternate Art] OP06-013', 'One Piece Wings of the Captain', ['2024 ONE PIECE OP06 EN', 'MONKEY D. LUFFY', 'ALTERNATE ART'], '#013'],
  ['161347010', 'Roronoa Zoro OP06-118', 'One Piece Wings of the Captain', ['2024 ONE PIECE OP06 EN', 'RORONOA ZORO', ''], '#118'],
  ['148254266', 'Vegapunk [Alternate Art] OP07-097', 'One Piece 500 Years in the Future', ['2024 ONE PIECE OP07 EN', 'VEGAPUNK', 'ALTERNATE ART'], '#097'],
  ['161237240', 'Gol.D.Roger [Alternate Art] OP09-118', 'One Piece Emperors in the New World', ['2024 ONE PIECE OP09 EN', 'GOL D. ROGER', 'ALTERNATE ART'], '#118'],
  ['166574123', 'Monkey.D.Luffy [Alternate Art] OP10-118', 'One Piece Royal Blood', ['2025 ONE PIECE OP10 EN', 'MONKEY D. LUFFY', 'ALTERNATE ART'], '#118'],
  ['168391843', 'Monkey.D.Luffy OP11-118', 'One Piece Fist of Divine Speed', ['2025 ONE PIECE OP11 EN', 'MONKEY D. LUFFY', ''], '#118'],
  ['171761178', 'Lightning Dragon [Alternate Art] OP15-077', "One Piece Adventure on Kami's Island", ['2026 ONE PIECE OP15-EB04 EN', 'LIGHTNING DRAGON', 'ALTERNATE ART'], '#077'],
  // --- reprints PriceCharting files under the box they came out of
  ['129469978', 'Luffy-Tarou [SP] ST18-005', 'One Piece Fist of Divine Speed', ['2025 ONE PIECE OP11 EN', 'LUFFY-TAROU', 'SPECIAL ALTERNATE ART'], '#005'],
  ['174657126', 'Dracule Mihawk [SP] OP12-030', "One Piece Azure Sea's Seven", ['2026 ONE PIECE OP14-EB04 EN', 'DRACULE MIHAWK', 'SPECIAL ALTERNATE ART'], '#030'],
  ['176409551', 'Ms. All Sunday [SP Foil] OP14-084', 'One Piece The Time of Battle', ['2026 ONE PIECE OP16 EN', 'MS. ALL SUNDAY', 'SPECIAL ALTERNATE ART'], '#084'],
  ['164564317', 'Donquixote Rosinante OP05-022', 'One Piece Extra Booster Anime 25th Collection', ['2025 ONE PIECE EB02 EN', 'DONQUIXOTE ROSINANTE', 'SPECIAL'], '#022'],
  // --- reprints PriceCharting files under the ORIGINAL set (Limitless list)
  ['123824985', 'Donquixote Doflamingo [SP] OP01-073', 'One Piece Romance Dawn', ['2024 ONE PIECE OP07 EN', 'DONQUIXOTE DOFLAMINGO', 'SPECIAL ALTERNATE ART'], '#073'],
  ['165018911', 'Portgas.D.Ace [SP] OP02-013', 'One Piece Paramount War', ['2024 ONE PIECE OP08 EN', 'PORTGAS D. ACE', 'SPECIAL ALTERNATE ART'], '#013'],
  ['143928933', 'Monkey.D.Luffy [Treasure Rare] OP07-109', 'One Piece 500 Years in the Future', ['2024 ONE PIECE OP08 EN', 'MONKEY D. LUFFY', 'TREASURE RARE'], '#109'],
  ['161893134', 'Jewelry Bonney [SP Foil] ST02-007', 'One Piece Starter Deck 2: Worst Generation', ['2024 ONE PIECE OP08 EN', 'JEWELRY BONNEY', 'SPECIAL ALTERNATE ART'], '#007'],
  ['153017919', 'Rob Lucci [SP] OP05-093', 'One Piece Awakening of the New Era', ['2024 ONE PIECE OP09 EN', 'ROB LUCCI', 'SPECIAL ALTERNATE ART'], '#093'],
  ['167615981', 'Zoro-Juurou [SP Foil] OP05-067', 'One Piece Awakening of the New Era', ['2024 ONE PIECE OP09 EN', 'ZORO-JUUROU', 'SPECIAL ALTERNATE ART'], '#067'],
  ['107989941', 'Monkey.D.Luffy [Wanted] OP05-119', 'One Piece Awakening of the New Era', ['2024 ONE PIECE OP09 EN', 'MONKEY D. LUFFY', 'WANTED ALTERNATE ART'], '#119'],
  ['170355125', 'Kaido [Wanted] ST04-003', 'One Piece Starter Deck 4: Animal Kingdom Pirates', ['2023 ONE PIECE OP03 EN', 'KAIDO', 'WANTED ALTERNATE ART'], '#003'],
  ['160405784', 'Edward.Newgate [SP] ST15-002', 'One Piece Starter Deck 15: Edward Newgate', ['2025 ONE PIECE OP10 EN', 'EDWARD NEWGATE', 'SPECIAL ALTERNATE ART'], '#002'],
  // --- the box code is in the bracket
  ['165559351', 'Portgas.D.Ace [Manga PRB01] OP02-013', 'One Piece Paramount War', ['2024 ONE PIECE PRB01 EN', 'PORTGAS D. ACE', 'MANGA ALTERNATE ART'], '#013'],
  ['162367806', 'Shanks [Manga PRB01] OP01-120', 'One Piece Romance Dawn', ['2024 ONE PIECE PRB01 EN', 'SHANKS', 'MANGA ALTERNATE ART'], '#120'],
  ['165835744', 'Rebecca [SP PRB-02] OP05-091', 'One Piece Premium Booster 2', ['2025 ONE PIECE PRB02 EN', 'REBECCA', 'SPECIAL ALTERNATE ART'], '#091'],
  // --- extra boosters and starter decks
  ['157475597', 'Laboon [Alternate Art] EB01-048', 'One Piece Extra Booster Memorial Collection', ['2024 ONE PIECE EB01 EN', 'LABOON', 'ALTERNATE ART'], '#048'],
  ['150627508', 'Hannyabal [Alternate Art] EB01-021', 'One Piece Extra Booster Memorial Collection', ['2024 ONE PIECE EB01 EN', 'HANNYABAL', 'ALTERNATE ART'], '#021'],
  ['165463221', 'Perona [SP] EB03-045', 'One Piece Extra Booster Heroines Edition', ['2026 ONE PIECE EB03 EN', 'PERONA', 'SPECIAL ALTERNATE ART'], '#045'],
  ['165922168', 'Monkey.D.Luffy ST01-012', 'One Piece Starter Deck 1: Straw Hat Crew', ['2022 ONE PIECE ST01 EN', 'MONKEY D. LUFFY', ''], '#012'],
  ['162553499', 'Monkey.D.Luffy [Errata] ST01-001', 'One Piece Starter Deck 1: Straw Hat Crew', ['2022 ONE PIECE ST01 EN', 'MONKEY D. LUFFY', 'ERRATA'], '#001'],
  ['155704783', 'Nico Robin [Super Pre-release] ST01-008', 'One Piece Starter Deck 1: Straw Hat Crew', ['2022 ONE PIECE ST01 EN', 'NICO ROBIN', 'SUPER PRE-RELEASE'], '#008'],
  // --- Japanese
  ['(masked)', 'Sanji [Alternate Art] OP02-026', 'One Piece Japanese Paramount War', ['2022 ONE PIECE OP02 JP', 'SANJI', 'ALTERNATE ART'], '#026'],
  ['(masked)', 'Buggy [SP] OP03-008', 'One Piece Japanese Pillars of Strength', ['2023 ONE PIECE OP06 JP', 'BUGGY', 'SPECIAL ALTERNATE ART'], '#008'],
  ['151228566', 'Kaido & Linlin OP08-119', 'One Piece Japanese Two Legends', ['2024 ONE PIECE OP08 JP', 'KAIDO & LINLIN', ''], '#119'],
  ['(masked)', 'Nami [SP Foil] OP08-106', 'One Piece Japanese Two Legends', ['2024 ONE PIECE OP09 JP', 'NAMI', 'SPECIAL ALTERNATE ART'], '#106'],
  ['165922172', 'Shanks [Wanted Poster] OP09-004', 'One Piece Japanese Emperors in the New World', ['2024 ONE PIECE OP09 JP', 'SHANKS', 'WANTED ALTERNATE ART'], '#004'],
  ['(masked)', 'Monkey.D.Luffy [Alternate Art] OP10-118', 'One Piece Japanese Royal Blood', ['2024 ONE PIECE OP10 JP', 'MONKEY D. LUFFY', 'ALTERNATE ART'], '#118'],
  ['(masked)', 'Nami [Alternate Art] OP11-041', 'One Piece Japanese Fist of Divine Speed', ['2025 ONE PIECE OP11 JP', 'NAMI', 'ALTERNATE ART'], '#041'],
  ['167949328', 'Monkey.D.Luffy [PRB01] OP05-119', 'One Piece Japanese Awakening of the New Era', ['2024 ONE PIECE PRB01 JP', 'MONKEY D. LUFFY', ''], '#119'],
  // --- Japanese boxes whose year was missing (read 2026-11-26, label photos)
  ['109725416', 'Nami [Alternate Art] OP03-040', 'One Piece Japanese Pillars of Strength', ['2023 ONE PIECE OP03 JP', 'NAMI', 'ALTERNATE ART'], '#040'],
  ['132209275', 'Jewelry Bonney [Manga] OP12-118', 'One Piece Japanese Legacy of the Master', ['2025 ONE PIECE OP12 JP', 'JEWELRY BONNEY', 'MANGA ALTERNATE ART'], '#118'],
  ['153851894', 'Boa Hancock [Alternate Art] OP12-014', 'One Piece Japanese Legacy of the Master', ['2025 ONE PIECE OP12 JP', 'BOA HANCOCK', 'ALTERNATE ART'], '#014'],
  ['(masked)', 'Portgas.D.Ace [SP] EB02-028', 'One Piece Japanese Carrying on His Will', ['2025 ONE PIECE OP13 JP', 'PORTGAS D. ACE', 'SPECIAL ALTERNATE ART'], '#028'],
  ['143857026', 'Boa Hancock [SP] OP14-112', "One Piece Japanese Azure Sea's Seven", ['2025 ONE PIECE OP14 JP', 'BOA HANCOCK', 'SPECIAL ALTERNATE ART'], '#112'],
  ['(masked)', 'Enel [Manga] OP15-118', "One Piece Japanese Adventure on Kami's Island", ['2026 ONE PIECE OP15 JP', 'ENEL', 'MANGA ALTERNATE ART'], '#118'],
  ['163557203', 'Monkey.D.Luffy [Alternate Art] OP16-022', 'One Piece Japanese The Time of Battle', ['2026 ONE PIECE OP16 JP', 'MONKEY D. LUFFY', 'ALTERNATE ART'], '#022'],
  ['(masked)', 'Shanks [Manga] OP17-022', "One Piece Japanese World's Strongest Warriors", ['2026 ONE PIECE OP17 JP', 'SHANKS', 'MANGA ALTERNATE ART'], '#022'],
  ['153608459', 'Mr.2.Bon.Kurei(Bentham) [Alternate Art] EB01-061', 'One Piece Japanese Extra Booster Memorial Collection', ['2024 ONE PIECE EB01 JP', 'MR. 2 BON CLAY', 'ALTERNATE ART'], '#061'],
  ['115536799', 'Brook [Alternate Art] EB02-048', 'One Piece Japanese Extra Booster Anime 25th Collection', ['2025 ONE PIECE EB02 JP', 'BROOK', 'ALTERNATE ART'], '#048'],
  ['(masked)', 'Boa Hancock [SP] OP07-038', 'One Piece Japanese Extra Booster Anime 25th Collection', ['2025 ONE PIECE EB02 JP', 'BOA HANCOCK', 'SPECIAL'], '#038'],
  ['167127573', 'Kikunojo [Alternate Art] EB04-012', 'One Piece Japanese Extra Booster Egghead Crisis', ['2026 ONE PIECE EB04 JP', 'KIKUNOJO', 'ALTERNATE ART'], '#012'],
  ['(masked)', 'Monkey.D.Luffy [3rd Anniversary Gold] OP11-119', 'One Piece Japanese Fist of Divine Speed', ['2025 ONE PIECE OP11 JP', 'MONKEY D. LUFFY', '3RD ANNIVERSARY-GOLD'], '#119'],
  // --- English boxes and names added 2026-11-26
  ['179988487', 'Monkey.D.Luffy [SP] ST31-004', "One Piece World's Strongest Warriors", ['2026 ONE PIECE OP17 EN', 'MONKEY D. LUFFY', 'SPECIAL ALTERNATE ART'], '#004'],
  ['109463159', 'Edward.Newgate ST15-001', 'One Piece Starter Deck 15: Edward Newgate', ['2024 ONE PIECE ST15 EN', 'EDWARD NEWGATE', ''], '#001'],
  ['148140147', 'Mr.2.Bon.Kurei(Bentham) [Alternate Art] EB01-061', 'One Piece Extra Booster Memorial Collection', ['2024 ONE PIECE EB01 EN', 'MR. 2 BON CLAY', 'ALTERNATE ART'], '#061'],
];

// Promo / event prints (read 2026-11-26): PSA prints "<year> ONE PIECE EN|JP"
// and the event as the variety. The event year is not derivable, so it comes
// from the card's label year; PSA's own event wording (its hyphens and
// abbreviations) comes from the label note when it differs from PriceCharting's.
type PromoCase = [cert: string, pcName: string, pcSet: string, year: string, note: string | null, left: string[], number: string];

const PROMO_CASES: PromoCase[] = [
  ['172653222', 'Monkey.D.Luffy [OP16 Release Event Winner] P-135', 'One Piece Promo', '2026', 'OP16 RELEASE EVENT-WINNER', ['2026 ONE PIECE EN', 'MONKEY D. LUFFY', 'OP16 RELEASE EVENT-WINNER'], '#135'],
  ['148696172', 'Trafalgar Law [Championship Event Pack] ST03-008', 'One Piece Promo', '2024', null, ['2024 ONE PIECE EN', 'TRAFALGAR LAW', 'CHAMPIONSHIP EVENT PACK'], '#008'],
  ['156604108', 'Monkey.D.Luffy [Illustration Box Vol.3] OP07-109', 'One Piece Promo', '2025', null, ['2025 ONE PIECE EN', 'MONKEY D. LUFFY', 'ILLUSTRATION BOX VOL.3'], '#109'],
  ['144054482', 'Roronoa Zoro [Treasure Cup Top Prize] ST12-008', 'One Piece Promo', '2024', 'TREASURE CUP-TOP PRIZE', ['2024 ONE PIECE EN', 'RORONOA ZORO', 'TREASURE CUP-TOP PRIZE'], '#008'],
  ['156101387', 'Monkey.D.Luffy [2nd Anniversary Set] ST13-015', 'One Piece Japanese Promo', '2024', null, ['2024 ONE PIECE JP', 'MONKEY D. LUFFY', '2ND ANNIVERSARY SET'], '#015'],
  ['134661995', 'Monkey.D.Luffy [One Piece Magazine Vol.20] ST21-014', 'One Piece Japanese Promo', '2025', null, ['2025 ONE PIECE JP', 'MONKEY D. LUFFY', 'ONE PIECE MAGAZINE VOL.20'], '#014'],
  ['(masked)', 'Monkey.D.Luffy [Official Event Top Prize] ST21-014', 'One Piece Japanese Promo', '2025', null, ['2025 ONE PIECE JP', 'MONKEY D. LUFFY', 'OFFICIAL EVENT TOP PRIZE'], '#014'],
  ['(masked)', 'Roronoa Zoro [Official Event Prize] ST21-015', 'One Piece Japanese Promo', '2025', null, ['2025 ONE PIECE JP', 'RORONOA ZORO', 'OFFICIAL EVENT PRIZE'], '#015'],
  ['152236762', 'Monkey.D.Luffy [Weekly Shonen Jump Jan] ST01-001', 'One Piece Japanese Promo', '2023', 'WEEKLY SHONEN JUMP-JAN', ['2023 ONE PIECE JP', 'MONKEY D. LUFFY', 'WEEKLY SHONEN JUMP-JAN'], '#001'],
];

describe('One Piece labels match the real PSA 10 slabs', () => {
  it.each(CASES)('cert %s: %s (%s)', (_cert, name, set, left, number) => {
    expect(labelLines({ name, set, grade: '10' })).toEqual({
      left,
      right: [number, 'GEM MT', '10'],
    });
  });
});

describe('One Piece promo / event labels match the real PSA 10 slabs', () => {
  it.each(PROMO_CASES)('cert %s: %s (%s)', (_cert, name, set, year, note, left, number) => {
    expect(labelLines({ name, set, grade: '10', year, note })).toEqual({
      left,
      right: [number, 'GEM MT', '10'],
    });
  });
});

describe('One Piece label rules', () => {
  it("the card's own label year / note win over the derived ones", () => {
    expect(
      labelLines({
        name: 'Monkey.D.Luffy [SP Gold] OP05-119',
        set: 'One Piece Fist of Divine Speed',
        grade: '10',
        year: '2025',
        note: 'SPECIAL ALTERNATE ART-GOLD',
      }).left,
    ).toEqual(['2025 ONE PIECE OP11 EN', 'MONKEY D. LUFFY', 'SPECIAL ALTERNATE ART-GOLD']);
  });

  it('a typed "Name #OP01-120" prints the number without the set code', () => {
    expect(
      labelLines({ name: 'Shanks #OP01-120', set: 'One Piece Romance Dawn', grade: '10' }).right[0],
    ).toBe('#120');
  });

  it('unverified wording stays as PriceCharting wrote it — never invented', () => {
    // SP Gold: the box is known (OP11), PSA's wording for gold isn't.
    expect(
      onePieceLabel({ name: 'Monkey.D.Luffy [SP Gold] OP05-119', set: 'One Piece Fist of Divine Speed' }),
    ).toEqual({
      setLine: 'ONE PIECE OP11 EN',
      year: '2025',
      name: 'MONKEY D. LUFFY',
      number: '#119',
      variety: 'SP GOLD',
    });
  });

  it('an event / prize print names the language, not a box, and invents no year (172653222, 156101387)', () => {
    expect(
      onePieceLabel({ name: 'Monkey.D.Luffy [Serial Prize] ST01-001', set: 'One Piece Starter Deck 1: Straw Hat Crew' }),
    ).toEqual({
      setLine: 'ONE PIECE EN',
      year: '',
      name: 'MONKEY D. LUFFY',
      number: '#001',
      variety: 'SERIAL PRIZE',
    });
  });

  it("a box without a verified year prints no year (the card's label year fills it)", () => {
    expect(
      labelLines({ name: 'Monkey.D.Luffy [Alternate Art] OP07-119', set: 'One Piece Japanese 500 Years in the Future', grade: '10' }).left[0],
    ).toBe('ONE PIECE OP07 JP');
  });

  it('Japanese EB04 stays its own box (only English bundles it into OP14/OP15)', () => {
    expect(
      onePieceLabel({ name: 'Roronoa Zoro [Alternate Art] EB04-007', set: 'One Piece Japanese Extra Booster Egghead Crisis' })?.setLine,
    ).toBe('ONE PIECE EB04 JP');
    expect(
      onePieceLabel({ name: 'Roronoa Zoro [Alternate Art] EB04-007', set: 'One Piece Extra Booster EB04' })?.setLine,
    ).toBe('ONE PIECE OP15-EB04 EN');
  });

  it('a promo P-code prints as the number, never in the name (172653222)', () => {
    expect(onePieceLabel({ name: 'Monkey.D.Luffy P-135', set: 'One Piece Promo' })).toMatchObject({
      name: 'MONKEY D. LUFFY',
      number: '#135',
    });
    expect(labelLines({ name: 'Monkey.D.Luffy #P-135', set: 'One Piece Promo', grade: '10' }).right[0]).toBe('#135');
  });

  it('ST21 EN has its verified year (147492294)', () => {
    expect(onePieceLabel({ name: 'Monkey.D.Luffy ST21-001', set: 'One Piece Starter Deck EX 21: Gear 5' })).toMatchObject({
      setLine: 'ONE PIECE ST21 EN',
      year: '2025',
    });
  });

  it('names PSA spells its own way: MR. 2 BON CLAY (148140147), KOZUKI (photo 080)', () => {
    expect(onePieceLabel({ name: 'Mr.2.Bon.Kurei [Alternate Art] EB01-061', set: 'One Piece Extra Booster Memorial Collection' })?.name).toBe('MR. 2 BON CLAY');
    expect(onePieceLabel({ name: 'Kouzuki Oden [Alternate Art] EB02-001', set: 'One Piece Japanese Extra Booster Anime 25th Collection' })?.name).toBe('KOZUKI ODEN');
  });

  it('a dotted name with a one-character part keeps every space, and MR. keeps its period (rule, no cert)', () => {
    expect(onePieceLabel({ name: 'Mr.3.Galdino OP01-001', set: 'One Piece Romance Dawn' })?.name).toBe('MR. 3 GALDINO');
    expect(onePieceLabel({ name: 'Ms. All Sunday OP14-084', set: 'One Piece The Time of Battle' })?.name).toBe('MS. ALL SUNDAY');
  });

  it('leaves every other franchise alone', () => {
    expect(onePieceLabel({ name: 'Pikachu ex #238', set: 'Pokemon Surging Sparks' })).toBeNull();
    expect(labelLines({ name: 'Pikachu ex #238', set: 'Pokemon Surging Sparks', grade: '10' })).toEqual({
      left: ['POKEMON SSP EN', 'PIKACHU ex', ''],
      right: ['#238', 'GEM MT', '10'],
    });
  });
});
