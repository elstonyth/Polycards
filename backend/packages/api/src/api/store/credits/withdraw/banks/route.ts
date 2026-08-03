import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import {
  getSupportedBanks,
  globepayConfigFromEnv,
} from '../../../../../modules/packs/globepay-client';
import { globepayWithdrawalsEnabled } from '../../../../../modules/packs/globepay-withdrawal';

// GET /store/credits/withdraw/banks — the payout bank picker's source. Proxied
// (never called from the browser) because GetSupportedBanks carries our
// merchant code, and cached because the list changes rarely while the picker
// renders on every visit.
const CACHE_MS = 10 * 60 * 1000;
let cache: { at: number; banks: { bankCode: string; bankName: string }[] } | null =
  null;

export async function GET(
  _req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  if (!globepayWithdrawalsEnabled()) {
    res.json({ banks: [] });
    return;
  }
  if (!cache || Date.now() - cache.at > CACHE_MS) {
    const banks = await getSupportedBanks(globepayConfigFromEnv());
    cache = { at: Date.now(), banks };
  }
  res.json({ banks: cache.banks });
}
