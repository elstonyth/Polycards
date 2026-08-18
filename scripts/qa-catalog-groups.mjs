// QA gate: /slots composition catalog (Graded / Raw Cards / More Packs).
// Screenshots two viewports, then ASSERTS the structural invariants that
// src/lib/packs-data.ts's grouping guarantees: at least one section renders,
// every heading is known, sections stay in CATALOG_GROUP_ORDER, no
// duplicate headings, the qualifying note is attached to (only) the heading
// it's true for, every section's count is honest, section counts sum
// exactly to rendered pack tiles, and desktop agrees with mobile. Before
// this, the script only screenshotted and dumped JSON — no assertion, no
// non-zero exit, so it could never go red (see plan 109).
//
// These checks are catalog-shape-independent ON PURPOSE: the CI database
// (seed:e2e) mirrors production — five packs, all graded pools — so only
// "Graded" (maybe plus "More Packs") ever renders there. Nothing here
// asserts that all three sections exist, or checks an absolute pack count;
// either would false-fail on CI/prod and could still pass vacuously on a
// dev box that additionally carries a hand-made raw fixture pack.
//
// Run against a self-built server: node scripts/qa-catalog-groups.mjs [base]
import { chromium } from 'playwright';

// Copied verbatim from scripts/qa-free-pack.mjs's convention: every
// assertion reports independently (fail sets the exit code but never
// throws), so one broken invariant never hides the rest of the report.
const fail = (m) => {
  console.error(`✗ ${m}`);
  process.exitCode = 1;
};
const ok = (m) => console.log(`✓ ${m}`);

const BASE = process.argv[2] ?? 'http://localhost:4000';
const browser = await chromium.launch();

const shoot = async (width, height, out) => {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.goto(`${BASE}/slots`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200); // Reveal animations settle
  // Scoped under layout.tsx's sitewide <main id="main"> rather than a bare
  // `section` — nothing else on /slots renders a stray <section>/<h2>/count
  // span today (checked), but scoping costs nothing and turns a future
  // stray <section> elsewhere on the page into a wrong-count failure
  // instead of a silent false read.
  const headings = await page.locator('main#main section h2').allInnerTexts();
  const counts = await page
    .locator('main#main section span.ml-auto')
    .allInnerTexts()
    .catch(() => []);
  // Pack-tile counts, taken from each section's row containers' direct
  // children — NOT from `a[href*="count="]` (every pack tile's href does
  // carry `?count=`, per packHref in packs-data.ts, but that selector is
  // wrong for a COUNT here, for two reasons visible in CatalogClient.tsx):
  //   1. The desktop card row (`hidden ... sm:flex`) and the mobile list
  //      row (`flex ... sm:hidden`) are BOTH unconditionally rendered —
  //      Tailwind only toggles `display` in CSS, so at ANY viewport both
  //      are in the DOM. A bare anchor count would be 2x.
  //   2. An out-of-stock pack renders NO anchor on either layout — PackCard
  //      swaps its `<Link>` for a `<span>Sold out</span>`; PackRow swaps its
  //      `<Link>` wrapper for a plain `<div>`. Anchor-counting would drop
  //      every OOS pack, breaking #7 for a reason unrelated to the
  //      partition the first time an operator marks a pack OOS.
  // Each section renders exactly 3 direct <div> children, unconditionally,
  // in fixed order — header, desktop row, mobile row (verified against
  // CatalogClient.tsx at commit 16cc85d3). If this selector ever needs
  // updating, check that section's child count/order first. Both rows
  // always exist in the DOM regardless of viewport; Reveal's wrapper
  // (desktop) and PackRow's own root (mobile) render one child per pack
  // UNCONDITIONALLY — stock status only changes what's INSIDE that child,
  // never whether it renders — so counting either row's children is both
  // viewport- and OOS-independent. Counted separately (not just desktop,
  // mirrored for mobile too) and cross-checked in #7 below, so a filter
  // touching only one layout's .map() shows up as a mismatch instead of
  // hiding behind the other layout's still-correct count. Mobile's children
  // are `> *`, not `> div`: PackRow's own root is an <a> (in stock) or
  // <div> (OOS), unlike desktop's uniformly-<div> Reveal wrapper.
  // The real fix here would be a `data-testid="pack-tile"` on PackCard's
  // and PackRow's root, closing this gap without a positional selector —
  // recorded as a follow-up; CatalogClient.tsx is out of scope for this gate.
  const desktopTiles = await page
    .locator('main#main section > div:nth-of-type(2) > div')
    .count();
  const mobileTiles = await page
    .locator('main#main section > div:nth-of-type(3) > *')
    .count();
  await page.screenshot({ path: out, fullPage: true });
  await page.close();
  return { headings, counts, desktopTiles, mobileTiles };
};

