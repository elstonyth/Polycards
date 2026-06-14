import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';

// Card art is bundled STOREFRONT assets, seeded as site-relative paths
// (/cdn/cards/<file>.webp). The storefront serves them (200); the backend — where
// the admin dashboard runs — does not. Medusa-CORE admin surfaces (the built-in
// product list, order line items, etc.) render the raw relative URL, which the
// browser then resolves against the backend origin → 404. Custom admin pages
// already rewrite these via apps/admin/src/lib/image-url.ts, but core pages don't
// use it. Redirect /cdn/cards/* to the storefront so EVERY surface loads the art.
//
// Runtime env (set RUN_TIME in .do/backend.app.yaml); hardcoded prod fallback
// because App Platform doesn't reliably pass build-time env (see backend/Dockerfile).
const STOREFRONT_URL = (
  process.env.MERCUR_STOREFRONT_URL ||
  'https://pokenic-storefront-ijfiu.ondigitalocean.app'
).replace(/\/$/, '');

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const { file } = req.params;
  res.redirect(302, `${STOREFRONT_URL}/cdn/cards/${encodeURIComponent(file)}`);
}
