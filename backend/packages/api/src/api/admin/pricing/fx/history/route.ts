import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import { PACKS_MODULE } from "../../../../../modules/packs";

// GET /admin/pricing/fx/history — last 10 FX override edits from the
// append-only admin_action_audit table.
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const packs: any = req.scope.resolve(PACKS_MODULE);
  const rows = await packs.listAdminActionAudits(
    { entity_type: "fx" },
    { order: { created_at: "DESC" }, take: 10 },
  );
  res.json({
    changes: rows.map((r: any) => ({
      at: r.created_at,
      admin_id: r.admin_id,
      before: r.before,
      after: r.after,
      reason: r.reason ?? null,
    })),
  });
}
