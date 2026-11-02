import { model } from '@medusajs/framework/utils';

// visitor_signal — which network and browser an account was seen on, so support
// can spot one person running several accounts (ADR 0016). A review signal only:
// nothing refuses a customer because of it. One row per (customer, ip, device),
// written with an upsert. `ip` is the visitorBucket: an IPv4 address, or an IPv6
// /64. `device_id` is '' when the storefront sent none. Rows are hard-deleted
// after 180 days and on account deletion.
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
    },
    { name: 'IDX_visitor_signal_ip', on: ['ip'] },
    {
      name: 'IDX_visitor_signal_device',
      on: ['device_id'],
      where: "device_id <> ''",
    },
    { name: 'IDX_visitor_signal_last_seen', on: ['last_seen_at'] },
  ]);

export default VisitorSignal;
