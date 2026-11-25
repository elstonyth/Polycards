// GENERATED-ONCE TABLE, then kept by hand: PSA label wording per PriceCharting
// set (key = console-name lowercased, plus "|SM-P" style suffix for promos whose
// PriceCharting name carries one). Made 2026-11-25 by
// docs/research/slab-case/gen-pokemon-label.cjs (gitignored) from PSA's records
// for our graded cards; the cert in each comment is that set's newest
// certificate read. Line = PSA's top line read off a real label photo.
// A new set needs a row checked against a real PSA label or cert page.
// prettier-ignore
export type PokemonRange = readonly [from: number, to: number, variety: string, opts?: { fa?: true; year?: string }];
export type PokemonSet = {
  line: string;
  year: string; // '' on promo lines that run over several years
  digitsOnly?: true; // a lettered number ("XY84") is another PSA set: no wording
  pad?: number; // zero-pad plain numbers to this many digits
  exLower?: true; // print "ex" lower case (Scarlet & Violet / Mega era)
  variety?: string; // when no range matches
  fa?: true; // when no range matches: print "FA/" before the name
  ranges?: readonly PokemonRange[];
};

// prettier-ignore
export const POKEMON_SETS: Record<string, PokemonSet> = {
  "pokemon black bolt": { // 1 card, cert 174192577
    line: "POKEMON BLK EN", year: "2025", exLower: true, digitsOnly: true,
    ranges: [
      [87, 155, "ILLUSTRATION RARE"],
      [156, 163, "ULTRA RARE"],
      [164, 170, "SPECIAL ILLUSTRATION RARE"],
    ],
  },
  "pokemon brilliant stars": { line: "POKEMON SWSH", year: "2022", variety: "BRILLIANT STARS", fa: true }, // 1 card, cert 102884468
  "pokemon celestial storm": { line: "POKEMON SUN & MOON", year: "2018" }, // 1 card, cert 177338513
  "pokemon chinese promo|SV-P": { // 1 card, cert 172753317
    line: "POKEMON SV-P CT", year: "2024", exLower: true, digitsOnly: true,
    ranges: [
      [153, 153, "5TH ANNIVERSARY PREMIUM CS"],
    ],
  },
  "pokemon crown zenith": { line: "POKEMON SWSH", year: "2023", variety: "CROWN ZENITH", fa: true }, // 2 cards, cert 161682369
  "pokemon destined rivals": { // 2 cards, cert 120729024
    line: "POKEMON DRI EN", year: "2025", exLower: true, digitsOnly: true,
    ranges: [
      [183, 205, "ILLUSTRATION RARE"],
      [206, 227, "ULTRA RARE"],
      [228, 238, "SPECIAL ILLUSTRATION RARE"],
      [239, 244, "HYPER RARE"],
    ],
  },
  "pokemon evolving skies": { // 4 cards, cert 181469166
    line: "POKEMON SWSH", year: "2021", variety: "EVOLVING SKIES-SECRET", fa: true, digitsOnly: true,
    ranges: [
      [192, 192, "EVOLVING SKIES", { fa: true }],
    ],
  },
  "pokemon expedition": { // 1 card, cert 176044430
    line: "POKEMON EXPEDITION", year: "2002", digitsOnly: true,
    ranges: [
      [20, 20, ""],
    ],
  },
  "pokemon fire red & leaf green": { line: "POKEMON EX", year: "2004", variety: "FIRE RED & LEAF GREEN", digitsOnly: true }, // 1 card, cert 176772246
  "pokemon hidden fates": { line: "POKEMON SUN & MOON", year: "2019", variety: "HIDDEN FATES", fa: true }, // 2 cards, cert 175338134
  "pokemon japanese 1995 combo deck": { // 1 card, cert 109088593
    line: "POKEMON JPN.", year: "2015", pad: 3, digitsOnly: true,
    ranges: [
      [7, 7, "GLDK.BRK/PALKIA EX COMBO"],
    ],
  },
  "pokemon japanese 2005 gift box": { line: "P.M. JPN. GOLD STAR", year: "2005", pad: 3, variety: "GIFT BOX MEW", digitsOnly: true }, // 2 cards, cert 177486105
  "pokemon japanese 20th anniversary": { // 1 card, cert 170433499
    line: "POKEMON JAPANESE", year: "2016", pad: 3, digitsOnly: true,
    ranges: [
      [94, 94, "EXP.20TH ANNIV-1ST ED.", { fa: true }],
    ],
  },
  "pokemon japanese 25th anniversary collection": { // 2 cards, cert 167173825
    line: "POKEMON JAPANESE", year: "2021", pad: 3, digitsOnly: true,
    ranges: [
      [5, 5, "25TH ANNIVERSARY COLL."],
      [30, 30, "25TH ANNIVERSARY COLL-UR", { fa: true }],
    ],
  },
  "pokemon japanese 25th anniversary promo": { // 3 cards, cert 159363693
    line: "POKEMON JAPANESE", year: "2021", pad: 3, digitsOnly: true,
    ranges: [
      [1, 1, "CHRZRD-HL-PCP 25TH AN."],
      [7, 7, "PCP 25TH ANNIVERSARY ED."],
    ],
  },
  "pokemon japanese alter genesis": { line: "P.M. JPN. SUN & MOON", year: "2019", variety: "ALTER GENESIS-FA", digitsOnly: true }, // 1 card, cert 172583069
  "pokemon japanese amazing volt tackle": { line: "POKEMON JPN.SWSH", year: "2020", variety: "AMAZING VOLT TACKLE", fa: true, digitsOnly: true }, // 1 card, cert 171103987
  "pokemon japanese battle partners": { // 8 cards, cert 167320217
    line: "POKEMON SV9 JP", year: "2025", exLower: true, digitsOnly: true,
    ranges: [
      [101, 108, "ART RARE"],
      [115, 116, "SUPER RARE"],
      [126, 126, "SPECIAL ART RARE"],
    ],
  },
  "pokemon japanese battle region": { line: "POKEMON JPN.SWSH", year: "2022", pad: 3, variety: "BATTLE REGION", fa: true, digitsOnly: true }, // 2 cards, cert 144971816
  "pokemon japanese black bolt": { // 82 cards, cert 174505173
    line: "POKEMON SV11B JP", year: "2025", pad: 3, exLower: true, digitsOnly: true,
    ranges: [
      [87, 158, "ART RARE"],
      [159, 164, "SUPER RARE"],
      [167, 172, "SPECIAL ART RARE"],
      [174, 174, "BW RARE"],
    ],
  },
  "pokemon japanese blue sky stream": { // 2 cards, cert 163958586
    line: "POKEMON JPN.SWSH", year: "2021", pad: 3, variety: "BLUE SKY STREAM", fa: true, digitsOnly: true,
    ranges: [
      [83, 83, "BLUE SKY STREAM-HYPER", { fa: true }],
    ],
  },
  "pokemon japanese clay burst": { // 4 cards, cert 118538061
    line: "POKEMON SV2D JP", year: "2023", pad: 3, exLower: true, digitsOnly: true,
    ranges: [
      [77, 83, "ART RARE"],
      [89, 89, "SUPER RARE"],
    ],
  },
  "pokemon japanese crimson haze": { // 2 cards, cert 166203893
    line: "POKEMON SV5a JP", year: "2024", pad: 3, exLower: true, digitsOnly: true,
    ranges: [
      [67, 78, "ART RARE"],
      [79, 88, "SUPER RARE"],
      [89, 93, "SPECIAL ART RARE"],
      [94, 96, "ULTRA RARE"],
    ],
  },
  "pokemon japanese crossing the ruins": { // 1 card, cert 163038433
    line: "P.M. JAPANESE NEO 2", year: "2000", digitsOnly: true,
    ranges: [
      [197, 197, ""],
    ],
  },
  "pokemon japanese cyber judge": { // 2 cards, cert 142991960
    line: "POKEMON SV5M JP", year: "2024", pad: 3, exLower: true, digitsOnly: true,
    ranges: [
      [72, 83, "ART RARE"],
      [84, 92, "SUPER RARE"],
      [93, 97, "SPECIAL ART RARE"],
      [98, 100, "ULTRA RARE"],
    ],
  },
  "pokemon japanese dark phantasma": { line: "POKEMON JPN.SWSH", year: "2022", pad: 3, variety: "DARK PHANTASMA", fa: true, digitsOnly: true }, // 1 card, cert 172063689
  "pokemon japanese dark rush": { line: "POKEMON JPN. B & W", year: "2011", pad: 3, variety: "DARK RUSH-1ST EDITION", fa: true, digitsOnly: true }, // 1 card, cert 177108097
  "pokemon japanese detective pikachu": { line: "P.M. JPN. SUN & MOON", year: "2019", variety: "DETECTIVE PIKACHU", digitsOnly: true }, // 1 card, cert 169873640
  "pokemon japanese double crisis": { line: "P.M. JAPANESE XY", year: "2015", pad: 3, variety: "DOUBLE CRISIS-1ST ED", fa: true, digitsOnly: true }, // 2 cards, cert 176661038
  "pokemon japanese dream shine collection": { // 1 card, cert 169918546
    line: "P.M. JPN. 1ST. ED.", year: "2016", pad: 3, digitsOnly: true,
    ranges: [
      [17, 17, "MYTH. & LEG. DRM.SHN.COLL.", { fa: true }],
    ],
  },
  "pokemon japanese eevee heroes": { line: "POKEMON JPN.SWSH", year: "2021", pad: 3, variety: "EEVEE HEROES-HYPER", fa: true, digitsOnly: true }, // 2 cards, cert 173895435
  "pokemon japanese expedition expansion pack": { line: "POKEMON JAPANESE", year: "2001", variety: "EXPEDITION-1ST EDITION", digitsOnly: true }, // 3 cards, cert 173164032
  "pokemon japanese future flash": { // 2 cards, cert 151081766
    line: "POKEMON SV4M JP", year: "2023", pad: 3, exLower: true, digitsOnly: true,
    ranges: [
      [69, 69, "ART RARE"],
      [82, 82, "SUPER RARE"],
    ],
  },
  "pokemon japanese glory of team rocket": { // 6 cards, cert 170249265
    line: "POKEMON SV10 JP", year: "2025", pad: 3, exLower: true, digitsOnly: true,
    ranges: [
      [99, 110, "ART RARE"],
      [111, 123, "SUPER RARE"],
      [124, 129, "SPECIAL ART RARE"],
      [130, 132, "ULTRA RARE"],
    ],
  },
  "pokemon japanese gx ultra shiny": { line: "P.M. JPN. SUN & MOON", year: "2018", variety: "ULTRA SHINY GX", fa: true, digitsOnly: true }, // 1 card, cert 159064120
  "pokemon japanese heat wave arena": { // 2 cards, cert 132897857
    line: "POKEMON SV9a JP", year: "2025", pad: 3, exLower: true, digitsOnly: true,
    ranges: [
      [64, 64, "SPECIAL ART RARE"],
      [65, 75, "ART RARE"],
      [76, 84, "SUPER RARE"],
      [85, 89, "SPECIAL ART RARE"],
      [90, 92, "ULTRA RARE"],
    ],
  },
  "pokemon japanese incandescent arcana": { line: "POKEMON JPN.SWSH", year: "2022", pad: 3, variety: "INCANDESCENT ARCANA", fa: true, digitsOnly: true }, // 2 cards, cert 133818165
  "pokemon japanese inferno x": { // 27 cards, cert 166986670
    line: "POKEMON M2 JP", year: "2025", pad: 3, exLower: true, digitsOnly: true,
    ranges: [
      [81, 92, "ART RARE"],
      [93, 100, "SUPER RARE"],
      [110, 114, "SPECIAL ART RARE"],
      [116, 116, "MEGA ULTRA RARE"],
    ],
  },
  "pokemon japanese lost link": { line: "POKEMON JAPANESE", year: "2010", pad: 3, variety: "LOST LINK", digitsOnly: true }, // 1 card, cert 173164069
  "pokemon japanese mask of change": { // 2 cards, cert 98169936
    line: "POKEMON SV6 JP", year: "2024", exLower: true, digitsOnly: true,
    ranges: [
      [102, 113, "ART RARE"],
      [114, 124, "SUPER RARE"],
      [125, 130, "SPECIAL ART RARE"],
      [131, 133, "ULTRA RARE"],
    ],
  },
  "pokemon japanese mega brave": { // 19 cards, cert 172899747
    line: "POKEMON M1L JP", year: "2025", pad: 3, exLower: true, digitsOnly: true,
    ranges: [
      [64, 75, "ART RARE"],
      [76, 80, "SUPER RARE"],
      [87, 89, "SPECIAL ART RARE"],
      [92, 92, "MEGA ULTRA RARE"],
    ],
  },
  "pokemon japanese mega dream ex": { // 21 cards, cert 175776221
    line: "POKEMON M2a JP", year: "2025", exLower: true, digitsOnly: true,
    ranges: [
      [194, 213, "ART RARE"],
      [214, 222, "SUPER RARE"],
      [223, 232, "MEGA ATTACK RARE"],
      [233, 249, "SPECIAL ART RARE"],
      [250, 250, "MEGA ULTRA RARE"],
    ],
  },
  "pokemon japanese mega symphonia": { // 20 cards, cert 167501441
    line: "POKEMON M1S JP", year: "2025", pad: 3, exLower: true, digitsOnly: true,
    ranges: [
      [64, 75, "ART RARE"],
      [76, 86, "SUPER RARE"],
      [87, 91, "SPECIAL ART RARE"],
      [92, 92, "MEGA ULTRA RARE"],
    ],
  },
  "pokemon japanese miracle twins": { // 2 cards, cert 157913772
    line: "P.M. JPN. SUN & MOON", year: "2019", pad: 3, variety: "MIRACLE TWINS", fa: true, digitsOnly: true,
    ranges: [
      [11, 11, "MIRACLE TWINS"],
    ],
  },
  "pokemon japanese night unison": { line: "P.M. JPN. SUN & MOON", year: "2019", pad: 3, variety: "NIGHT UNISON", fa: true, digitsOnly: true }, // 1 card, cert 174968470
  "pokemon japanese night wanderer": { // 2 cards, no cert yet: line by the SV / Mega pattern
    line: "POKEMON SV6a JP", year: "2024", pad: 3, exLower: true, digitsOnly: true,
    ranges: [
      [65, 76, "ART RARE"],
      [77, 86, "SUPER RARE"],
      [87, 91, "SPECIAL ART RARE"],
      [92, 94, "ULTRA RARE"],
    ],
  },
  "pokemon japanese ninja spinner": { // 21 cards, cert 171009573
    line: "POKEMON M4 JP", year: "2026", pad: 3, exLower: true, digitsOnly: true,
    ranges: [
      [84, 95, "ART RARE"],
      [96, 113, "SUPER RARE"],
      [114, 119, "SPECIAL ART RARE"],
      [120, 120, "MEGA ULTRA RARE"],
    ],
  },
  "pokemon japanese paradigm trigger": { line: "POKEMON JPN.SWSH", year: "2022", variety: "PARADIGM TRIGGER", fa: true, digitsOnly: true }, // 1 card, cert 96534420
  "pokemon japanese paradise dragona": { // 3 cards, cert 171866592
    line: "POKEMON SV7a JP", year: "2024", pad: 3, exLower: true, digitsOnly: true,
    ranges: [
      [65, 76, "ART RARE"],
      [77, 86, "SUPER RARE"],
      [87, 91, "SPECIAL ART RARE"],
      [92, 94, "ULTRA RARE"],
    ],
  },
  "pokemon japanese phantom gate": { line: "P.M. JAPANESE XY", year: "2014", pad: 3, variety: "PHANTOM GATE-1ST ED.", fa: true, digitsOnly: true }, // 1 card, cert 167160581
  "pokemon japanese pokekyun collection": { // 5 cards, cert 177083641
    line: "P.M. JAPANESE XY", year: "2016", pad: 3, digitsOnly: true,
    ranges: [
      [5, 5, "POKEKYUN COLL-1ST ED."],
      [7, 26, "POKEKYUN COLL-1ST ED.", { fa: true }],
    ],
  },
  "pokemon japanese pokepark forest": { line: "POKEMON JAPANESE", year: "2005", pad: 3, variety: "POKEPARK FOREST-HOLO", digitsOnly: true }, // 1 card, cert 169489531
  "pokemon japanese promo|SM-P": { // 22 cards, cert 179275877
    line: "P.M. JPN. SM PROMO", year: "", pad: 3, digitsOnly: true,
    ranges: [
      [13, 13, "FULL ART-SPECIAL BOX P.G.P", { year: "2016" }],
      [14, 14, "SPECIAL BOX P.G.P", { year: "2016" }],
      [37, 38, "SM A.V/V PIKACHU SPC. BOX", { year: "2017" }],
      [55, 55, "PIKACHU'S EASTER BSTR.PK.", { year: "2017" }],
      [137, 144, "EEVEE MEGA CAMPAIGN", { year: "2017" }],
      [199, 199, "MIMIKYU SPECIAL BOX", { year: "2018" }],
      [270, 270, "P.M.CNTR.20TH ANNV.CMP.", { year: "2018" }],
      [286, 290, "MUNCH: A RETROSPECTIVE", { year: "2018" }],
      [363, 363, "MEWTWO HR COMPETITION", { fa: true, year: "2019" }],
      [407, 407, "PM.CENTER OSAKA DX OPENING", { year: "2019" }],
    ],
  },
  "pokemon japanese promo|SV-P": { // 6 cards, cert 171915344
    line: "POKEMON SV-P JP", year: "", pad: 3, exLower: true, digitsOnly: true,
    ranges: [
      [67, 67, "YU NAGABA X PCG CAMPAIGN", { year: "2023" }],
      [98, 98, "DET PIKACHU RTRNS PRE-ORDER", { year: "2023" }],
      [232, 232, "SV9 BOX PURCHASE CAMPAIGN", { year: "2025" }],
      [261, 261, "SPECIAL BOX PC HIROSHIMA", { year: "2025" }],
    ],
  },
  "pokemon japanese promo|XY-P": { // 14 cards, cert 177886708
    line: "P.M. JPN. XY PROMO", year: "", digitsOnly: true,
    ranges: [
      [150, 151, "PROMO-HOLO", { year: "2015" }],
      [155, 155, "ARCHDJINNI/RINGS GIVEAWAY", { fa: true, year: "2015" }],
      [203, 203, "PIKACHU MEGA CAMPAIGN", { year: "2015" }],
      [204, 204, "PM CNTR. MEGA BTL/CRT.CHL.", { year: "2016" }],
      [207, 207, "M.C. X PIKACHU SPECIAL BOX", { year: "2016" }],
      [208, 208, "M.C. Y PIKACHU SPECIAL BOX", { year: "2016" }],
      [230, 231, "RAYQUAZA P.W. PIKACHU BOX", { year: "2016" }],
      [279, 279, "20TH ANNIVERSARY FESTA", { year: "2016" }],
      [293, 293, "LUIGI PIKACHU SPECIAL BOX", { year: "2016" }],
      [294, 294, "MARIO PIKACHU SPECIAL BOX", { fa: true, year: "2016" }],
      [295, 295, "LUIGI PIKACHU SPECIAL BOX", { year: "2016" }],
      [296, 296, "LUIGI PIKACHU SPECIAL BOX", { fa: true, year: "2016" }],
    ],
  },
  "pokemon japanese rage of the broken heavens": { line: "P.M. JAPANESE XY", year: "2015", pad: 3, variety: "RAGE/BROKEN HEAVENS", fa: true, digitsOnly: true }, // 1 card, cert 167229992
  "pokemon japanese rocket gang strikes back": { line: "P.M. JPN. GOLD STAR", year: "2004", pad: 3, variety: "ROCKET GANG STRIKES BACK", digitsOnly: true }, // 2 cards, cert 152530006
  "pokemon japanese ruler of the black flame": { // 2 cards, cert 178123218
    line: "POKEMON SV3 JP", year: "2023", exLower: true, digitsOnly: true,
    ranges: [
      [109, 120, "ART RARE"],
      [121, 132, "SUPER RARE"],
      [133, 138, "SPECIAL ART RARE"],
      [139, 141, "ULTRA RARE"],
    ],
  },
  "pokemon japanese scarlet & violet 151": { // 1 card, cert 110835082
    line: "POKEMON SV2a JP", year: "2023", exLower: true, digitsOnly: true,
    ranges: [
      [166, 183, "ART RARE"],
      [184, 199, "SUPER RARE"],
      [200, 207, "SPECIAL ART RARE"],
      [208, 210, "ULTRA RARE"],
    ],
  },
  "pokemon japanese scarlet ex": { // 2 cards, no cert yet: line by the SV / Mega pattern
    line: "POKEMON SV1S JP", year: "2023", pad: 3, exLower: true, digitsOnly: true,
    ranges: [
      [79, 90, "ART RARE"],
      [91, 100, "SUPER RARE"],
      [101, 105, "SPECIAL ART RARE"],
      [106, 108, "ULTRA RARE"],
    ],
  },
  "pokemon japanese shining legends": { // 1 card, cert 104645270
    line: "P.M. JPN. SUN & MOON", year: "2017", pad: 3, digitsOnly: true,
    ranges: [
      [82, 82, "S.E.P. SHINING LEGENDS"],
    ],
  },
  "pokemon japanese shiny collection": { // 3 cards, cert 173977904
    line: "POKEMON JPN. B & W", year: "2013", pad: 3, variety: "SHINY COLLECTION-1ST ED.", fa: true, digitsOnly: true,
    ranges: [
      [7, 7, "SHINY COLLECTION-1ST ED."],
    ],
  },
  "pokemon japanese shiny treasure ex": { // 3 cards, cert 178403097
    line: "POKEMON SV4a JP", year: "2023", exLower: true, digitsOnly: true,
    ranges: [
      [329, 329, "SSR"],
      [347, 349, "SPECIAL ART RARE"],
    ],
  },
  "pokemon japanese sky legend": { // 1 card, cert 174913266
    line: "P.M. JPN. SUN & MOON", year: "2019", pad: 3, digitsOnly: true,
    ranges: [
      [60, 60, "SKY LEGEND-FULL ART"],
    ],
  },
  "pokemon japanese snow hazard": { // 1 card, no cert yet: line by the SV / Mega pattern
    line: "POKEMON SV2P JP", year: "2023", pad: 3, exLower: true, digitsOnly: true,
    ranges: [
      [72, 83, "ART RARE"],
      [84, 91, "SUPER RARE"],
      [92, 96, "SPECIAL ART RARE"],
      [97, 99, "ULTRA RARE"],
    ],
  },
  "pokemon japanese start deck 100 battle collection": { // 1 card, cert 179588789
    line: "POKEMON MC JP", year: "2025", exLower: true, digitsOnly: true,
    ranges: [
      [764, 764, ""],
    ],
  },
  "pokemon japanese stellar miracle": { // 3 cards, cert 175776203
    line: "POKEMON SV7 JP", year: "2024", exLower: true, digitsOnly: true,
    ranges: [
      [103, 114, "ART RARE"],
      [115, 126, "SUPER RARE"],
      [127, 132, "SPECIAL ART RARE"],
      [133, 135, "ULTRA RARE"],
    ],
  },
  "pokemon japanese super electric breaker": { // 2 cards, cert 152667065
    line: "POKEMON SV8 JP", year: "2024", exLower: true, digitsOnly: true,
    ranges: [
      [118, 118, "ART RARE"],
      [132, 132, "SPECIAL ART RARE"],
    ],
  },
  "pokemon japanese super-burst impact": { line: "P.M. JPN. SUN & MOON", year: "2018", variety: "SUPER-BURST IMPACT", fa: true, digitsOnly: true }, // 1 card, cert 155711923
  "pokemon japanese tag all stars": { // 3 cards, cert 176985576
    line: "P.M. JPN. SUN & MOON", year: "2019", pad: 3, variety: "TAG TEAM GX ALL STARS", fa: true, digitsOnly: true,
    ranges: [
      [41, 41, "TAG TEAM GX ALL STARS"],
    ],
  },
  "pokemon japanese tag bolt": { // 4 cards, cert 179275869
    line: "P.M. JPN. SUN & MOON", year: "2018", pad: 3, variety: "TAG BOLT-FA", digitsOnly: true,
    ranges: [
      [105, 105, "TAG BOLT", { fa: true }],
      [112, 112, "TAG BOLT-FA-HYPER"],
    ],
  },
  "pokemon japanese terastal festival": { // 13 cards, cert 152811914
    line: "POKEMON SV8a JP", year: "2024", pad: 3, exLower: true, digitsOnly: true,
    ranges: [
      [188, 199, "SUPER RARE"],
      [200, 232, "SPECIAL ART RARE"],
      [233, 237, "ULTRA RARE"],
    ],
  },
  "pokemon japanese the town on no map": { // 2 cards, cert 176679878
    line: "POKEMON JAPANESE", year: "2002", pad: 3, variety: "THE TOWN ON NO MAP", digitsOnly: true,
    ranges: [
      [38, 38, "TOWN ON NO MAP-1ST ED."],
    ],
  },
  "pokemon japanese triplet beat": { // 4 cards, cert 149237678
    line: "POKEMON SV1a JP", year: "2023", pad: 3, exLower: true, digitsOnly: true,
    ranges: [
      [74, 85, "ART RARE"],
      [86, 95, "SUPER RARE"],
      [96, 100, "SPECIAL ART RARE"],
      [101, 103, "ULTRA RARE"],
    ],
  },
  "pokemon japanese vending": { // 1 card, cert 177196595
    line: "P.M. JAPANESE VENDING", year: "1998", digitsOnly: true,
    ranges: [
      [25, 25, "SERIES III"],
    ],
  },
  "pokemon japanese violet ex": { // 7 cards, cert 145772077
    line: "POKEMON SV1V JP", year: "2023", pad: 3, exLower: true, digitsOnly: true,
    ranges: [
      [79, 90, "ART RARE"],
      [96, 96, "SUPER RARE"],
    ],
  },
  "pokemon japanese vmax climax": { line: "POKEMON JPN.SWSH", year: "2021", pad: 3, variety: "VMAX CLIMAX", fa: true, digitsOnly: true }, // 6 cards, cert 173882892
  "pokemon japanese vstar universe": { // 15 cards, cert 173882883
    line: "POKEMON JPN.SWSH", year: "2022", variety: "VSTAR UNIVERSE", fa: true, digitsOnly: true,
    ranges: [
      [259, 259, "VSTAR UNIVERSE-FA-UR"],
      [260, 260, "VSTAR UNIVERSE-FA-UR", { fa: true }],
      [261, 262, "VSTAR UNIVERSE-ULTRA RARE", { fa: true }],
    ],
  },
  "pokemon japanese white flare": { // 80 cards, cert 178123217
    line: "POKEMON SV11W JP", year: "2025", pad: 3, exLower: true, digitsOnly: true,
    ranges: [
      [87, 158, "ART RARE"],
      [159, 166, "SUPER RARE"],
      [167, 173, "SPECIAL ART RARE"],
      [174, 174, "BW RARE"],
    ],
  },
  "pokemon japanese wild force": { // 2 cards, cert 100998711
    line: "POKEMON SV5K JP", year: "2024", pad: 3, exLower: true, digitsOnly: true,
    ranges: [
      [72, 83, "ART RARE"],
      [84, 92, "SUPER RARE"],
      [93, 97, "SPECIAL ART RARE"],
      [98, 100, "ULTRA RARE"],
    ],
  },
  "pokemon japanese world championships 2023": { // 1 card, cert 168908628
    line: "POKEMON WCS23 JP", year: "2023", pad: 3, exLower: true, digitsOnly: true,
    ranges: [
      [1, 1, ""],
    ],
  },
  "pokemon lost origin": { line: "POKEMON SWSH", year: "2022", variety: "LOST ORIGIN", fa: true }, // 4 cards, cert 169118152
  "pokemon mega evolution": { // 3 cards, cert 166182040
    line: "POKEMON MEG EN", year: "2025", exLower: true, digitsOnly: true,
    ranges: [
      [133, 154, "ILLUSTRATION RARE"],
      [155, 176, "ULTRA RARE"],
      [177, 186, "SPECIAL ILLUSTRATION RARE"],
      [187, 188, "HYPER RARE"],
    ],
  },
  "pokemon neo genesis": { // 1 card, cert 159520527
    line: "P.M. NEO GENESIS", year: "2000", digitsOnly: true,
    ranges: [
      [9, 9, ""],
    ],
  },
  "pokemon paldea evolved": { // 1 card, cert 171089003
    line: "POKEMON PAL DE", year: "2023", exLower: true, digitsOnly: true,
    ranges: [
      [194, 229, "ILLUSTRATION RARE"],
      [230, 255, "ULTRA RARE"],
      [256, 270, "SPECIAL ILLUSTRATION RARE"],
      [271, 279, "HYPER RARE"],
    ],
  },
  "pokemon paldean fates": { // 1 card, cert 139148330
    line: "POKEMON PAF FR", year: "2024", exLower: true, digitsOnly: true,
    ranges: [
      [92, 211, "SHINY RARE"],
      [212, 223, "ULTRA RARE"],
      [224, 226, "ILLUSTRATION RARE"],
      [227, 231, "ULTRA RARE"],
      [232, 239, "SPECIAL ILLUSTRATION RARE"],
      [240, 245, "HYPER RARE"],
    ],
  },
  "pokemon prismatic evolutions": { // 2 cards, cert 141592061
    line: "POKEMON PRE EN", year: "2025", exLower: true, digitsOnly: true,
    ranges: [
      [132, 143, "ULTRA RARE"],
      [144, 175, "SPECIAL ILLUSTRATION RARE"],
      [176, 180, "HYPER RARE"],
    ],
  },
  "pokemon promo": { // 2 cards, cert 123155373
    line: "POKEMON SVP EN", year: "", pad: 3, exLower: true, digitsOnly: true,
    ranges: [
      [85, 85, "POKEMON X VAN GOGH", { year: "2023" }],
      [159, 159, "SURGING SPARKS PC ETB", { year: "2024" }],
    ],
  },
  "pokemon silver tempest": { line: "POKEMON SWSH", year: "2022", variety: "SILVER TEMPEST", fa: true }, // 1 card, cert 141838476
  "pokemon skyridge": { line: "POKEMON SKYRIDGE", year: "2003" }, // 1 card, cert 172748463
  "pokemon team up": { line: "POKEMON SUN & MOON", year: "2019", variety: "TEAM UP", fa: true, digitsOnly: true }, // 1 card, cert 96296334
  "pokemon twilight masquerade": { // 1 card, cert 127910993
    line: "POKEMON TWM EN", year: "2024", exLower: true, digitsOnly: true,
    ranges: [
      [168, 188, "ILLUSTRATION RARE"],
      [189, 209, "ULTRA RARE"],
      [210, 220, "SPECIAL ILLUSTRATION RARE"],
      [221, 226, "HYPER RARE"],
    ],
  },
  "pokemon unbroken bonds": { line: "POKEMON SUN & MOON", year: "2019", variety: "UNBROKEN BONDS", digitsOnly: true }, // 1 card, cert 57758098
  "pokemon white flare": { // 1 card, cert 174910564
    line: "POKEMON WHT EN", year: "2025", exLower: true, digitsOnly: true,
    ranges: [
      [87, 156, "ILLUSTRATION RARE"],
      [157, 164, "ULTRA RARE"],
      [165, 171, "SPECIAL ILLUSTRATION RARE"],
    ],
  },
  "pokemon world championships 2008": { // 1 card, cert 178822458
    line: "POKEMON PROMO", year: "2008", digitsOnly: true,
    ranges: [
      [101, 101, "WORLD CHAMPS-EMPOTECH"],
    ],
  },
};

