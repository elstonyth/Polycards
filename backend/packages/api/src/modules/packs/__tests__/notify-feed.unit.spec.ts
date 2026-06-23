// src/modules/packs/__tests__/notify-feed.unit.spec.ts
import { notifyFeed } from '../notify-feed';

it('calls createNotifications with feed channel, receiver_id + to + idempotency_key', async () => {
  const created: any[] = [];
  const fakeNotif = {
    createNotifications: async (p: any) => {
      created.push(p);
      return p;
    },
  };
  const container = { resolve: (k: string) => fakeNotif };
  await notifyFeed(container as any, {
    receiverId: 'cus_1',
    template: 'vip_level_up',
    data: { levels: [2, 3] },
    idempotencyKey: 'open_1:levelup',
  });
  expect(created).toHaveLength(1);
  expect(created[0]).toMatchObject({
    to: 'cus_1',
    receiver_id: 'cus_1',
    channel: 'feed',
    template: 'vip_level_up',
    data: { levels: [2, 3] },
    idempotency_key: 'open_1:levelup',
  });
});
