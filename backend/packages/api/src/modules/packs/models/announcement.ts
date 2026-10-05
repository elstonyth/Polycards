import { model } from '@medusajs/framework/utils';

// One storefront announcement popup slide (spec 2026-10-06 §5): an
// admin-uploaded promo image, optional caption and tap-through link. Several
// live rows show as one swipe carousel. Fields are validated by
// validateAnnouncement (announcements.ts) before every write; the live set is
// picked by pickLiveAnnouncements. Delete is a soft delete (deleted_at), so
// the audit trail's entity_id still resolves.
export const Announcement = model.define('announcement', {
  id: model.id({ prefix: 'ann' }).primaryKey(),
  image_url: model.text(),
  title: model.text().nullable(),
  link_url: model.text().nullable(),
  active: model.boolean().default(true),
  sort: model.number().default(0),
  // Optional run window, the same datetime-local pair tasks use. null/null =
  // live from now until switched off.
  starts_at: model.dateTime().nullable(),
  ends_at: model.dateTime().nullable(),
});

export default Announcement;