// Certificates whose wording the rules above can't reproduce — PSA shortens
// long names by hand. Key = set key + "|" + number as printed. [name, variety, year?]
// prettier-ignore
export const POKEMON_EXACT: Record<string, readonly [name: string, variety: string, year?: string]> = {
  "pokemon celestial storm|177a": ["FA/RAYQUAZA GX", "C.S.'19 Y.A-H.F.PREM.COLL."], // 177338513
  "pokemon expedition|20": ["MEWTWO-HOLO", ""], // 176044430
  "pokemon fire red & leaf green|105": ["CHARIZARD EX-HOLO", "FIRE RED & LEAF GREEN"], // 176772246
  "pokemon japanese 2005 gift box|001": ["PIKACHU-HOLO", "GIFT BOX MEW"], // 177486105
  "pokemon japanese 25th anniversary promo|001": ["MITSUHIRO ARITA", "CHRZRD-HL-PCP 25TH AN."], // 102277345
  "pokemon japanese 25th anniversary promo|007": ["BIRTHDAY PIKACHU-HOLO", "PCP 25TH ANNIVERSARY ED."], // 159363693
  "pokemon japanese alter genesis|100": ["ARCS/DLGA/PALKIA GX", "ALTER GENESIS-FA"], // 172583069
  "pokemon japanese crossing the ruins|197": ["UMBREON-HOLO", ""], // 163038433
  "pokemon japanese double crisis|015": ["FA/TM.MG.GROUDON EX", "DOUBLE CRISIS-1ST ED"], // 176661038
  "pokemon japanese expedition expansion pack|103": ["CHARIZARD-HOLO", "EXPEDITION-1ST EDITION"], // 173164032
  "pokemon japanese lost link|018": ["MEW-HOLO", "LOST LINK"], // 173164069
  "pokemon japanese miracle twins|011": ["SLOWPK. & PSYDCK. GX", "MIRACLE TWINS"], // 157913772
  "pokemon japanese night unison|061": ["FA/GRDVR. & SYLVN. GX", "NIGHT UNISON"], // 174968470
  "pokemon japanese ninja spinner|097": ["MEGA PYROAR ex", "SUPER RARE"], // 160134653
  "pokemon japanese promo|SM-P|013": ["PRTND.TM.SKLL.PIKACHU", "FULL ART-SPECIAL BOX P.G.P"], // 164684116
  "pokemon japanese promo|SM-P|038": ["PONCHO-WEAR.PIKACHU", "SM A.V/V PIKACHU SPC. BOX"], // 165308463
  "pokemon japanese promo|SM-P|055": ["EASTER'S PIKACHU", "PIKACHU'S EASTER BSTR.PK."], // 111141003
  "pokemon japanese promo|SM-P|407": ["PRTND.CMDN.PIKACHU", "PM.CENTER OSAKA DX OPENING"], // 172674108
  "pokemon japanese promo|XY-P|151": ["PRTD.GYRDS. PIKACHU", "PROMO-HOLO"], // 171887687
  "pokemon japanese promo|XY-P|203": ["PONCHO-WEAR. PIKACHU", "PIKACHU MEGA CAMPAIGN"], // 124897564
  "pokemon japanese promo|XY-P|204": ["MEGA TOKYO'S PIKACHU", "PM CNTR. MEGA BTL/CRT.CHL."], // 176025444
  "pokemon japanese promo|XY-P|207": ["PONCHO-WEAR. PIKACHU", "M.C. X PIKACHU SPECIAL BOX"], // 176831008
  "pokemon japanese promo|XY-P|208": ["PONCHO-WEAR. PIKACHU", "M.C. Y PIKACHU SPECIAL BOX"], // 160127937
  "pokemon japanese promo|XY-P|231": ["PONCHO-WEAR.PIKACHU", "RAYQUAZA P.W. PIKACHU BOX"], // 155622236
  "pokemon japanese promo|XY-P|279": ["PIKACHU-HOLO", "20TH ANNIVERSARY FESTA"], // 115127592
  "pokemon japanese promo|XY-P|295": ["LUIGI PIKACHU-HOLO", "LUIGI PIKACHU SPECIAL BOX"], // 164016218
  "pokemon japanese rage of the broken heavens|089": ["FA/GYARADOS EX-SCRT.", "RAGE/BROKEN HEAVENS"], // 167229992
  "pokemon japanese rocket gang strikes back|011": ["TREECKO-HOLO", "ROCKET GANG STRIKES BACK"], // 152530006
  "pokemon japanese shiny collection|007": ["PIKACHU-HOLO", "SHINY COLLECTION-1ST ED."], // 173977904
  "pokemon japanese sky legend|060": ["MLTRS/ZPDS/ARTCN.GX", "SKY LEGEND-FULL ART"], // 174913266
  "pokemon japanese tag bolt|105": ["FA/LATIOS & LATIAS GX", "TAG BOLT"], // 170084273
  "pokemon japanese the town on no map|038": ["ZAPDOS-HOLO", "TOWN ON NO MAP-1ST ED."], // 169702745
  "pokemon japanese the town on no map|068": ["UMBREON-HOLO", "THE TOWN ON NO MAP"], // 176679878
  "pokemon japanese vstar universe|259": ["ORGN.FRM.PALKIA VSTAR", "VSTAR UNIVERSE-FA-UR"], // 166799052
  "pokemon neo genesis|9": ["LUGIA-HOLO", ""], // 159520527
  "pokemon promo|085": ["PIKACHU/GREY FELT HAT", "POKEMON X VAN GOGH"], // 123155373
  "pokemon skyridge|H10": ["GYARADOS-HOLO", ""], // 172748463
  "pokemon unbroken bonds|20": ["RESHRM. & CHARZRD.GX", "UNBROKEN BONDS"], // 57758098
  "pokemon world championships 2008|101": ["MEW-GOLD STAR", "WORLD CHAMPS-EMPOTECH"], // 178822458
};
