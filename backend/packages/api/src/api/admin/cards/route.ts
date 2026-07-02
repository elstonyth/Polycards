import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import PacksModuleService from '../../../modules/packs/service';
import { PACKS_MODULE } from '../../../modules/packs';
import { createCardWorkflow } from '../../../workflows/create-card';
import { getCardStockByHandle } from '../../../modules/packs/card-stock';
import { coerceRegisterCardBody } from './validate';
import { toAdminCardDto } from '../../../modules/packs/admin-card';
import { resolveFxRate, DEFAULT_USD_MYR } from '../../../modules/packs/pricing';

// GET /admin/cards — the catalog list for the admin Gacha Cards page (auto-
// protected by Medusa admin auth). Returns every card, alphabetical by name.
// `stock` = available physical units (null = untracked/infinite); display-only,
// 0-stock cards stay everywhere (buyback fulfills them).
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const packs: PacksModuleService = req.scope.resolve(PACKS_MODULE);
  // The catalog must render even if the FX read fails — fall back to the
  // default rate (display-only) rather than 500-ing the whole page.
  const [cards, fxRate] = await Promise.all([
    packs.listCards({}, { take: 1000 }),
    resolveFxRate(packs).catch((e: unknown) => {
      (req.scope.resolve('logger') as { warn: (m: string) => void }).warn(
        `[admin/cards] FX read failed; using default USD_MYR=${DEFAULT_USD_MYR}: ` +
          (e instanceof Error ? e.message : String(e)),
      );
      return DEFAULT_USD_MYR;
    }),
  ]);
  const sorted = [...cards].sort((a, b) => a.name.localeCompare(b.name));
  const stockByHandle = await getCardStockByHandle(
    req.scope,
    sorted.map((c) => c.handle),
  );

  res.json({
    // The admin card DTO is one seam (toAdminCardDto); `stock` is list-only, so
    // it's spread on top rather than baked into the shared shape.
    cards: sorted.map((c) => ({
      ...toAdminCardDto(c, fxRate),
      stock: stockByHandle.get(c.handle) ?? null,
    })),
  });
}

// POST /admin/cards — register an EXISTING inventory product as a gacha card
// (inventory-first: the item must be in the catalog already; body carries only
// product_id + the gacha facts). Uniqueness is enforced in the workflow.
export async function POST(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const input = coerceRegisterCardBody(
    (req.body ?? {}) as Record<string, unknown>,
  );

  const { result } = await createCardWorkflow(req.scope).run({ input });
  res.status(201).json({ card: result });
}
