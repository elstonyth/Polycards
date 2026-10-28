import { model } from '@medusajs/framework/utils';

// lucky_draw_event — one monthly Lucky Draw (spec 2026-10-24). An event is the
// window customers can enter in; its prizes (lucky_draw_prize) are drawn one by
// one at their own draw_at. Drafts are admin-only until published; a cancelled
// event refunds every entry.
export const LuckyDrawEvent = model.define('lucky_draw_event', {
  id: model.id({ prefix: 'ldev' }).primaryKey(),
  name: model.text(),
  starts_at: model.dateTime(),
  ends_at: model.dateTime(),
  status: model.enum(['draft', 'published', 'cancelled']).default('draft'),
  created_by: model.text(),
});

export default LuckyDrawEvent;
