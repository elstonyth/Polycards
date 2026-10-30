import { model } from '@medusajs/framework/utils';

// TicketSpin — one spin of a ticket pack, the record of what was won (a ticket
// pack writes no pull). `tickets` is a snapshot, so a later ticket_prize edit
// never changes a past spin; the matching lucky_draw_ticket credit has this row's
// id as its ref.
export const TicketSpin = model
  .define('ticket_spin', {
    id: model.id({ prefix: 'tksp' }).primaryKey(),
    customer_id: model.text(),
    pack_id: model.text(), // = Pack.slug
    tickets: model.number(),
    // source and bonus_bp mean what they mean on a pull (see models/pull.ts).
    source: model.enum(['pack', 'reward', 'free', 'gift', 'bonus']),
    bonus_bp: model.number().default(0),
    // The open's stable id, as on a pull: the pack_open charge row's
    // source_transaction_id. A batch open shares one across its spins.
    open_id: model.text(),
    rolled_at: model.dateTime(),
  })
  .indexes([
    {
      name: 'IDX_ticket_spin_customer',
      on: ['customer_id'],
      where: 'deleted_at IS NULL',
    },
    {
      name: 'IDX_ticket_spin_open',
      on: ['open_id'],
      where: 'deleted_at IS NULL',
    },
  ]);

export default TicketSpin;