const desktop = await shoot(
  1440,
  900,
  'docs/research/qa-catalog-groups-desktop.png',
);
const mobile = await shoot(
  393,
  852,
  'docs/research/qa-catalog-groups-mobile.png',
);
// Raw dump first, so a failure report below has the exact data next to it.
console.log('sections:', JSON.stringify({ desktop, mobile }));

const KNOWN_HEADINGS = ['Graded', 'Raw Cards', 'More Packs'];
// The qualifying note each heading is allowed to carry — null means "must
// carry none". These are the truth claims GROUP_CHROME makes in
// CatalogClient.tsx; a mismatch here is an overclaim or a dropped claim.
const EXPECTED_NOTE = {
  Graded: 'Guaranteed PSA 10',
  'Raw Cards': 'Ungraded',
  'More Packs': null,
};

// "Graded (Guaranteed PSA 10)" -> { base: 'Graded', note: 'Guaranteed PSA 10' }
// "More Packs" -> { base: 'More Packs', note: null }
// Anything that doesn't match a known base at all -> { base: null, note: null }.
function splitHeading(text) {
  for (const base of KNOWN_HEADINGS) {
    if (text === base) return { base, note: null };
    const prefix = `${base} (`;
    if (text.startsWith(prefix) && text.endsWith(')')) {
      return { base, note: text.slice(prefix.length, -1) };
    }
  }
  return { base: null, note: null };
}

