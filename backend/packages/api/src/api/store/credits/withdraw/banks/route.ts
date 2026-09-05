import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import {
  getSupportedBanks,
  gatewayConfigFor,
  resolveActiveGateway,
} from '../../../../../modules/packs/gateway';
import { globepayWithdrawalsEnabled } from '../../../../../modules/packs/globepay-withdrawal';

// GET /store/credits/withdraw/banks — the payout bank picker's source. Proxied
// (never called from the browser) because GetSupportedBanks carries our
// merchant code, and cached because the list changes rarely while the picker
// renders on every visit.
const CACHE_MS = 10 * 60 * 1000;
// Keyed by gateway: a switch must not serve the old gateway's bank codes.
let cache: {
  gateway: string;
  at: number;
  banks: { bankCode: string; bankName: string }[];
} | null = null;

export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const gateway = await resolveActiveGateway(req.scope);
  if (!globepayWithdrawalsEnabled()) {
    res.json({ banks: [] });
    return;
  }
  if (
    !cache ||
    cache.gateway !== gateway ||
    Date.now() - cache.at > CACHE_MS
  ) {
    const banks = await getSupportedBanks(gatewayConfigFor(gateway));
    cache = { gateway, at: Date.now(), banks };
  }
  res.json({ banks: cache.banks });
}
