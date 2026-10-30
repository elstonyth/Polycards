import {
  createWorkflow,
  WorkflowResponse,
} from '@medusajs/framework/workflows-sdk';
import { emitEventStep } from '@medusajs/medusa/core-flows';
import { settleVipStep, type SettleVipInput } from './steps/settle-vip';

// The VIP tail of a paid open, for a ticket spin (spec 2026-10-30 §3). Its own
// workflow, run AFTER settleTicketSpins committed: a spin has no saga to unwind,
// and a failure here (a bus outage, a failed event release cancelling the flow)
// must never read as a failed spin, so the route catches it.
export const settleVipAfterSpinWorkflow = createWorkflow(
  'settle-vip-after-spin',
  function (input: SettleVipInput) {
    settleVipStep(input);
    emitEventStep({ eventName: 'vip.spend_settled', data: input });
    return new WorkflowResponse(input);
  },
);

export default settleVipAfterSpinWorkflow;