function assertViewport(
  label,
  { headings, counts, desktopTiles, mobileTiles },
) {
  // #1 — at least one section renders. Zero sections means the catalog
  // failed to load or the grouping collapsed entirely — the base case the
  // old screenshot-only script could never detect.
  if (headings.length === 0) {
    fail(`${label}: no sections rendered — ${JSON.stringify(headings)}`);
    // #2-7 would each report a VACUOUS ✓ against an empty catalog (nothing
    // to be unknown, nothing to duplicate, nothing whose note could
    // mismatch, 0 sums to 0 tiles...) — one real ✗ buried under six ✓ lines
    // is exactly the "0 violations, 0 passes reads clean" shape this repo
    // already got burned by once (the a11y gate). #1 is the whole signal
    // for this case, so stop here.
    return;
  }
  ok(`${label}: ${headings.length} section(s) rendered`);

  const parsed = headings.map(splitHeading);

  // #2 — every heading's base is one of the known set. An unknown heading
  // means CATALOG_GROUP_HEADING's copy drifted without this gate noticing.
  const unknown = headings.filter((_, i) => parsed[i].base === null);
  if (unknown.length) {
    fail(`${label}: unrecognized heading(s) ${JSON.stringify(unknown)}`);
  } else {
    ok(`${label}: every heading is known (${KNOWN_HEADINGS.join(', ')})`);
  }

  // #3 — rendered order is a subsequence of CATALOG_GROUP_ORDER. Guarantee
  // first is part of the design; duplicates are #4's concern, so this only
  // fails on a genuine swap (e.g. Raw Cards rendering before Graded).
  const positions = parsed
    .map((p) => KNOWN_HEADINGS.indexOf(p.base))
    .filter((i) => i >= 0);
  const inOrder = positions.every((v, i) => i === 0 || v >= positions[i - 1]);
  if (inOrder) {
    ok(`${label}: section order matches CATALOG_GROUP_ORDER`);
  } else {
    fail(
      `${label}: section order ${JSON.stringify(headings)} is not a subsequence of ${JSON.stringify(KNOWN_HEADINGS)}`,
    );
  }

  // #4 — no duplicate headings. Two "Graded" sections means catalogGroupOf's
  // first-match-wins partition broke and a pack is rendering twice.
  const bases = parsed.map((p) => p.base).filter((b) => b !== null);
  const dupes = [...new Set(bases.filter((b, i) => bases.indexOf(b) !== i))];
  if (dupes.length) {
    fail(`${label}: duplicate heading(s) ${JSON.stringify(dupes)}`);
  } else {
    ok(`${label}: no duplicate headings`);
  }

  // #5 — the qualifying note is attached to the right heading, and ONLY
  // that heading. The truth-claim assertion: it catches a note migrating
  // onto the claim-free "More Packs" catch-all (an overclaim) exactly as
  // readily as it catches one going missing from Graded/Raw Cards.
  let notesOk = true;
  for (const { base, note } of parsed) {
    if (base === null) continue; // already reported by #2
    const want = EXPECTED_NOTE[base];
    if (note !== want) {
      notesOk = false;
      fail(
        `${label}: "${base}" carries note ${JSON.stringify(note)}, want ${JSON.stringify(want)}`,
      );
    }
  }
  if (notesOk) ok(`${label}: every section's note matches its truth claim`);

  // Positional pairing for #6/#7 below assumes one count span per heading,
  // in the same DOM order — true by construction (CatalogClient renders
  // exactly one <h2> and one count span per <section>). Guard it explicitly
  // rather than letting a mismatch pair the wrong count with the wrong
  // heading, or throw on an out-of-range index.
  if (counts.length !== headings.length) {
    fail(
      `${label}: ${headings.length} heading(s) but ${counts.length} count span(s) — cannot pair them`,
    );
  }
  const pairs = Math.min(headings.length, counts.length);

  // #6 — every section's count is >= 1 (a section that rendered cannot be
  // empty by construction — CatalogClient filters empty groups out before
  // rendering), and the noun agrees with the number ("1 pack" vs "N
  // packs"). A zero here means the displayed count and the actual
  // membership disagree.
  let countsOk = true;
  const parsedCounts = [];
  for (let i = 0; i < pairs; i++) {
    const m = counts[i].match(/^(\d+)\s+(pack|packs)$/);
    if (!m) {
      countsOk = false;
      parsedCounts.push(0);
      fail(`${label}: count text "${counts[i]}" doesn't parse as "N pack(s)"`);
      continue;
    }
    const n = Number(m[1]);
    parsedCounts.push(n);
    if (n < 1) {
      countsOk = false;
      fail(`${label}: "${headings[i]}" count is ${n}, want >= 1`);
    }
    const wantNoun = n === 1 ? 'pack' : 'packs';
    if (m[2] !== wantNoun) {
      countsOk = false;
      fail(
        `${label}: "${headings[i]}" says "${n} ${m[2]}", want "${n} ${wantNoun}"`,
      );
    }
  }
  if (pairs > 0 && countsOk) {
    ok(`${label}: every section count is >= 1 with correct noun agreement`);
  }

  // #7 — section counts sum exactly to the number of rendered pack tiles,
  // checked against the desktop row's tile count AND the mobile row's tile
  // count INDEPENDENTLY (not desktop mirrored twice) — the partition is
  // total and disjoint, so both must hold exactly. This is the assertion
  // that catches a pack silently dropping out of every section, and (since
  // it counts each layout's own DOM children rather than reusing one count
  // for both) a filter that touches only one layout's .map() — the failure
  // modes with the worst consequence and the least visible symptom.
  const sum = parsedCounts.reduce((s, n) => s + n, 0);
  const desktopOk = sum === desktopTiles;
  const mobileOk = sum === mobileTiles;
  if (desktopOk && mobileOk) {
    ok(
      `${label}: section counts sum to ${sum}, matching ${desktopTiles} desktop tile(s) and ${mobileTiles} mobile tile(s)`,
    );
  } else {
    if (!desktopOk) {
      fail(
        `${label}: section counts sum to ${sum}, but ${desktopTiles} desktop tile(s) rendered`,
      );
    }
    if (!mobileOk) {
      fail(
        `${label}: section counts sum to ${sum}, but ${mobileTiles} mobile tile(s) rendered`,
      );
    }
  }
}

assertViewport('desktop', desktop);
assertViewport('mobile', mobile);

// #8 — desktop and mobile render the identical HEADING/COUNT TEXT: same
// headings (so same notes, since the note is part of the heading text), in
// the same order, with the same displayed counts. This is a TEXT-level
// check only — it can't see a rendered row silently diverging from that
// text (e.g. a filter applied inside just one layout's .map() without
// touching byGroup[id].length); #7 above catches that instead, since it
// independently counts both the desktop and mobile row's actual DOM
// children at every viewport, not the text a viewport happens to display.
// Skipped when either viewport rendered zero sections: #1 already failed
// and is the whole signal for that case (see assertViewport) — comparing
// two empty arrays here would just be another vacuous ✓ stacked on top.
if (desktop.headings.length > 0 && mobile.headings.length > 0) {
  if (
    JSON.stringify(desktop.headings) === JSON.stringify(mobile.headings) &&
    JSON.stringify(desktop.counts) === JSON.stringify(mobile.counts)
  ) {
    ok('desktop and mobile agree on headings, order, and counts');
  } else {
    fail(
      `desktop/mobile disagree — desktop ${JSON.stringify({ headings: desktop.headings, counts: desktop.counts })} vs mobile ${JSON.stringify({ headings: mobile.headings, counts: mobile.counts })}`,
    );
  }
}

await browser.close();
