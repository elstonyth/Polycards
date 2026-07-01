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
