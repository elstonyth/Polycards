import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import {
  ContainerRegistrationKeys,
  MedusaError,
} from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../modules/packs';
import type PacksModuleService from '../../../../modules/packs/service';
import {
  GATEWAYS,
  GATEWAY_IDS,
  gatewayUrls,
  isPaymentGateway,
  paymentGateway,
  resolveActiveGateway,
  setActiveGateway,
} from '../../../../modules/packs/gateway';
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
      : 'globepay',
  };
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
  const wanted = (req.body as { gateway?: unknown } | null)?.gateway;
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
  // Credentials alone are not enough: the gateway must be able to call us
  // back, or every payment would sit unsettled until the sweep. Without
  // PAYMENT_CALLBACK_BASE the explicit URLs only count when they name THIS
  // gateway's hooks (gatewayUrls), so a production deploy still carrying the
  // GlobePay URLs cannot be switched to TGPay by accident.
  const urls = gatewayUrls(wanted);
  const withdrawalsOn = process.env.GLOBEPAY_WITHDRAWALS_ENABLED === 'true';
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

  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  await packs.editPaymentGateway({ gateway: wanted, adminId, reason });
  // This instance flips now; the others re-read within the TTL.
  setActiveGateway(wanted);
  req.scope
    .resolve(ContainerRegistrationKeys.LOGGER)
    .warn(
      `[payments] admin ${adminId} switched the active payment gateway to ${wanted} — ${reason}`,
    );

  res.setHeader('Cache-Control', 'no-store');
  res.json({ ...describe(), setting: wanted });
}
