import { model } from '@medusajs/framework/utils';

// lucky_draw_event — one Lucky Draw (spec 2026-10-24). An event is the window
// customers can enter in. Under draw_mode 'per_prize' its prizes
// (lucky_draw_prize) are drawn one by one at their own draw_at. Under
// 'one_winner' (spec 2026-10-30) tickets go on the event itself and, at ends_at,
// one customer wins every prize. Drafts are admin-only until published; a
// cancelled event refunds every entry.
//
// seed_nonce / seed_hash are a one_winner event's fairness commitment, under the
// same rule as lucky_draw_prize: the row never holds the seed, which is first
// written at the draw, into lucky_draw_event_result. Null on a per_prize event.
export const LuckyDrawEvent = model.define('lucky_draw_event', {
  id: model.id({ prefix: 'ldev' }).primaryKey(),
  name: model.text(),
  starts_at: model.dateTime(),
  ends_at: model.dateTime(),
  status: model.enum(['draft', 'published', 'cancelled']).default('draft'),
  created_by: model.text(),
  // The default keeps rows older than Migration20261030110000 on the old rule;
  // new events are created as one_winner by saveLuckyDrawEvent.
  draw_mode: model.enum(['per_prize', 'one_winner']).default('per_prize'),
  seed_nonce: model.text().nullable(),
  seed_hash: model.text().nullable(),
});

export default LuckyDrawEvent;
