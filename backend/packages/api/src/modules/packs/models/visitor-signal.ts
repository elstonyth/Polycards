import { model } from '@medusajs/framework/utils';

// visitor_signal — which network and browser an account was seen on, so support
// can spot one person running several accounts (ADR 0016). A review signal only:
// nothing refuses a customer because of it. One row per (customer, ip, device),
// written with an upsert. `ip` is the visitorBucket: an IPv4 address, or an IPv6
// /64, or 'unsigned' for a request the storefront did not sign (a direct API call
// or a script). `device_id` is '' when none was sent. Rows are hard-deleted after
// 180 days and on account deletion.
export const VisitorSignal = model
  .define('visitor_signal', {
    id: model.id({ prefix: 'vsig' }).primaryKey(),
    customer_id: model.text(),
    ip: model.text(),
    device_id: model.text().default(''),
    first_seen_at: model.dateTime(),
    last_seen_at: model.dateTime(),
    hits: model.number().default(1),
  })
  .indexes([
    {
      name: 'UQ_visitor_signal_customer_ip_device',
      on: ['customer_id', 'ip', 'device_id'],
      unique: true,
      // Rows are hard-deleted, and the upsert's ON CONFLICT needs it non-partial.
      where: null as unknown as string,
    },
    {
      name: 'IDX_visitor_signal_ip',
      on: ['ip'],
      where: null as unknown as string,
    },
    {
      name: 'IDX_visitor_signal_device',
      on: ['device_id'],
      where: "device_id <> ''",
    },
    {
      name: 'IDX_visitor_signal_last_seen',
      on: ['last_seen_at'],
      where: null as unknown as string,
    },
  ]);

export default VisitorSignal;
