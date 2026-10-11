// Operator credit forms default a GRANT to spend-only bonus credit (operator
// rule 2026-10-11) and a DEDUCTION to withdrawable credit, so clawing back
// withdrawable credit never silently takes bonus instead. An explicit
// tick / untick (`choice`) wins either way; null = the operator has not
// touched the box.
export const isBonusGrant = (
  choice: boolean | null,
  amountText: string,
): boolean => choice ?? !(Number(amountText.trim()) < 0);

/** useAdjustCredits variables for one operator adjustment. */
export const adjustCreditVars = (
  id: string,
  amount: number,
  note: string,
  bonus: boolean,
) => ({ id, amount, note, kind: bonus ? ('bonus' as const) : undefined });
