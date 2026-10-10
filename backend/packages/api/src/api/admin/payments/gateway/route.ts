import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import {
  ContainerRegistrationKeys,
  MedusaError,
} from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../modules/packs';
import { gatewayEnv } from '../../../../modules/packs/gateway-env';
import type PacksModuleService from '../../../../modules/packs/service';
import {
  GATEWAYS,
  GATEWAY_IDS,
  checkBalance,
  gatewayConfigFor,
  gatewayUrls,
  isPaymentGateway,
  paymentGateway,
  resolveActiveGateway,
  setActiveGateway,
  type PaymentGateway,
} from '../../../../modules/packs/gateway';
import {
  isTgpayKind,
  tgpayCallbackIpVerdict,
  tgpayEnvName,
} from '../../../../modules/packs/tgpay-client';
import { reqReason } from '../../rewards-settings/validate';

// GET/POST /admin/payments/gateway — the operator's switch for which payment
// gateway the storefront pays through (plan 130 §runtime switch). Only a
// gateway whose credentials are present in this environment can be chosen;
// the choice is persisted on site_settings, audited, and takes effect on this
// instance at once (other instances within ACTIVE_GATEWAY_TTL_MS).

function describe() {
  const env = process.env;
  return {
    active: paymentGateway(),
    gateways: GATEWAY_IDS.map((id) => ({
      id,
      label: GATEWAYS[id].label,
      configured: GATEWAYS[id].configured(env),
    })),
    env_default: isPaymentGateway(env.PAYMENT_GATEWAY)
      ? env.PAYMENT_GATEWAY
      : 'tgpay',
  };
}

/**
 * Will the gateway actually serve us right now? Filled-in settings are not
 * enough: on 2026-10-09 The 7 Pay had valid keys but answered every call with
 * "Request IP is not allowed for this tenant" until it whitelisted our egress,
 * so a switch then would have failed every top-up. One read-only wallet call
 * proves the base URL, the keys, the RSA signature and the IP whitelist from
 * THIS server. Problems block the switch unless the operator forces it;
 * warnings are reported but do not block.
 */
async function preflight(
  id: PaymentGateway,
  withdrawalsOn: boolean,
): Promise<{ problems: string[]; warnings: string[] }> {
  const { label } = GATEWAYS[id];
  const problems: string[] = [];
  const warnings: string[] = [];
  try {
    const balance = await checkBalance(gatewayConfigFor(id));
    warnings.push(...(balance.notes ?? []));
    if (withdrawalsOn && balance.availableBalance <= 0) {
      warnings.push(
        `${label} payout wallet is ${balance.currencyCode} ${balance.availableBalance.toFixed(2)} — withdrawals will be refused (and refunded) until it is funded.`,
      );
    }
  } catch (error) {
    problems.push(
      `${label} did not accept a test call from our server: ${(error as Error).message}`,
    );
  }
  // Outside the sandbox the TGPay-platform hooks refuse every callback while
  // the source allowlist is unset; payments would then settle only through
  // the one-minute requery sweep.
  if (isTgpayKind(id)) {
    const verdict = tgpayCallbackIpVerdict('', process.env, id);
    if (
      !verdict.allowed &&
      (verdict.reason === 'unset-in-production' ||
        verdict.reason === 'unparseable')
    ) {
      problems.push(
        `${tgpayEnvName(id, 'CALLBACK_IPS')} is ${verdict.reason === 'unparseable' ? 'not a valid IP list' : 'not set'} — ${label}'s payment callbacks would be refused, so top-ups and payouts would settle only through the one-minute requery.`,
      );
    }
  }
  return { problems, warnings };
}

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  await resolveActiveGateway(req.scope);
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const { payment_gateway } = await packs.siteSettings();
  res.json({ ...describe(), setting: payment_gateway });
}

export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const adminId = req.auth_context.actor_id;
  const reason = reqReason(req.body);
  const body = req.body as { gateway?: unknown; force?: unknown } | null;
  const wanted = body?.gateway;
  const force = body?.force === true;
  if (!isPaymentGateway(wanted)) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `gateway must be one of ${GATEWAY_IDS.join(', ')}.`,
    );
  }
  if (!GATEWAYS[wanted].configured(process.env)) {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      `${GATEWAYS[wanted].label} is not configured in this environment — set its credentials first.`,
    );
  }
  // configured() reads one key. The switch needs the whole config — base URL,
  // public key, a readable RSA key — or every top-up after the click fails.
  // The message names the missing variable, never a value.
  try {
    gatewayConfigFor(wanted);
  } catch (error) {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      `${GATEWAYS[wanted].label} is not fully configured in this environment — ${(error as Error).message}`,
    );
  }
  // Credentials alone are not enough: the gateway must be able to call us
  // back, or every payment would sit unsettled until the sweep. Without
  // PAYMENT_CALLBACK_BASE every notify URL is empty (gatewayUrls), so a
  // deploy that never set it cannot switch gateways by accident.
  const urls = gatewayUrls(wanted);
  const withdrawalsOn = gatewayEnv('GATEWAY_WITHDRAWALS_ENABLED') === 'true';
  if (
    !urls.notifyUrl ||
    (withdrawalsOn &&
      (!urls.withdrawNotifyUrl ||
        (urls.hasPayoutVerify && !urls.payoutVerifyUrl)))
  ) {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      `${GATEWAYS[wanted].label} has no callback URL in this environment — set PAYMENT_CALLBACK_BASE (or notify URLs ending in ${GATEWAYS[wanted].hooks.deposit}) first.`,
    );
  }

  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER);
  const { problems, warnings } = await preflight(wanted, withdrawalsOn);
  res.setHeader('Cache-Control', 'no-store');
  if (problems.length > 0 && !force) {
    // Answered here rather than thrown: the body carries the problem list and
    // the "you may force this" flag the admin page turns into a confirm.
    res.status(422).json({
      type: 'gateway_preflight_failed',
      message: problems.join(' '),
      problems,
      warnings,
      can_force: true,
    });
    return;
  }

  // A forced switch records what it overrode in the audit reason (the column
  // takes the same 500 characters the reason validator allows).
  const auditReason = (
    problems.length > 0
      ? `${reason} [switched despite: ${problems.join(' ')}]`
      : reason
  ).slice(0, 500);
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  await packs.editPaymentGateway({
    gateway: wanted,
    adminId,
    reason: auditReason,
  });
  // This instance flips now; the others re-read within the TTL.
  setActiveGateway(wanted);
  logger.warn(
    `[payments] admin ${adminId} switched the active payment gateway to ${wanted}${problems.length > 0 ? ' (FORCED past the live check)' : ''} — ${auditReason}`,
  );

  res.json({ ...describe(), setting: wanted, warnings });
}
