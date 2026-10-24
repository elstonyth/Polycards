import { model } from '@medusajs/framework/utils';

// lucky_draw_ticket — the ticket ledger. A customer's balance is the sum of
// their deltas: task claims credit (+), entering spends (-), a refund returns
// the spent tickets (+), and an admin grant gives (+) or takes back (-)
// (Migration20261025120000). Tickets come only from task claims, refunds and
// admin grants; no route sells them.
//
// (reason, ref) is unique so a replayed claim / entry / refund / grant is a
// no-op: ref is the task claim id, the entry id, '<prizeId>:<customerId>' for
// a refund (one per entrant per prize — a prize is either cancelled or
// drawn), or 'admin:<customerId>:<idempotency key>' for a grant.
export const LuckyDrawTicket = model
  .define('lucky_draw_ticket', {
    id: model.id({ prefix: 'ldtk' }).primaryKey(),
    customer_id: model.text(),
    // Negative = spent.
    delta: model.number(),
    reason: model.enum(['task_claim', 'entry', 'refund', 'admin_grant']),
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
