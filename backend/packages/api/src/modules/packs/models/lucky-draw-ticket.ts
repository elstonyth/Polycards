import { model } from '@medusajs/framework/utils';

// lucky_draw_ticket — the ticket ledger. A customer's balance is the sum of
// their deltas: task claims credit (+), entering spends (-), a refund returns
// the spent tickets (+). Tickets are only ever earned from task claims and
// refunds; no route sells them.
//
// (reason, ref) is unique so a replayed claim / entry / refund is a no-op:
// ref is the task claim id, the entry id, or '<prizeId>:<customerId>' for a
// refund (one per entrant per prize — a prize is either cancelled or drawn).
export const LuckyDrawTicket = model
  .define('lucky_draw_ticket', {
    id: model.id({ prefix: 'ldtk' }).primaryKey(),
    customer_id: model.text(),
    // Negative = spent.
    delta: model.number(),
    reason: model.enum(['task_claim', 'entry', 'refund']),
    ref: model.text(),
  })
  .indexes([
    {
      name: 'IDX_lucky_draw_ticket_customer',
      on: ['customer_id'],
      where: 'deleted_at IS NULL',
    },
    {
      name: 'UQ_lucky_draw_ticket_reason_ref',
      on: ['reason', 'ref'],
      unique: true,
      where: 'deleted_at IS NULL',
    },
  ]);

export default LuckyDrawTicket;
