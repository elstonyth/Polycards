import {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { PACKS_MODULE } from '../../../modules/packs';
import type PacksModuleService from '../../../modules/packs/service';

// GET /store/pack-gifts — the signed-in customer's unopened gifted packs
// (spec 2026-10-07 §6), one row per pack: the vault's Packs row and the
// "Vault xN" on the pack and spin pages. customerId comes only from the
// verified token. `available` is false for a pack that cannot be opened right
// now (drafted or out of stock) — the gift waits.
//
// AUTH: bearer, matcher '/store/pack-gifts' in middlewares.ts.
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const counts = await packs.unopenedPackGiftCounts(req.auth_context.actor_id);
  const slugs = counts.map((c) => c.pack_id);
  const packRows = slugs.length
    ? await packs.listPacks({ slug: slugs }, { take: slugs.length })
    : [];
  const bySlug = new Map(packRows.map((p) => [p.slug, p]));
  res.json({
    gifts: counts.map((c) => {
      const pack = bySlug.get(c.pack_id);
      return {
        pack_id: c.pack_id,
        count: c.count,
        title: pack?.title ?? c.pack_id,
        image: pack?.image ?? null,
        price: pack ? Number(pack.price) : 0,
        available:
          !!pack && pack.status === 'active' && pack.in_stock !== false,
      };
    }),
  });
}
