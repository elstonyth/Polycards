import { a3payDepositCallback } from '../../../utils/a3pay-family-hooks';

// GlobePay365 payin callback — the A3Pay platform's handler bound to GlobePay365's keys
// and rows (src/api/utils/a3pay-family-hooks.ts).
export const POST = a3payDepositCallback('gp365');
