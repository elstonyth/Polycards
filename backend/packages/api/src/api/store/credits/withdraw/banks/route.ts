import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import {
  getSupportedBanks,
  gatewayConfigFor,
  resolveActiveGateway,
} from '../../../../../modules/packs/gateway';
import {
  regionalPayoutGateways,
  withdrawalsEnabled,
} from '../../../../../modules/packs/gateway-withdrawal';
import { GATEWAYS } from '../../../../../modules/packs/gateway';

// GET /store/credits/withdraw/banks — the payout bank picker's source: the
// banks the ACTIVE gateway can pay to, as canonical ids (banks.ts). Cached
// per gateway because the picker renders on every visit and the list only
// changes with a switch.
const CACHE_MS = 10 * 60 * 1000;
// Keyed by gateway: a switch must not serve the old gateway's bank codes.
let cache: {
  gateway: string;
  at: number;
  banks: { bankCode: string; bankName: string; currency: string }[];
} | null = null;

export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const active = await resolveActiveGateway(req.scope);
  // The active gateway's banks, then those of every open regional gateway
  // (Singapore banks via A3Pay), each tagged with the currency it pays in.
  // A bank both could pay goes to the active one, matching payoutGatewayFor.
  const gateways = [
    ...(withdrawalsEnabled() ? [active] : []),
    ...regionalPayoutGateways(),
  ];
  const key = gateways.join(',');
  if (gateways.length === 0) {
    res.json({ banks: [] });
    return;
  }
  if (!cache || cache.gateway !== key || Date.now() - cache.at > CACHE_MS) {
    const seen = new Set<string>();
    const banks: { bankCode: string; bankName: string; currency: string }[] =
      [];
    for (const gateway of gateways) {
      for (const bank of await getSupportedBanks(gatewayConfigFor(gateway))) {
        if (seen.has(bank.bankCode)) continue;
        seen.add(bank.bankCode);
        banks.push({ ...bank, currency: GATEWAYS[gateway].currency });
      }
    }
    cache = { gateway: key, at: Date.now(), banks };
  }
  res.json({ banks: cache.banks });
}
