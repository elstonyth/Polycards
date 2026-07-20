// Fixture for scripts/probe-notifications.mjs (storefront) — seeds one feed
// notification per template for a throwaway customer, newest two being
// vip_level_up so the probe has two unread rows to click.
//
//   NOTIF_PROBE_CUSTOMER=cus_… corepack yarn medusa exec ./src/scripts/seed-notification-probe.ts
//
// Then mark all but the two vip_level_up rows read via
// POST /store/notifications/:id/read, and the probe has its 9-row / 2-unread feed.
// Read state is one-way, so every probe run needs a fresh customer.
import { notifyFeed, type FeedTemplate } from "../modules/packs/notify-feed"

export default async function seedNotificationProbe({
  container,
}: {
  container: { resolve: (k: string) => any }
}): Promise<void> {
  const receiverId = process.env.NOTIF_PROBE_CUSTOMER
  if (!receiverId) {
    throw new Error("NOTIF_PROBE_CUSTOMER is required (a cus_… id)")
  }
  const stamp = Date.now()

  // Oldest first: the feed is ordered created_at DESC, so the two vip_level_up
  // rows written last are the ones at the top of the page.
  const rows: Array<{ template: FeedTemplate; data: Record<string, unknown> }> = [
    { template: "commission_matured", data: { frozen: true } },
    { template: "topup_credited", data: { amount_myr: 100 } },
    { template: "voucher_claimed", data: { amount_myr: 25, level: 10 } },
    { template: "reward_won", data: { title: "Holo Charizard" } },
    { template: "delivery_status", data: { status: "delivered" } },
    {
      template: "delivery_status",
      data: { status: "shipped", tracking_number: "MY123456789" },
    },
    { template: "commission_matured", data: {} },
    { template: "vip_level_up", data: { levels: [12] } },
    { template: "vip_level_up", data: { levels: [13] } },
  ]

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!
    await notifyFeed(container, {
      receiverId,
      template: row.template,
      data: row.data,
      idempotencyKey: `notif-probe-${stamp}-${i}`,
    })
    // Keep created_at strictly increasing so the DESC order is deterministic.
    await new Promise((resolve) => setTimeout(resolve, 60))
  }
  console.log(
    `[seed-notification-probe] seeded ${rows.length} feed notifications for ${receiverId}`
  )
}
