import { model } from '@medusajs/framework/utils';

// site_settings — singleton for storefront presentation globals, admin-editable.
// One row; the service reads the first row and falls back to defaults when
// absent. Kept separate from rewards_settings: this is display chrome, not
// reward-engine config.
export const SiteSettings = model.define('site_settings', {
  id: model.id().primaryKey(),
  // URL of the slab-frame overlay the storefront layers over every card photo
  // (uploaded via /admin/media). null → storefront uses its bundled default
  // (/images/slab-frame.webp).
  slab_frame_url: model.text().nullable(),
  // Avatar-frame catalog keyed by milestone level ("10".."100") → uploaded
  // image URL (via /admin/media kind 'avatar-frame'). null → none configured.
  avatar_frames: model.json().nullable(),
  // Active payment gateway id (plan 130 §runtime switch). NULL = fall back
  // to the PAYMENT_GATEWAY env (then GlobePay). Validated against GATEWAYS
  // in gateway.ts on write; read into a process cache, never per request.
  payment_gateway: model.text().nullable(),
});

export default SiteSettings;
