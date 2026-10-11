import { tgpayDepositCallback } from '../../../utils/tgpay-family-hooks';

// TGPay payment server-notify. The handler is shared with every gateway on
// TGPay's platform (src/api/utils/tgpay-family-hooks.ts).
export const POST = tgpayDepositCallback('tgpay');
