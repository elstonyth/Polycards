/**
 * The /slots catalog's bento: how one shelf's packs tile a 12-column grid.
 *
 * The first pack in the shelf's order leads: wider than the rest, and from four
 * packs up two rows tall with the others stacked beside it. It is only "first
 * in order" (the shelf is cheapest first), never a recommendation, so nothing
 * may label it as one. Every row is filled: a last row with one to three packs
 * shares the twelve columns between them instead of leaving a hole.
 */
export type BentoCell = {
  /** Columns out of twelve. */
  col: 3 | 4 | 5 | 6 | 7 | 12;
  /** Two rows tall. Only ever the lead. */
  tall: boolean;
};

const cell = (col: BentoCell['col'], tall = false): BentoCell => ({
  col,
  tall,
});

/** A row of 1–4 packs sharing the twelve columns evenly. */
const evenRow = (count: number): BentoCell[] => {
  const col = ({ 1: 12, 2: 6, 3: 4, 4: 3 } as const)[count as 1 | 2 | 3 | 4];
  return Array.from({ length: count }, () => cell(col));
};

export function bentoLayout(count: number): BentoCell[] {
  if (count <= 0) return [];
  if (count === 1) return [cell(12)];
  if (count === 2) return [cell(7), cell(5)];
  if (count === 3) return [cell(6), cell(3), cell(3)];

  // A tall lead holds two rows of six columns beside it: four packs fill them,
  // three leave the last one the whole second row.
  const cells: BentoCell[] = [cell(6, true)];
  const beside = Math.min(count - 1, 4);
  cells.push(
    ...(beside === 3
      ? [cell(3), cell(3), cell(6)]
      : [cell(3), cell(3), cell(3), cell(3)]),
  );

  // The rest run four to a row under the lead.
  let rest = count - 1 - beside;
  while (rest > 4) {
    cells.push(...evenRow(4));
    rest -= 4;
  }
  if (rest > 0) cells.push(...evenRow(rest));
  return cells;
}

/** Static class names: Tailwind only ships classes it can read in the source.
 *  From `lg`: a tablet is too narrow for twelve columns, and shows the packs
 *  three across instead. */
export const BENTO_COL: Record<BentoCell['col'], string> = {
  3: 'lg:col-span-3',
  4: 'lg:col-span-4',
  5: 'lg:col-span-5',
  6: 'lg:col-span-6',
  7: 'lg:col-span-7',
  12: 'lg:col-span-12',
};
