import { tgpayWithdrawalCallback } from '../../../utils/tgpay-family-hooks';

// The 7 Pay payout server-notify — TGPay's platform, so TGPay's handler
// bound to The 7 Pay's keys and rows (src/api/utils/tgpay-family-hooks.ts).
export const POST = tgpayWithdrawalCallback('the7pay');
