import { ExecArgs } from '@medusajs/framework/types';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
import {
  A3PAY_FAMILY,
  A3PAY_NOT_FOUND,
  A3payError,
  a3payFamilyConfigFromEnv,
  checkAccBalance,
  getPayinDetail,
  getPayoutDetail,
  getSupportedBankList,
  type A3payConfig,
  type A3payKind,
} from '../modules/packs/a3pay-client';
import { isOwnPublicKey } from '../modules/packs/a3pay';
import syncPaymentFxJob from '../jobs/sync-payment-fx';
import { banksFor, gatewayBankCode } from '../modules/packs/banks';

/**
 * Preflight for a tenant of the A3Pay platform — A3Pay (SGD, the default) or
 * GlobePay365 (USDT). Run from packages/api after the gateway has registered
 * our public key and whitelisted the egress IPs:
 *
 *   ./node_modules/.bin/medusa exec src/scripts/check-a3pay.ts [a3pay|gp365]
 *
 * 1. Refreshes the feed rates (the same job that runs hourly), so the rail
 *    is not paused waiting for the first tick.
 * 2. CheckAccBalance — one read-only call. Success proves the base URL, the
 *    AES key, the MID and the IP whitelist. On A3Pay NOT our private key: it
 *    ignores the signature on read calls (a3pay-client.ts), so a bad
 *    A3PAY_MERCHANT_PRIVATE_KEY only shows on the first SubmitPayout.
 *    GlobePay365 answered reads 403 until our public key was registered
 *    (staging, 2026-10-14), so there it does cover the key.
 * 3. GetSupportedBankList — their live payout bank codes; every code our
 *    picker offers (SG_BANKS / USDT_WALLETS in banks.ts) must be among them,
 *    and the balance must be in the tenant's own currency.
 * 4. GetPayinDetail / GetPayoutDetail for a reference that cannot exist: the
 *    answer must read as not-found (A3PAY_NOT_FOUND), because that answer is
 *    what lets the sweeps write off a stale deposit or refund a payout.
 * 5. (Checked first, offline) their public key must not be our own
 *    (isOwnPublicKey): no call here exercises it, and that mix-up refused
 *    every GlobePay365 callback until 2026-10-26.
 *
 * Never prints a key. Not fully read-only: step 1 writes the FX row of the
 * database it runs against.
 */
export default async function checkA3pay({ container, args }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const kind = (args?.[0] ?? 'a3pay') as A3payKind;
  if (!Object.hasOwn(A3PAY_FAMILY, kind)) {
    logger.error(`[check-a3pay] unknown gateway "${kind}" (a3pay | gp365)`);
    return;
  }
  const tag = `[check-${kind}]`;

  await syncPaymentFxJob(container);

  let config: A3payConfig;
  try {
    config = a3payFamilyConfigFromEnv(kind);
  } catch (error) {
    logger.error(`${tag} ${(error as Error).message}`);
    return;
  }
  logger.info(
    `${tag} base ${config.baseUrl}, MID ${config.merchantCode}, currency ${config.currencyCode}`,
  );
  // No call below uses their key — only callbacks do — so this is the one
  // place a wrong one shows before the first real payment.
  const { envPrefix, label } = A3PAY_FAMILY[kind];
  if (isOwnPublicKey(config.publicKey, config.privateKey)) {
    logger.error(
      `${tag} ${envPrefix}_PUBLIC_KEY is OUR public key (the public half of ${envPrefix}_MERCHANT_PRIVATE_KEY), not ${label}'s — every callback and payout verification will be refused`,
    );
  }

  try {
    const b = await checkAccBalance(config);
    logger.info(
      `${tag} CheckAccBalance OK — current ${b.currCode} ${b.currentBalanceAmount}, available ${b.availableBalanceAmount}`,
    );
    // A multi-currency MID answers in its own currency: the float check
    // would read the wrong balance.
    if (b.currCode.toUpperCase() !== config.currencyCode.toUpperCase()) {
      logger.error(
        `${tag} balance is in ${b.currCode}, not ${config.currencyCode} — wrong MID or CurrCode`,
      );
    }
  } catch (error) {
    logger.error(`${tag} CheckAccBalance FAILED: ${(error as Error).message}`);
  }

  try {
    const banks = await getSupportedBankList(config);
    logger.info(
      `${tag} ${banks.length} payout banks: ${banks.map((b) => b.bankCode).join(', ')}`,
    );
    // Every code our picker offers must be one they pay to, or that payout
    // fails at SubmitPayout after the debit.
    const live = new Set(banks.map((b) => b.bankCode.toUpperCase()));
    const missing = banksFor(kind)
      .map((b) => gatewayBankCode(b.bankCode, kind)?.code)
      .filter(
        (code): code is string => !!code && !live.has(code.toUpperCase()),
      );
    (missing.length ? logger.error : logger.info).call(
      logger,
      missing.length
        ? `${tag} our picker offers codes they do NOT list: ${missing.join(', ')}`
        : `${tag} every payout code our picker offers is in their list (OK)`,
    );
  } catch (error) {
    logger.error(
      `${tag} GetSupportedBankList FAILED: ${(error as Error).message}`,
    );
  }

  const probe = `PROBE-NOTFOUND-${Date.now()}`;
  for (const [name, read] of [
    ['GetPayinDetail', getPayinDetail],
    ['GetPayoutDetail', getPayoutDetail],
  ] as const) {
    try {
      await read(probe, config);
      logger.error(`${tag} ${name} FOUND ${probe} — investigate`);
    } catch (error) {
      const notFound =
        error instanceof A3payError && error.has(A3PAY_NOT_FOUND);
      (notFound ? logger.info : logger.error).call(
        logger,
        `${tag} ${name} unknown ref: ${notFound ? 'reads as not-found (OK)' : 'does NOT read as not-found'} — ${(error as Error).message}`,
      );
    }
  }
}
