import { GATEWAYS, gatewayUrls } from '../modules/packs/gateway';
import { ExecArgs } from '@medusajs/framework/types';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
import {
  createPayout,
  isTgpayKind,
  queryPayout,
  tgpayEnvName,
  tgpayFamilyConfigFromEnv,
  tgpayIsSandbox,
  TgpayError,
} from '../modules/packs/tgpay-client';
import { TGPAY_SANDBOX_BANK } from '../modules/packs/banks';

/**
 * SANDBOX-ONLY payout probe: submits one payout at the gateway's floor to the
 * platform's dummy bank outside our ledger (no gateway_withdrawal row — the
 * callback will log "UNKNOWN payout" and change nothing). Proves the wire
 * format, the RSA signature when one is configured, the payout wallet funding,
 * and the callback delivery. Refuses to run against any non-sandbox base URL.
 *
 *   ./node_modules/.bin/medusa exec src/scripts/tgpay-payout-probe.ts            (TGPay)
 *   ./node_modules/.bin/medusa exec src/scripts/tgpay-payout-probe.ts the7pay    (The 7 Pay)
 */
export default async function tgpayPayoutProbe({ container, args }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const kind = args?.[0] ?? 'tgpay';
  if (!isTgpayKind(kind)) {
    logger.error(`[tgpay-probe] unknown gateway "${kind}" — use tgpay or the7pay`);
    return;
  }
  const tag = `[${kind}-probe]`;
  const config = tgpayFamilyConfigFromEnv(kind);
  if (!tgpayIsSandbox(config)) {
    logger.error(
      `${tag} refusing: ${tgpayEnvName(kind, 'API_BASE')} is not a sandbox host`,
    );
    return;
  }
  const notifyUrl = gatewayUrls(kind).withdrawNotifyUrl;
  if (!notifyUrl) {
    logger.error(`${tag} PAYMENT_CALLBACK_BASE unset — no notify URL`);
    return;
  }
  const merchantRefNum = `PROBE-${Date.now()}`;
  try {
    const r = await createPayout(
      {
        merchantRefNum,
        amount: GATEWAYS[kind].limits.withdrawalMin,
        email: 'probe@polycards.test',
        userName: 'Michael Yap',
        bankAccNumber: '543478924652',
        bankCode: TGPAY_SANDBOX_BANK.codes.tgpay!.code,
        bankName: TGPAY_SANDBOX_BANK.codes.tgpay!.name,
        notifyUrl,
      },
      config,
    );
    logger.info(
      `${tag} payout ACCEPTED ref=${merchantRefNum} transactionRefNum=${r.transactionRefNum}`,
    );
    const q = await queryPayout(merchantRefNum, config);
    logger.info(`${tag} query: ${JSON.stringify(q)}`);
  } catch (error) {
    if (error instanceof TgpayError) {
      logger.error(
        `${tag} REFUSED httpStatus=${error.httpStatus} definite=${error.definite} msg=${error.message}`,
      );
      return;
    }
    throw error;
  }
}
