# Graded-slab dynamic label — design

**Date:** 2026-07-16
**Status:** approved (design); implementation not started
**Supersedes parts of:** `2026-07-07-graded-slab-baked-image-design.md` (§B geometry), PR #84, PR #81

## 1. Problem

Two things are wrong with the graded-slab bake today:

1. **The grade is a lie.** The current frame asset (`public/images/slab-frame.webp`, 800×1338)
   has **“PSA … GEM MINT 10” printed into the image**. `composeSlab` only composites
   photo + frame — it renders no text. So *every* graded card bakes as GEM MINT 10
   regardless of its real grade. A PSA 9 displays as a 10. Verified: the baked
   `pikachu-ex-238-psa-10` composite shows a GEM MINT 10 label that came from the frame,
   not from the card's data.
2. **The frame is low fidelity and the label is static.** The operator wants a realistic
   PSA-style slab whose label carries the *actual* card details, sourced from PriceCharting.

## 2. Goals

- Replace the frame with a high-resolution one.
- Render the label **dynamically per card** from PriceCharting data.
- Show the card's **real** grade.
- Reserve operator-editable **year** and **note** fields.
- **No barcode**, no cert number.

## Non-goals

- Cert numbers / barcodes (deliberately omitted — we are not a grading authority).
- Non-PSA grader artwork (see §9).
- Changing the storefront's slab rendering component beyond the aspect constant.
- Re-theming the marketplace grid.

## 3. Decisions (locked with the operator)

| Question | Decision |
|---|---|
| Label fields | `SET`, `CARD NAME`, `#NUMBER`, `GRADE` — all auto from PriceCharting |
| Rarity | **Dropped.** PriceCharting does not expose it, and our `rarity` is a per-pack gacha concept, not TCG print rarity |
| Year + note | **Editable admin fields**, blank by default |
| Frame source | SnapGen-generated (reference-led off the operator's frame), proportions accepted |
| Barcode | **Omitted** |
| Non-PSA graders | **PSA-only bake** (§9) |
| Grader + grade | **Operator picks both** on Add-from-PriceCharting (§3a) — not derived from the PC tier |

## 3a. Grader + grade are operator-chosen (blocking fix)

**The feature is unreachable without this.** PriceCharting's tiers (`PRICE_FIELDS`) are:

```
"Ungraded" | "Grade 7" | "Grade 8" | "Grade 9" | "Grade 9.5"
| "PSA 10" | "BGS 10" | "CGC 10" | "SGC 10"
```

`gradeToGrader("Grade 7")` returns `grader: ""` — **"Grade 7/8/9/9.5" are generic graded-price
comps, not PSA claims.** Only `"PSA 10"` yields `grader: "PSA"`. The admin today derives
grader+grade *solely* from the tier label (`pickTier` → `gradeToGrader`), and the bake requires
`grader !== ''`. Net effect: **PSA 10 is the only grade that can ever bake a slab** — PSA 7/8/9
cannot be entered at all.

**Fix (admin UI only — the backend already supports it).** `CreateProductFromPcInput` already
accepts `grader` and `grade` as free inputs; only the UI auto-derives them. So:

- The PC tier keeps supplying **price** (`market_value`) — that is all PriceCharting actually knows.
- Add a **grader select** (PSA / BGS / CGC / SGC / none) and a **grade select** on
  Add-from-PriceCharting (and card edit).
- The grade select is a **fixed dropdown of PSA's canonical 11-point scale** — not free text,
  so typos and impossible grades are unrepresentable:

  ```
  10 · 9 · 8 · 7 · 6 · 5 · 4 · 3 · 2 · 1.5 · 1
  ```

  **Qualifier half-grades (2.5–9.5) are deliberately excluded** (operator decision,
  2026-07-16): the catalog does not carry them, so offering them is dead UI and an extra way
  to be wrong. **1.5 stays** — it is not a qualifier, it is PSA's base FR grade (PR is 1, FR
  is 1.5). This also removes the `Grade 9.5` trap: it is a real *PriceCharting price tier* but
  never a real PSA grade (9.5 is BGS), so it can no longer be paired with PSA.
- Prefill from the tier when unambiguous (`"PSA 10"` → PSA / 10); otherwise leave the operator
  to state it.

