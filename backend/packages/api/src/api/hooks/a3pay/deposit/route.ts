import { a3payDepositCallback } from '../../../utils/a3pay-family-hooks';

// A3Pay payin callback — the A3Pay platform's handler bound to A3Pay's keys
// and rows (src/api/utils/a3pay-family-hooks.ts).
export const POST = a3payDepositCallback('a3pay');
