import { model } from '@medusajs/framework/utils';

// Per-customer read-state for in-app feed notifications. The base Medusa
// Notification Module stores no read_at and exposes no update path, so read
// state lives in this packs side table, keyed by (notification_id, customer_id).
const NotificationRead = model
  .define('notification_read', {
    id: model.id().primaryKey(),
    notification_id: model.text(), // the noti_-prefixed Notification id
    customer_id: model.text(), // the reader (owner-scoped)
    read_at: model.dateTime().nullable(),
  })
  .indexes([
    {
      on: ['notification_id', 'customer_id'],
      unique: true,
      where: 'deleted_at IS NULL',
    },
  ]);

export default NotificationRead;
