import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { PACKS_MODULE } from '../../../modules/packs';
import type PacksModuleService from '../../../modules/packs/service';

// GET /store/announcements — the storefront popup's live set (active, inside
// its window, carousel order). Public marketing content, no PII — same public
// stance as /store/avatar-frames. The storefront caches it 60s server-side.
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const rows = await packs.liveAnnouncements();
  res.json({
    announcements: rows.map((a) => ({
      id: a.id,
      image_url: a.image_url,
      title: a.title,
      link_url: a.link_url,
      // Part of the storefront's dismissal signature: an edit re-shows it.
      updated_at: new Date(a.updated_at).toISOString(),
    })),
  });
}
