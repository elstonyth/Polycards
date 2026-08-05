import { ExecArgs } from '@medusajs/framework/types';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
import {
  checkBalance,
  globepayConfigFromEnv,
  GlobePayError,
  type GlobePayConfig,
} from '../modules/packs/globepay-client';

// GlobePay365 pre-flight. §1.9 CheckBalance is read-only and side-effect free,
// yet it exercises the ENTIRE integration in one call: egress IP allowlist →
// MerchantCode → AES-256-CBC payload → RSA-SHA1 signature → their response
// decrypt. It was already the documented verification step but had no caller,
// so the only way to test a key or whitelist change was to wait for a customer
// to try paying.
//
// That gap cost a day on 2026-08-04: keys were rotated, the whitelist was
// changed, and neither could be verified until a live deposit failed — at which
// point the failure could equally have been keys, IP, or an unprovisioned
// payment channel (it was the channel). This script separates those.
//
//   medusa exec ./src/scripts/check-globepay.ts
//
// Prints the merchant balance on success. NEVER prints the keys themselves.
export default async function checkGlobePay({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);

  // Annotated, not inferred. `let config;` made this implicitly `any` (the
  // package has `strict` off, so noImplicitAny does not object), which is how
  // `config.apiBase` — a field GlobePayConfig has never had — shipped and
  // printed "against undefined" on every run. The annotation is the guard: tsc
  // now rejects the next typo here instead of the preflight quietly lying about
  // which host it tested.
  let config: GlobePayConfig;
  try {
    config = globepayConfigFromEnv();
  } catch (error) {
    // globepayConfigFromEnv throws on any missing var and deliberately has no
    // default for GLOBEPAY_API_BASE — a config gap must not silently point
    // production credentials at staging.
    logger.error(
      `[globepay-preflight] CONFIG INCOMPLETE — ${(error as Error).message}`,
    );
    return;
  }

  logger.info(
    `[globepay-preflight] calling CheckBalance as merchant ${config.merchantCode} against ${config.baseUrl}`,
  );

  try {
    const balance = await checkBalance(config);
    logger.info(
      `[globepay-preflight] OK — credentials, AES key, RSA signature and IP allowlist all accepted. Balance: ${JSON.stringify(balance)}`,
    );
  } catch (error) {
    if (error instanceof GlobePayError) {
      // Their codes discriminate the failure modes that otherwise look
      // identical from our side. An empty `codes` with a 403 is the classic
      // un-allowlisted IP: a WAF page, not a parseable API refusal.
      logger.error(
        `[globepay-preflight] REFUSED — codes=${error.codes.join(',') || 'none'} ` +
          `httpStatus=${error.httpStatus} definite=${error.definite} msg=${error.message}`,
      );
      logger.error(
        '[globepay-preflight] codes=none + 403/HTML => our egress IP is not allowlisted. ' +
          'A signature or decrypt code => the key pair does not match theirs. ' +
          'A PMT* code => credentials are fine and the account/config is the problem.',
      );
      return;
    }
    // Timeout, DNS, socket reset: never reached their application at all.
    logger.error(
      `[globepay-preflight] UNREACHABLE — ${(error as Error).message}`,
    );
  }
}
