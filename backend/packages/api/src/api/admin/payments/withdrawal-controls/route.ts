import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { PACKS_MODULE } from '../../../../modules/packs';
import type PacksModuleService from '../../../../modules/packs/service';
import {
  resolveActiveGateway,
  type PaymentGateway,
} from '../../../../modules/packs/gateway';
import { withdrawalsEnabled } from '../../../../modules/packs/gateway-withdrawal';
import { bankSupportedBy } from '../../../../modules/packs/saved-accounts';
import {
  TNG_BANK_ID,
  TNG_MIN_FLOOR_RM,
  channelStatus,
  type ChannelControl,
  type WithdrawalControls,
} from '../../../../modules/packs/withdrawal-controls';
import { reqReason } from '../../rewards-settings/validate';
import { parseWithdrawalControlsBody } from './validate';

// GET/POST /admin/payments/withdrawal-controls — the Withdraw switch, the
// Touch 'n Go switch, their daily closed windows (Malaysia time) and the TNG
// minimum (modules/packs/withdrawal-controls.ts). POST replaces the whole set,
// audited with a reason; it takes effect on the next customer request.

function view(controls: WithdrawalControls, active: PaymentGateway) {
  const now = Date.now();
  const status = (control: ChannelControl) => {
    const s = channelStatus(control, now);
    return {
      open: s.open,
      reopens_at:
        !s.open && s.reopens_at !== null
          ? new Date(s.reopens_at).toISOString()
          : null,
    };
  };
  return {
    controls,
    status: {
      withdrawals: status(controls.withdrawals),
      tng: status(controls.tng),
    },
    // What the server config allows whatever these switches say: turning a
    // switch on here cannot open a channel the env keeps shut.
    env: {
      withdrawals: withdrawalsEnabled(process.env, active),
      tng: bankSupportedBy(TNG_BANK_ID, active),
    },
    tng_min_floor_rm: TNG_MIN_FLOOR_RM,
  };
}

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const controls = await packs.withdrawalControls();
  res.json(view(controls, await resolveActiveGateway(req.scope)));
}

// admin_id derives from the verified auth_context (never the body). Admin
// routes are framework-auto-protected.
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const reason = reqReason(req.body);
  const controls = parseWithdrawalControlsBody(req.body, Date.now());
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const saved = await packs.editWithdrawalControls({
    controls,
    adminId: req.auth_context.actor_id,
    reason,
  });
  res.json(view(saved, await resolveActiveGateway(req.scope)));
}
