import { ExecArgs } from '@medusajs/framework/types';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
import {
  balances,
  tgpayConfigFromEnv,
  TgpayError,
  type TgpayConfig,
} from '../modules/packs/tgpay-client';

/**
 * TGPay preflight: one read-only balance call proves the base URL and the
 * key pair. Run with `./node_modules/.bin/medusa exec src/scripts/check-tgpay.ts`
 * from packages/api after any key or environment change.
 */
export default async function checkTgpay({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);

  let config: TgpayConfig;
  try {
    config = tgpayConfigFromEnv();
  } catch (error) {
    logger.error(
      `[tgpay-preflight] CONFIG INCOMPLETE — ${(error as Error).message}`,
    );
    return;
  }

  logger.info(
    `[tgpay-preflight] calling balance endpoints against ${config.baseUrl} as ${config.publicKey.slice(0, 8)}…`,
  );
  try {
    const b = await balances(config);
    logger.info(
      `[tgpay-preflight] OK — keys accepted. Pay-in wallet ${b.currencyCode} ${b.payin}, payout wallet ${b.currencyCode} ${b.payout}`,
    );
  } catch (error) {
    if (error instanceof TgpayError) {
      logger.error(
        `[tgpay-preflight] REFUSED — codes=${error.codes.join(',') || 'none'} httpStatus=${error.httpStatus} msg=${error.message}`,
      );
      logger.error(
        '[tgpay-preflight] 401 => wrong TGPAY_PUBLIC_KEY / TGPAY_SECRET_KEY pair. 404 "Credit not found" => no wallet for TGPAY_CURRENCY on this tenant. 400 epoch => clock skew over 5 minutes.',
      );
      return;
    }
    logger.error(`[tgpay-preflight] UNREACHABLE — ${(error as Error).message}`);
  }
}
