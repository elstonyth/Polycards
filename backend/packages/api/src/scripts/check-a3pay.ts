import { ExecArgs } from '@medusajs/framework/types';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
import {
  a3payConfigFromEnv,
  checkAccBalance,
  getSupportedBankList,
  type A3payConfig,
} from '../modules/packs/a3pay-client';
import syncPaymentFxJob from '../jobs/sync-payment-fx';

/**
 * A3Pay (SGD) preflight. Run from packages/api after A3Pay has registered our
 * public key and whitelisted the egress IPs:
 *
 *   ./node_modules/.bin/medusa exec src/scripts/check-a3pay.ts
 *
 * 1. Refreshes the SGD->MYR feed rate (the same job that runs every 6h), so
 *    SGD payments are not paused waiting for the first tick.
 * 2. CheckAccBalance — one signed, read-only call. Success proves the base
 *    URL, our private key (they verified our signature), their AES key, the
 *    MID and the IP whitelist all at once.
 * 3. GetSupportedBankList — their live payout bank codes, to compare with
 *    SG_BANKS in banks.ts.
 *
 * Never prints a key.
 */
export default async function checkA3pay({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);

  await syncPaymentFxJob(container);

  let config: A3payConfig;
  try {
    config = a3payConfigFromEnv();
  } catch (error) {
    logger.error(`[check-a3pay] ${(error as Error).message}`);
    return;
  }
  logger.info(
    `[check-a3pay] base ${config.baseUrl}, MID ${config.merchantCode}, currency ${config.currencyCode}`,
  );

  try {
    const b = await checkAccBalance(config);
    logger.info(
      `[check-a3pay] CheckAccBalance OK — current ${b.currCode} ${b.currentBalanceAmount}, available ${b.availableBalanceAmount}`,
    );
  } catch (error) {
    logger.error(
      `[check-a3pay] CheckAccBalance FAILED: ${(error as Error).message}`,
    );
  }

  try {
    const banks = await getSupportedBankList(config);
    logger.info(
      `[check-a3pay] ${banks.length} payout banks: ${banks.map((b) => b.bankCode).join(', ')}`,
    );
  } catch (error) {
    logger.error(
      `[check-a3pay] GetSupportedBankList FAILED: ${(error as Error).message}`,
    );
  }
}
