// Shared PriceCharting grade-label ⇄ price-field mapping. Single source of
// truth for the admin PriceCharting proxy route and the future daily-sync job.
// (upstream field, UI label) in ascending grade order.
export const PRICE_FIELDS = [
  ["loose-price", "Ungraded"],
  ["cib-price", "Grade 7"],
  ["new-price", "Grade 8"],
  ["graded-price", "Grade 9"],
  ["box-only-price", "Grade 9.5"],
  ["manual-only-price", "PSA 10"],
  ["bgs-10-price", "BGS 10"],
  ["condition-17-price", "CGC 10"],
  ["condition-18-price", "SGC 10"],
] as const;

export type PcPriceField = (typeof PRICE_FIELDS)[number][0];

export function priceFieldForGrade(label: string): PcPriceField | null {
  const hit = PRICE_FIELDS.find(([, l]) => l === label);
  return hit ? hit[0] : null;
}

export function gradeToGrader(label: string): { grader: string; grade: string } {
  for (const g of ["PSA", "BGS", "CGC", "SGC"]) {
    if (label.startsWith(g + " ")) return { grader: g, grade: label.slice(g.length + 1) };
  }
  if (label.startsWith("Grade ")) return { grader: "", grade: label.slice(6) };
  return { grader: "", grade: label };
}

// PriceCharting's seller-collection offers label their grade in `include-string`
// — a free-text, category-aware tag. Measured over this account's live
// collection (9,000+ offers, 2026-07-30) the real values are: "Ungraded" (the
// overwhelming majority), "PSA 10", "Graded 9"/"Graded 9.5"/"Graded 8"… (a
// grader-less number — PriceCharting drops the grading company for anything
// that is not one of its own top-tier fields), "BGS 10 Black", "CGC 10",
// "SGC 10", "ACE 10", plus the video-game condition family ("Item only",
// "Item, Box, and Manual").
//
// The bulk collection import maps that tag onto one of PRICE_FIELDS' labels so
// the imported product prices off (and nightly re-syncs against) the same field
// the manual add-from-PriceCharting flow uses. Returns null when the tag names
// no field we price from ("ACE 10", "Grade 5", a game's box/manual condition) —
// the operator then picks the tier by hand, rather than the import guessing on
// a money field.
export function gradeForIncludeString(include: string): string | null {
  const s = include.trim().toLowerCase();
  if (s === "") return null;
  if (/^(loose|raw|ungraded|used|near mint|nm|mint)$/.test(s)) return "Ungraded";

  // "graded" must precede "grade" in the alternation — otherwise "graded 9"
  // matches the shorter branch and leaves a stray "d" that fails the number.
  // The optional trailing word absorbs BGS's "Black" label: PriceCharting has
  // no separate black-label price field, so it prices off plain BGS 10.
  const m = /^(psa|bgs|cgc|sgc|graded|grade)?\s*(\d+(?:\.5)?)(?:\s+black)?$/.exec(s);
  // Only AFTER the grader match: "gem mint" is a substring test, so running it
  // first would send a hypothetical "CGC 10 Gem Mint" to PSA 10's field.
  if (!m) return /gem\s*mint/.test(s) ? "PSA 10" : null;
  const grader = m[1] ?? "";
  const n = Number(m[2]);

  // Only PSA/BGS/CGC/SGC 10 have their own upstream price field. A bare
  // "Grade 10"/"Graded 10" is PriceCharting's own generic top tier — the same
  // field as PSA 10 (manual-only-price).
  if (n === 10) {
    if (grader === "bgs") return "BGS 10";
    if (grader === "cgc") return "CGC 10";
    if (grader === "sgc") return "SGC 10";
    return "PSA 10";
  }
  // Below 10 PriceCharting prices by NUMBER only, whoever graded it.
  if (n === 9.5) return "Grade 9.5";
  if (n === 9) return "Grade 9";
  if (n === 8 || n === 8.5) return "Grade 8";
  if (n === 7 || n === 7.5) return "Grade 7";
  return null;
}
