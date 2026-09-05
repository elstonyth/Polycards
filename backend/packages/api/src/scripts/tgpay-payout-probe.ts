import { ExecArgs } from '@medusajs/framework/types';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
import {
  createPayout,
  queryPayout,
  tgpayConfigFromEnv,
  tgpayIsSandbox,
  TgpayError,
} from '../modules/packs/tgpay-client';
import { TGPAY_SANDBOX_BANK } from '../modules/packs/banks';

/**
 * SANDBOX-ONLY payout probe: submits one RM 50 payout to TGPay's dummy bank
 * outside our ledger (no globepay_withdrawal row — the callback will log
 * "UNKNOWN payout" and change nothing). Proves the wire format, the payout
 * wallet funding, and the callback delivery. Refuses to run against any
 * non-sandbox base URL.
 *
 *   ./node_modules/.bin/medusa exec src/scripts/tgpay-payout-probe.ts
 */
export default async function tgpayPayoutProbe({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const config = tgpayConfigFromEnv();
  if (!tgpayIsSandbox(config)) {
    logger.error('[tgpay-probe] refusing: TGPAY_API_BASE is not a sandbox host');
    return;
  }
  const notifyUrl = process.env.GLOBEPAY_WITHDRAW_NOTIFY_URL;
  if (!notifyUrl) {
    logger.error('[tgpay-probe] GLOBEPAY_WITHDRAW_NOTIFY_URL unset');
    return;
  }
  const merchantRefNum = `PROBE-${Date.now()}`;
  try {
    const r = await createPayout(
      {
        merchantRefNum,
        amount: 50,
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
      `[tgpay-probe] payout ACCEPTED ref=${merchantRefNum} transactionRefNum=${r.transactionRefNum}`,
    );
    const q = await queryPayout(merchantRefNum, config);
    logger.info(`[tgpay-probe] query: ${JSON.stringify(q)}`);
  } catch (error) {
    if (error instanceof TgpayError) {
      logger.error(
        `[tgpay-probe] REFUSED httpStatus=${error.httpStatus} definite=${error.definite} msg=${error.message}`,
      );
      return;
    }
    throw error;
  }
}