This keeps the data honest: PriceCharting supplies the comp, the operator asserts the grade of
the physical slab in hand.

## 4. The frame asset

Generated via SnapGen `nano-banana-2`, reference-led (`--files` with the operator's frame),
`--aspect_ratio 9:16 --resolution 4K`, 3 credits. Master: `docs/research/slabframe-snapgen-v1.png`
(3072×5504).

Processing to ship it:

1. **Key the green window → transparent.** The window is solid green `(77,114,81)`. This is
   not arbitrary: the operator's source frame has green pixels hiding under `alpha=0`
   (`RGB [71,112,76], alpha 0`); SnapGen flattened the alpha and the green surfaced. Key with
   the existing `scripts/process-slab-frame.mjs` approach (`g > r+18 && g > b+18`).
2. **Downscale 3072 → 1600px wide.** `MAX_FRAME_WIDTH` is 1600; anything larger is discarded
   by `composeSlab` anyway. Result ≈ 1600×2867.
3. **Outside-of-slab transparency needs care.** Case body `(242,242,244)` vs background
   `(255,255,255)` are ~13 levels apart, so a colour key will eat the case. Use an
   edge-aware flood-fill from the corners, and *verify by alpha histogram* that the case
   survives.
4. Ship as the bundled default (`slab-frame-default.ts` base64), consistent with today's
   pattern. **Verified feasible:** the keyed 1600px-wide webp is 252 KB → ~345 KB of base64
   source, versus the current `slab-frame-default.ts` at 325 KB. Despite 4× the pixels the
   source file is essentially the same size, so bundling stays viable and no new asset-hosting
   path is needed.

## 5. Geometry constants (measured from the shipped frame — never eyeballed)

Measured by flood-filling the interior transparent region (a naive bbox spans the whole
image because the outside is transparent too).

| Constant | Old | New |
|---|---|---|
| `SLAB_ASPECT` | 1462/2446 = 0.5977 | **3072/5504 = 0.5581** |
| `SLAB_WINDOW.top` | 0.2833 | **0.2743** |
| `SLAB_WINDOW.left` | 0.1047 | **0.1061** |
| `SLAB_WINDOW.right` | 0.1047 | **0.1058** |
| `SLAB_WINDOW.bottom` | 0.0666 | **0.0776** |

Window = 2421×3567 @ x326,y1510, aspect **0.679**. A real card is 0.716, so `fit: 'cover'`
crops ~5% horizontally — acceptable.

Label box = 2681×833 @ x195,y240 → frac: top **0.0436**, left **0.0635**, right **0.0638**,
height **0.1513**.

> **`SLAB_ASPECT` must move in lockstep with the frame.** The storefront renders every slab at
> `SLAB_ASPECT`; if it disagrees with the asset, the frame is stretched. This is the root cause
> of the "size is wrong" report against the 0.5927 frame rendered into a 0.5977 box.

Constants stay hardcoded, matching the existing PR #81 contract ("admin-uploaded frames must
keep this geometry").

## 6. Label renderer (the new component)

New pure module `backend/packages/api/src/api/admin/media/label.ts`:

```ts
export type SlabLabelFields = {
  set: string; name: string; number: string;
  grader: string; grade: string;
  year?: string | null; note?: string | null;
};
export function renderLabelSvg(f: SlabLabelFields, box: Box): Buffer
```

`composeSlab` gains a third layer: **photo → frame → label**.

### Layout — measured off a real PSA slab (`docs/research/pasted/ref-psa-real.webp`, 692×1174)

Fractions of the label box:

| Property | Value |
|---|---|
| Baselines (3 rows) | **0.365 / 0.539 / 0.719** |
| Cap height | **0.117** |
| Left margin | **0.068** |
| Right column ends | **0.994** |

```
[YEAR] SET          #NUM
CARD NAME         GEM MT
[NOTE]                10
        [PSA holo]
```

**Every element is the same size and regular weight (500).** The card name is *not* larger;
the grade "10" is *not* a big number. This was verified against the reference — an earlier
draft that emphasised the name and grade was measurably wrong. Left column left-aligned,
right column right-aligned on the *same three* baselines. Row 4 on a real label is
barcode + holo + cert; we render none of it — the frame's own PSA hologram occupies it.

Year is **inline on line 1** (`2021 POKEMON JAPANESE`). When blank the set starts at the left
margin — no orphan indent.

## 7. Font — must be bundled (production-critical)

The reference typeface is Helvetica; **Arial** matches it (letterforms + weight; only 1.5%
wide at matched cap height). A width/cap-ratio bake-off alone was *misleading* — Franklin
Gothic Medium scored a perfect 0.0% on ratio but is visibly far too bold. The visual check
decided it.

**Arial does not exist on the Linux container the backend runs on.** Without a bundled font
the bake silently falls back to DejaVu Sans — correct on a Windows dev box, wrong in
production. Ship **Arimo** (Apache 2.0, Arial/Helvetica-metric) into `public/fonts/` and
register it via fontconfig so `sharp`/librsvg resolve it deterministically on dev *and* prod.

Verification: assert the rendered cap-height/width of a known string, so a font
regression fails a test instead of shipping.

## 7a. Auto-fill from pokemontcg.io — year + rarity (2026-07-16 revision)

`https://api.pokemontcg.io/v2` (free, no key for low volume) covers **173 English sets, Base 1999 →
Mega Evolution 2026**, and supplies per-set `releaseDate` + `ptcgoCode`, and per-card `name`,
`number`, `rarity`.

Verified against the catalog:

| Query | Result | Matches slab |
|---|---|---|
| set `sv8` | `Surging Sparks` · `ptcgoCode: SSP` · `releaseDate 2024/11/08` | year **2024** ✓ |
| set `me2` | `Phantasmal Flames` · `ptcgoCode: PFL` · `releaseDate 2025/11/14` | year **2025** ✓ |
| card `Pikachu ex` #238 | `rarity: "Special Illustration Rare"` | `SPECIAL ILLUSTRATION RARE` ✓ |

**Matching is mechanical, not fuzzy:** PriceCharting's `console-name` is the set name prefixed with
`Pokemon ` — strip it and look the set up by name, then fetch the card by **set id + number**
(scoping by set is required; a bare name+number query can collide across sets). A PC name starting
`Pokemon Japanese …` routes to the JP path by prefix.

### What is auto-filled — and what is NOT

| Field | Source | Automated? |
|---|---|---|
| `year` | `set.releaseDate` (EN) | ✅ — a release year is an objective fact |
| `note` (rarity) | `card.rarity` (EN) | ✅ — PSA's `Variety` is usually the rarity |
| `name`, `number` | `card.*` / PC | ✅ |
| **set line** | **the `setAbbrev` map (§8)** | ❌ **NEVER derived from `ptcgoCode`** |

> **Why the set line must stay mapped (operator, 2026-07-16):** *"some PSA cards do not use the
> short form format."* PSA's set naming is **not** always `POKEMON <code> <LANG>` —
> `2021 POKEMON JAPANESE`, `2017 Pokemon Sun Moon Shining Legends` and `2022 Pokemon Japanese Sword
> & Shield Battle Region` all use a long/generic form. Deriving the label from `ptcgoCode` would
> confidently emit a short code PSA never printed. `ptcgoCode` may be used as a *hint when seeding*
> the map, but the shipped value must be **verified against a real slab or PSA's own listing**.

### Both auto-filled fields stay operator-overridable

`Variety` is a general-purpose field, not strictly "rarity" — the 2021 Charizard-Holo carries
`PCP 25TH ANNIVERSARY ED.` there. So `label_year` / `label_note` (§8) remain **editable**,
pre-filled from the API. Auto-fill is a default, never a lock.

### Japanese

pokemontcg.io has **zero** Japanese coverage (confirmed: 173 sets, all English series; `Mega Dream`
and `Shiny Treasure` not found). `tcgdex` `/v2/ja/sets` has 172 JA sets with official codes
(`S6H`, `S12a`, `M2`…) but **lacks `M2a`** — our own card's set. Limitless serves
`/cards/jp/<code>` (HTTP 200) but publishes **no API**.

**Therefore: JP year + note stay operator-entered**, backed by the verified JP map entries.
Revisit if a JP source gains coverage.

### Risks

- **New network dependency in the bake/register path.** Must be **cached** (set data is immutable
  once released) and must **degrade to manual** on failure — the bake's "never fail a card save"
  contract (§10) still governs.
- `ptcgoCode` matched PSA's code on **2/2** checks (SSP, PFL) — good, but not proof for 173 sets,
  which is the second reason it seeds rather than decides.

## 8. Data model

Add to the Card model (+ migration):

```ts
label_year: model.text().nullable(),   // operator-entered; PC has no reliable year
label_note: model.text().nullable(),   // variety line, e.g. "DOUBLE RARE"
```

- Admin inputs on **Add-from-PriceCharting** and **card edit**.
- `create-card` / `update-card` pass them into the bake.
- Changing either **triggers a rebake** (same path as an image change).

Derived, not stored:

- `parseCardName("Pikachu ex #238")` → `{ name: "Pikachu ex", number: "#238" }`
  (PC embeds the number in `product-name`; no separate field exists).

- `formatCardName("Pikachu ex")` → `"PIKACHU ex"` — **uppercase, but preserve the source casing
  of known suffix tokens**. PSA prints `PIKACHU ex`, `MEGA CHARIZARD X ex`, `CHARIZARD-HOLO`;
  a blanket `.toUpperCase()` gives `PIKACHU EX`, which is visibly wrong on every reference.

  Rule: uppercase each token, except a token matching a known suffix (case-insensitively) is
  emitted **verbatim from the source**. Suffix set: `ex, GX, V, VMAX, VSTAR, VUNION, BREAK,
  LV.X, Prime, LEGEND, Star, δ`.

  Preserving *source* casing (rather than forcing lowercase) handles both TCG eras with no era
  table: PriceCharting already supplies modern `Pikachu ex` (lowercase) and old-era
  `Blastoise EX` (uppercase), and each round-trips correctly.

- `setAbbrev("Pokemon Surging Sparks")` → `"POKEMON SSP EN"` — **PSA abbreviates sets;
  PriceCharting does not.** PSA prints the official TCG set code plus a region suffix. Verified
  against the operator's slabs, two of which are our own catalog cards:

  | PriceCharting `console-name` | PSA label | Confirmed by |
  |---|---|---|
  | `Pokemon Surging Sparks` | `POKEMON SSP EN` | Pikachu ex #238 slab |
  | `Pokemon Phantasmal Flames` | `POKEMON PFL EN` | Mega Charizard X ex #125 slab |
  | `Pokemon Japanese Mega Dream ex` | `POKEMON M2a JP` | Mega Gengar ex #240 slab |

  **The map value is emitted VERBATIM — never uppercase it.** PSA set codes carry mixed case:
  `M2a`, not `M2A`. Only the *fallback* path uppercases.

  **The trailing token is a LANGUAGE code, not an EN/JP binary.** PSA lists `SSP EN` and
  **`SSP IT`** as *separate sets* (confirmed from PSA's own pop-report slugs —
  `pokemon-ssp-en-surging-sparks` vs `pokemon-italian-ssp-surging-sparks`). So the space is
  `EN`, `JP`, `IT`, and presumably `FR`/`DE`/`SP`/`KR`. Consequences:

  - The map must key on the PriceCharting name **including its language marker** (`Pokemon
    Japanese Mega Dream ex`, `Pokemon Italian …`) — never on a bare set name, or an Italian
    printing silently inherits the English mapping.
  - Do not synthesise the suffix from a language guess; it is part of the mapped value.

  **Era-scoped:** the `<code> <lang>` convention is *recent*. PSA's slugs for 2001/2004/2017 sets
  carry **no code and no language** (`pokemon-sun-moon-shining-legends`,
  `pokemon-ex-team-rocket-returns`), matching the 2021 `POKEMON JAPANESE` observation in the
  research doc. The fallback covers these; do not extrapolate the modern rule backwards.

  Implemented as a lookup keyed by the normalised PC set name. **Unknown set → fall back to the
  uppercased PC name** (accurate, just not PSA's wording) — never guess a code. The three entries
  above cover the entire current catalog; a new set needs a map entry (the accepted maintenance
  cost of choosing the map over an editable set field).
- `psaDescriptor(grade)` — PSA's **canonical 11-point scale**, the complete map (qualifier
  half-grades are excluded from the picker per §3a, so no `+` descriptors exist):

  | 10 | 9 | 8 | 7 | 6 | 5 | 4 | 3 | 2 | 1.5 | 1 |
  |---|---|---|---|---|---|---|---|---|---|---|
  | GEM MT | MINT | NM-MT | NM | EX-MT | EX | VG-EX | VG | GOOD | FR | PR |

  Verified against real slabs supplied by the operator — PSA 7 → `NM`, PSA 8 → `NM-MT`,
  PSA 9 → `MINT` — and the Charizard-Holo reference, PSA 10 → `GEM MT`.

  An unknown grade renders **no descriptor** (the grade number still prints) rather than
  guessing — the label must never assert a descriptor PSA wouldn't use. This is the safety net
  for any legacy card already carrying an off-scale grade (e.g. a pre-existing `9.5`), which the
  picker can no longer create but the database may still hold.

## 9. PSA-only bake

`gradeToGrader` supports PSA/BGS/CGC/SGC, but this frame is PSA-branded. Baking a CGC card
into a PSA slab with a synthesised PSA grade would assert something false.

**Decision:** bake only when `grader === 'PSA'`. Other graders skip the slab bake and render
the raw card — the existing, already-supported "bake returned null" path. This *narrows*
today's behaviour (which frames everything as PSA) and is strictly more truthful.

## 10. Error handling

Unchanged contract: **the bake is best-effort and must never fail a card save** (spec §B.5).
Any failure logs a warning and returns `null` → the card keeps a bare photo.

Additions:
- Missing font → fail the **test suite**, not silently at runtime.
- Label text overflowing its column → shrink-to-fit down to a floor, then ellipsize; never
  overlap the right column or the holo.
- `label_year` / `label_note` blank → render nothing, no layout shift.

## 11. Testing

Unit (alongside `bake-slab.unit.spec.ts`):
- `psaDescriptor` — **all 11 grades** (the operator's PSA 7/8/9 slabs are the fixtures), plus:
  unknown grade → no descriptor, and `9.5` / `8.5` → no descriptor (off-scale, may exist on
  legacy rows).
- Grade picker offers **exactly** `10, 9, 8, 7, 6, 5, 4, 3, 2, 1.5, 1` — no qualifier
  half-grades, and 1.5 is present.
- `parseCardName` — with/without `#`, alphanumeric numbers (`#SV43`), trailing spaces.
- `formatCardName` — `Pikachu ex` → `PIKACHU ex` (suffix stays lowercase); `Blastoise EX` →
  `BLASTOISE EX` (old-era suffix stays uppercase); `Charizard-Holo` → `CHARIZARD-HOLO`;
  a name *containing* a suffix substring but not as a token (e.g. `Exeggutor`) must **not** be
  mangled to `exEGGUTOR`.
- `setAbbrev` — all three verified mappings; unknown set → uppercased fallback, never a guessed
  code; **a mapped value is returned byte-identical** (`POKEMON M2a JP` must not become
  `POKEMON M2A JP`) — this is the regression test that protects PSA's mixed-case set codes.
- `renderLabelSvg` — baselines/margins land at the measured fractions; blank year/note
  produce no shift; long names shrink rather than overlap.
- `composeSlab` — output is frame-sized; photo covers the *new* window insets.

## 12. Rollout

1. Process + ship the frame; update `SLAB_ASPECT` + `SLAB_WINDOW` together.
2. Migration for `label_year` / `label_note`.
3. Rebake: `cd backend/packages/api && corepack yarn medusa exec ./src/scripts/bake-slab-images.ts`.
   This works locally **only because of the 2026-07-16 SSRF fix** (`localFileOrigin`) — before it,
   every local bake silently failed on the `localhost:9000` card image. See
   `bake-slab-localhost-ssrf-block` memory.
4. Verify the 3 catalog cards bake with correct per-card labels.

## 13. Risks / open

- **Outside-of-slab alpha** (§4.3) is the fiddliest step; case ≈ background in colour.
- **PSA hologram sub-box** in the generated frame is not yet isolated (the dark/low-sat probe
  returned the whole label). Needed to guarantee text never collides with the holo. Measure
  during implementation.
- **Trade dress:** we synthesise a facsimile of a third party's certification label, including
  an operator-editable free-text `note`, for cards we assert are PSA-graded. The product
  already ships a PSA-branded frame, so this is not new, but the dynamic label asserts more.
  Operator's call; flagged once here.
- Window aspect 0.679 vs card 0.716 → ~5% horizontal crop. Accepted.
