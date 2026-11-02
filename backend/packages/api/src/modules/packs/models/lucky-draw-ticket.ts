import { model } from '@medusajs/framework/utils';

// lucky_draw_ticket — the ticket ledger. A customer's balance is the sum of
// their deltas: task claims credit (+), a ticket pack spin credits (+), entering
// spends (-), a refund returns the spent tickets (+), an admin grant gives (+)
// or takes back (-) (Migration20261025120000), and a coin flip wins (+) or
// loses (-) its stake (Migration20261103100200). Tickets come only from those; a
// spin is the one way to pay for them (no route sells an amount outright).
//
// (reason, ref) is unique so a replayed claim / entry / refund / grant / flip is
// a no-op: ref is the task claim id, the entry id, '<prizeId>:<customerId>' for
// a refund (one per entrant per prize — a prize is either cancelled or
// drawn; '<eventId>:<customerId>' on a one_winner event),
// 'admin:<customerId>:<idempotency key>' for a grant, the ticket_spin id for a
// pack spin (not the open id: a batch shares one), or the round id for a coin
// flip.
export const LuckyDrawTicket = model
  .define('lucky_draw_ticket', {
    id: model.id({ prefix: 'ldtk' }).primaryKey(),
    customer_id: model.text(),
    // Negative = spent.
    delta: model.number(),
    reason: model.enum([
      'task_claim',
      'entry',
      'refund',
      'admin_grant',
      'pack_spin',
      'coin_flip',
    ]),
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
