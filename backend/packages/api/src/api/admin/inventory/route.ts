import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { loadInventoryRows } from '../../../modules/packs/inventory-view';

// GET /admin/inventory — the Inventory list (POLYCARD-BACK §3.3). Admin-only
// by inheritance: no middlewares.ts matcher claims this path, so it takes
// Medusa's default /admin/* auth.
//
// UNPAGED by design: on_hand/in_vault/requested/shipped/cost are computed
// AFTER the product page loads, so sorting on them can only happen client-side
// (the rule admin/cards/route.ts already follows).
//
// ?q= is Medusa's own FilterableProductProps.q — a free-text ILIKE over the
// product's searchable fields (title, subtitle, description) AND its variants'
// (title, sku, barcode, ean, upc). That covers §3.3's "search by name/SKU":
// the card mirror keeps Card.name === Product.title in both directions
// (workflows/steps/create-card.ts:146 reads the title into the card,
// update-card.ts:274 writes the card's name back onto the product).
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const rawQ = req.query.q;
  const q =
    typeof rawQ === 'string' && rawQ.trim() !== ''
      ? rawQ.trim().slice(0, 100)
      : undefined;
  const rows = await loadInventoryRows(req.scope, { q });
  res.json({ rows });
}
