import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import { MedusaError } from "@medusajs/framework/utils";
import { PACKS_MODULE } from "../../../../modules/packs";
import { effectiveRate, DEFAULT_USD_MYR } from "../../../../modules/packs/pricing";
import { reqReason } from "../../rewards-settings/validate";

type FxRateRow = {
  id: string;
  rate: number;
  source: string;
  fetched_at: string | null;
  manual_override: boolean;
  manual_rate: number | null;
};

async function loadRow(
  scope: AuthenticatedMedusaRequest["scope"],
): Promise<{ packs: any; row: FxRateRow | null }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const packs: any = scope.resolve(PACKS_MODULE);
  const [row] = await packs.listFxRates({ pair: "USD_MYR" }, { take: 1 });
  return { packs, row: row ?? null };
}

// GET /admin/pricing/fx — current USD_MYR rate breakdown + the effective
// rate (manual override if set, else the last-fetched rate, else the 4.7
// fallback).
export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse): Promise<void> {
  const { row } = await loadRow(req.scope);
  res.json({
    rate: row ? Number(row.rate) : DEFAULT_USD_MYR,
    source: row?.source ?? "fallback",
    fetched_at: row?.fetched_at ?? null,
    manual_override: row?.manual_override ?? false,
    manual_rate: row?.manual_rate != null ? Number(row.manual_rate) : null,
    effective: effectiveRate(row),
  });
}

type Body = {
  manual_override?: unknown;
  manual_rate?: unknown;
  reason?: unknown;
};

const requireBoolean = (value: unknown, field: string): boolean => {
  if (typeof value !== "boolean") {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, `'${field}' must be a boolean.`);
  }
  return value;
};

const requirePositiveNumberOrNull = (value: unknown, field: string): number | null => {
  if (value === null || value === undefined) return null;
  const n = typeof value === "string" ? Number(value) : value;
  // Upper bound: a USD->MYR rate realistically lives in ~1-20; cap generously
  // at 1000 so a fat-fingered or hostile value can't set an absurd global
  // multiplier across every displayed price.
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0 || n > 1000) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `'${field}' must be a positive number no greater than 1000, or null.`,
    );
  }
  return n;
};

// POST /admin/pricing/fx — manual-override upsert of the single USD_MYR row.
// Requires a reason and delegates to editFxOverride, which writes the FX
// upsert and the admin_action_audit row in one transaction.
export async function POST(req: AuthenticatedMedusaRequest, res: MedusaResponse): Promise<void> {
  const body = req.body as Body;
  const manual_override = requireBoolean(body.manual_override, "manual_override");
  const manual_rate = requirePositiveNumberOrNull(body.manual_rate, "manual_rate");
  if (manual_override && manual_rate == null) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "'manual_rate' is required when 'manual_override' is true.",
    );
  }
  const reason = reqReason(req.body);
  const adminId = req.auth_context.actor_id;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const packs: any = req.scope.resolve(PACKS_MODULE);
  res.json(
    await packs.editFxOverride({
      manualOverride: manual_override,
      manualRate: manual_rate,
      adminId,
      reason,
    }),
  );
}
