import { ExecArgs } from '@medusajs/framework/types';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
import {
  balances,
  isTgpayKind,
  tgpayEnvName,
  tgpayFamilyConfigFromEnv,
  TgpayError,
  type TgpayConfig,
  type TgpayKind,
} from '../modules/packs/tgpay-client';

/**
 * TGPay-platform preflight: one read-only balance call proves the base URL and
 * the key pair (and the RSA key, when one is set). Run from packages/api after
 * any key or environment change:
 *
 *   ./node_modules/.bin/medusa exec src/scripts/check-tgpay.ts            (TGPay)
 *   ./node_modules/.bin/medusa exec src/scripts/check-tgpay.ts the7pay    (The 7 Pay)
 */
export default async function checkTgpay({ container, args }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const wanted = args?.[0] ?? 'tgpay';
  if (!isTgpayKind(wanted)) {
    logger.error(
      `[tgpay-preflight] unknown gateway "${wanted}" — use tgpay or the7pay`,
    );
    return;
  }
  const kind: TgpayKind = wanted;
  const tag = `[${kind}-preflight]`;
  const env = (name: string) => tgpayEnvName(kind, name);

  let config: TgpayConfig;
  try {
    config = tgpayFamilyConfigFromEnv(kind);
  } catch (error) {
    logger.error(`${tag} CONFIG INCOMPLETE — ${(error as Error).message}`);
    return;
  }

  // LENGTH, never characters. Production TGPay keys are 8–10 characters
  // (docs/payments/tgpay-setup.md), so the 8-char "prefix" this used to log
  // was most of the key — in a DigitalOcean run log, every time the setup doc
  // told the operator to run this. The length still distinguishes a sandbox
  // key from a production one, which is all the preflight needs.
  logger.info(
    `${tag} calling balance endpoints against ${config.baseUrl} (public key: ${config.publicKey.length} chars, RSA signing ${config.rsaPrivateKey ? 'on' : 'off'})`,
  );
  try {
    const b = await balances(config);
    logger.info(
      `${tag} OK — keys accepted. Pay-in wallet ${b.currencyCode} ${b.payin}, payout wallet ${b.currencyCode} ${b.payout}`,
    );
  } catch (error) {
    if (error instanceof TgpayError) {
      logger.error(
        `${tag} REFUSED — codes=${error.codes.join(',') || 'none'} httpStatus=${error.httpStatus} msg=${error.message}`,
      );
      logger.error(
        `${tag} 401 => wrong ${env('PUBLIC_KEY')} / ${env('SECRET_KEY')} pair, or an RSA signature problem (${env('RSA_PRIVATE_KEY')} missing or not the pair of the public key saved on their API keys page). 403 "Request IP is not allowed" => our egress IP is not whitelisted on their tenant. 404 "Credit not found" => no wallet for ${env('CURRENCY')} on this tenant. 400 epoch => clock skew over 5 minutes.`,
      );
      return;
    }
    logger.error(`${tag} UNREACHABLE — ${(error as Error).message}`);
  }
}
