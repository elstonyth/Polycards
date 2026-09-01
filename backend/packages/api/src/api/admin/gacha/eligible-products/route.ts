import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { Modules } from '@medusajs/framework/utils';
import PacksModuleService from '../../../../modules/packs/service';
import { PACKS_MODULE } from '../../../../modules/packs';
import { toOptionalMoney } from '../../../../modules/packs/money';
import { pageAll } from '../../../utils/page-all';

// GET /admin/gacha/eligible-products — inventory products that can be registered
// as gacha cards (i.e. catalog products whose handle is not already a Card).
// The "Add card" picker in the admin loads this list; the item must exist in the
// product catalog FIRST (inventory-first model). Drafts are included — a draft
// registers as a pack-only card (for_sale=false).
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const packs: PacksModuleService = req.scope.resolve(PACKS_MODULE);
  const productModule = req.scope.resolve(Modules.PRODUCT);

  // Page both to exhaustion — a capped `registered` set would let already-
  // registered products reappear as eligible past the cap (409 on register).
  const [products, cards] = await Promise.all([
    pageAll((opts) => productModule.listProducts({}, opts)),
    pageAll((opts) => packs.listCards({}, opts)),
  ]);

  const registered = new Set(cards.map((c) => c.handle));

  // Gacha facts staged on product.metadata (by /admin/products/from-pricecharting
  // or a manual product edit) ride along so the register dialog can autofill
  // Set / Grade / Grader / FMV on pick instead of making the operator retype them.
  const str = (v: unknown): string | null =>
    typeof v === 'string' && v.trim() !== '' ? v : null;

  const eligible = products
    .filter((p) => p.handle && !registered.has(p.handle))
    .sort((a, b) => a.title.localeCompare(b.title))
    .map((p) => {
      const meta = (p.metadata ?? {}) as Record<string, unknown>;
      return {
        id: p.id,
        title: p.title,
        handle: p.handle,
        thumbnail: p.thumbnail ?? null,
        status: p.status,
        set: str(meta.set),
        grade: str(meta.grade),
        grader: str(meta.grader),
        fmv: toOptionalMoney(meta.fmv),
        pc_product_id: str(meta.pc_product_id),
        pc_grade: str(meta.pc_grade),
      };
    });

  res.json({ products: eligible });
}
