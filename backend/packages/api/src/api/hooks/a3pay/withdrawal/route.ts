import { a3payWithdrawalCallback } from '../../../utils/a3pay-family-hooks';

// A3Pay payout callback — the A3Pay platform's handler bound to A3Pay's keys
// and rows (src/api/utils/a3pay-family-hooks.ts).
export const POST = a3payWithdrawalCallback('a3pay');
