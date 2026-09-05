import { ExecArgs } from '@medusajs/framework/types';
import gatewayAuditJob from '../jobs/gateway-audit';

/** Run the gateway audit sweep once, outside its hourly schedule. */
export default async function runGatewayAudit({ container }: ExecArgs) {
  await gatewayAuditJob(container);
}
