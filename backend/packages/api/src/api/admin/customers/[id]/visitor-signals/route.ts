import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../../modules/packs';
import type PacksModuleService from '../../../../../modules/packs/service';

// GET /admin/customers/:id/visitor-signals — other accounts seen on this player's
// browser or network (ADR 0016). A clue for support, never a refusal. Carries IP
// addresses, so it is fenced like a bank number (SECRET_READS, admin-rbac.ts) and
// throttled in middlewares.ts.
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const customers = req.scope.resolve(Modules.CUSTOMER);
  const { recorded, device, ip } = await packs.visitorSignalMatches(
    req.params.id,
  );

  const ids = [
    ...new Set([
      ...device.map((d) => d.customer_id),
      ...ip.flatMap((n) => n.customer_ids),
    ]),
  ];
  const handles = new Map(
    ids.length === 0
      ? []
      : (
          await customers.listCustomers(
            { id: ids },
            { select: ['id', 'metadata'], take: ids.length },
          )
        ).map((c) => [
          c.id,
          typeof c.metadata?.handle === 'string' ? c.metadata.handle : null,
        ]),
  );
  const player = (customerId: string) => ({
    customer_id: customerId,
    handle: handles.get(customerId) ?? null,
  });

  res.setHeader('Cache-Control', 'no-store');
  res.json({
    recorded,
    device: device.map((d) => ({
      ...player(d.customer_id),
      last_seen_at: d.last_seen_at,
    })),
    ip: ip.map((n) => ({
      ip: n.ip,
      accounts: n.accounts,
      customers: n.customer_ids.map(player),
    })),
  });
}
